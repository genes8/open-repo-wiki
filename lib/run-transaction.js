'use strict';

const fs = require('node:fs');
const path = require('node:path');

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function assertNoSymlinkPath(target) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (stat && stat.isSymbolicLink()) {
      throw new Error(`transaction target contains a symlink: ${current}`);
    }
  }
}

function removeDerived(target) {
  const stat = lstatIfPresent(target);
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.unlinkSync(target);
  }
}

function safeRunId(value) {
  const runId = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) {
    throw new Error('unsafe transaction run ID');
  }
  return runId;
}

function isWithin(parent, child) {
  return child.startsWith(`${parent}${path.sep}`);
}

function createRunTransaction(targets, runIdValue) {
  const runId = safeRunId(runIdValue);
  if (!Array.isArray(targets) || !targets.length) {
    throw new Error('transaction requires at least one target');
  }

  const names = new Set();
  const entries = targets.map(target => {
    const name = String(target && target.name || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) || names.has(name)) {
      throw new Error(`invalid or duplicate transaction target name: ${name}`);
    }
    names.add(name);
    if (!target.live || !path.isAbsolute(target.live)) {
      throw new Error(`transaction target "${name}" must use an absolute live path`);
    }
    const live = path.resolve(target.live);
    if (live === path.parse(live).root) {
      throw new Error(`transaction target cannot be a filesystem root: ${live}`);
    }
    assertNoSymlinkPath(live);
    const liveStat = lstatIfPresent(live);
    if (liveStat && !liveStat.isDirectory()) {
      throw new Error(`transaction target is not a directory: ${live}`);
    }
    const parent = path.dirname(live);
    const base = path.basename(live);
    const stage = path.join(parent, `.${base}.stage-${runId}`);
    const backup = path.join(parent, `.${base}.backup-${runId}`);
    if (path.dirname(stage) !== parent || path.dirname(backup) !== parent) {
      throw new Error(`unsafe derived transaction path for ${live}`);
    }
    return {
      name,
      live,
      stage,
      backup,
      originalExisted: Boolean(liveStat),
      backupMoved: false,
      stageMoved: false,
    };
  });

  for (let left = 0; left < entries.length; left++) {
    for (let right = left + 1; right < entries.length; right++) {
      const a = entries[left].live;
      const b = entries[right].live;
      if (a === b || isWithin(a, b) || isWithin(b, a)) {
        throw new Error(`overlapping transaction targets: ${a} and ${b}`);
      }
    }
  }

  const livePaths = new Set(entries.map(entry => entry.live));
  for (const entry of entries) {
    if (livePaths.has(entry.stage) || livePaths.has(entry.backup)) {
      throw new Error(`transaction artifact overlaps a live target: ${entry.live}`);
    }
  }

  let state = 'new';

  function cleanupArtifacts() {
    for (const entry of entries) {
      removeDerived(entry.stage);
      removeDerived(entry.backup);
    }
  }

  function rollback() {
    let rollbackError = null;
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.stageMoved) {
          removeDerived(entry.live);
          entry.stageMoved = false;
        }
        if (entry.backupMoved) {
          if (!lstatIfPresent(entry.backup)) {
            throw new Error(`missing transaction backup: ${entry.backup}`);
          }
          removeDerived(entry.live);
          fs.renameSync(entry.backup, entry.live);
          entry.backupMoved = false;
        }
        removeDerived(entry.stage);
      } catch (error) {
        rollbackError ||= error;
      }
    }
    if (rollbackError) throw rollbackError;
  }

  function prepare() {
    if (state !== 'new') throw new Error(`cannot prepare transaction in state ${state}`);
    for (const entry of entries) {
      fs.mkdirSync(path.dirname(entry.live), { recursive: true });
      assertNoSymlinkPath(entry.live);
      if (lstatIfPresent(entry.stage) || lstatIfPresent(entry.backup)) {
        throw new Error(`transaction artifact already exists for ${entry.live}`);
      }
    }
    try {
      for (const entry of entries) {
        if (entry.originalExisted) {
          fs.cpSync(entry.live, entry.stage, {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
          });
        } else {
          fs.mkdirSync(entry.stage);
        }
      }
      state = 'prepared';
    } catch (error) {
      cleanupArtifacts();
      throw error;
    }
  }

  function stagePath(name) {
    const entry = entries.find(item => item.name === name);
    if (!entry) throw new Error(`unknown transaction target: ${name}`);
    if (state === 'new') throw new Error('transaction is not prepared');
    return entry.stage;
  }

  function commit() {
    if (state !== 'prepared') throw new Error(`cannot commit transaction in state ${state}`);
    try {
      for (const entry of entries) {
        const stageStat = lstatIfPresent(entry.stage);
        if (!stageStat || !stageStat.isDirectory() || stageStat.isSymbolicLink()) {
          throw new Error(`missing transaction stage: ${entry.stage}`);
        }
        assertNoSymlinkPath(entry.live);
        if (lstatIfPresent(entry.backup)) {
          throw new Error(`transaction backup already exists: ${entry.backup}`);
        }
      }
      for (const entry of entries) {
        if (lstatIfPresent(entry.live)) {
          fs.renameSync(entry.live, entry.backup);
          entry.backupMoved = true;
        }
        fs.renameSync(entry.stage, entry.live);
        entry.stageMoved = true;
      }
    } catch (error) {
      try {
        rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
      state = 'aborted';
      throw error;
    }

    state = 'committed';
    const cleanupWarnings = [];
    for (const entry of entries) {
      entry.stageMoved = false;
      entry.backupMoved = false;
      try {
        removeDerived(entry.backup);
      } catch (error) {
        cleanupWarnings.push({
          target: entry.name,
          message: error.message,
        });
      }
    }
    return { cleanupWarnings };
  }

  function abort() {
    if (state === 'committed' || state === 'aborted') return;
    if (state === 'prepared') rollback();
    state = 'aborted';
  }

  return {
    prepare,
    stagePath,
    commit,
    abort,
  };
}

module.exports = {
  createRunTransaction,
};
