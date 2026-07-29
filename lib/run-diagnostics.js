'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeManagedPath } = require('./knowledge');

function timestamp() {
  return new Date().toISOString();
}

function atomicWrite(target, content) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  fs.writeFileSync(temporary, content, { flag: 'wx' });
  try {
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function safeRunId(value) {
  const runId = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error('unsafe diagnostic run ID');
  }
  return runId;
}

function encodedPagePath(pagePath) {
  const rel = String(pagePath || '').replace(/\\/g, '/');
  if (!rel || path.isAbsolute(rel) || rel.split('/').includes('..')) {
    throw new Error(`unsafe diagnostic page path: ${pagePath}`);
  }
  const segments = rel.split('/').map((segment, index, all) => {
    const withoutExtension = index === all.length - 1
      ? segment.replace(/\.md$/i, '')
      : segment;
    const safe = encodeURIComponent(withoutExtension).replace(
      /[!'()*]/g,
      character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
    if (!safe || safe === '.' || safe === '..') {
      throw new Error(`unsafe diagnostic page path: ${pagePath}`);
    }
    return safe;
  });
  return segments.join('/');
}

function createRunDiagnostics(runsRoot, options = {}) {
  const root = path.resolve(runsRoot);
  const runId = safeRunId(options.runId);
  fs.mkdirSync(root, { recursive: true });
  const resolvedRun = safeManagedPath(root, runId);
  if (!resolvedRun) throw new Error('unsafe diagnostic run path');
  fs.mkdirSync(resolvedRun.full);
  const dir = resolvedRun.full;
  const startedAt = timestamp();
  let summary = {
    schemaVersion: 1,
    runId,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    ...(options.repo ? { repo: String(options.repo) } : {}),
    ...(options.provider ? { provider: String(options.provider) } : {}),
    ...(options.model ? { model: String(options.model) } : {}),
    flags: options.flags && typeof options.flags === 'object'
      ? { ...options.flags }
      : {},
  };

  function targetFor(relative) {
    const resolved = safeManagedPath(dir, relative);
    if (!resolved) throw new Error(`unsafe diagnostic path: ${relative}`);
    fs.mkdirSync(path.dirname(resolved.full), { recursive: true });
    return resolved.full;
  }

  function writeText(relative, text) {
    atomicWrite(targetFor(relative), String(text));
  }

  function writeJson(relative, value) {
    writeText(relative, `${JSON.stringify(value, null, 2)}\n`);
  }

  function writeSummary() {
    summary.updatedAt = timestamp();
    writeJson('run.json', summary);
  }

  function recordPlanAttempt(attempt, raw, metadata = {}) {
    const number = Number(attempt);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`invalid plan attempt: ${attempt}`);
    }
    writeText(`plan/attempt-${number}.raw.txt`, raw);
    writeJson(`plan/attempt-${number}.json`, metadata);
  }

  function acceptPlan(plan) {
    writeJson('plan/accepted.normalized.json', plan);
    const pages = Array.isArray(plan && plan.pages) ? plan.pages : [];
    summary.acceptedPlan = {
      pageCount: pages.length,
      pages: pages.map(page => ({
        path: page.path,
        title: page.title,
      })),
    };
    writeSummary();
  }

  function recordPageAttempt(pagePath, attempt, draft, metadata = {}) {
    const number = Number(attempt);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`invalid page attempt: ${attempt}`);
    }
    const encoded = encodedPagePath(pagePath);
    writeText(`pages/${encoded}/attempt-${number}.md`, draft);
    writeJson(`pages/${encoded}/attempt-${number}.json`, metadata);
  }

  function finish(status, patch = {}) {
    if (!['committed', 'aborted', 'dry-run'].includes(status)) {
      throw new Error(`invalid diagnostic run status: ${status}`);
    }
    summary = {
      ...summary,
      ...patch,
      status,
      finishedAt: timestamp(),
    };
    writeSummary();
  }

  writeSummary();

  return {
    dir,
    writeText,
    writeJson,
    recordPlanAttempt,
    acceptPlan,
    recordPageAttempt,
    finish,
  };
}

module.exports = {
  createRunDiagnostics,
  encodedPagePath,
};
