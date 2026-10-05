'use strict';
/**
 * Loader for the pre-generation wiki plan file (Qoder wiki_plan.yaml parity).
 * Zero-dependency: a strict parser for exactly the schema we accept — nested
 * maps, string scalars, lists of strings, and lists of maps with string
 * fields. Anything else (anchors, multi-line scalars, flow maps, tabs) is a
 * hard error with a line number. wiki_plan.json is accepted as an alternative.
 */
const fs = require('fs');
const path = require('path');

// Non-enumerable marker mapping each map's keys to their source line numbers,
// so schema errors raised after parsing can still carry a line number.
const KEY_LINES = Symbol('planFileKeyLines');

class PlanFileError extends Error {
  constructor(message, line) {
    super(line ? `wiki_plan.yaml line ${line}: ${message}` : `wiki_plan: ${message}`);
    this.line = line || null;
  }
}

const TEMPLATES = new Set(['', 'architecture', 'product_requirement']);

// Keys that must never be assigned into a parsed map: assigning __proto__
// would mutate the object's prototype, and constructor/prototype are reserved
// for the same reason (defense-in-depth against prototype pollution).
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeKey(key, line) {
  if (FORBIDDEN_KEYS.has(key)) throw new PlanFileError(`invalid key "${key}"`, line);
}

// Remove a trailing YAML comment from a single line without treating a '#'
// inside a single- or double-quoted scalar as a comment.
function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#') {
      if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') return line.slice(0, i);
    }
  }
  return line;
}

function stripQuotes(value, line) {
  const t = value.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    if (t[0] === '"') {
      if (t.includes('\\"')) throw new PlanFileError('escape sequences are not supported in double quotes', line);
      return t.slice(1, -1);
    }
    return t.slice(1, -1);
  }
  if (t[0] === '"' || t[0] === "'") throw new PlanFileError('unterminated quoted string', line);
  return t;
}

// Parse the YAML subset into generic {map, list, scalar} structures.
function parseYamlSubset(text) {
  const lines = [];
  String(text).split(/\r?\n/).forEach((raw, index) => {
    if (raw.includes('\t')) throw new PlanFileError('tabs are not allowed; use spaces', index + 1);
    const content = stripYamlComment(raw);
    if (!content.trim() || content.trim().startsWith('#')) return;
    lines.push({ indent: content.length - content.trimStart().length, text: content.trim(), line: index + 1 });
  });

  const parseBlock = (start, indent) => {
    // Decide map vs list from the first line at this indent.
    if (start >= lines.length || lines[start].indent !== indent) return { value: null, next: start };
    if (lines[start].text.startsWith('- ')) return parseList(start, indent);
    return parseMap(start, indent);
  };

  function parseMap(start, indent) {
    const map = {};
    const keyLines = {};
    let i = start;
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
      const match = lines[i].text.match(/^([A-Za-z0-9_][\w.-]*):\s*(.*)$/);
      if (!match) throw new PlanFileError(`expected "key: value", got "${lines[i].text}"`, lines[i].line);
      const [, key, rest] = match;
      assertSafeKey(key, lines[i].line);
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        throw new PlanFileError(`duplicate key "${key}"`, lines[i].line);
      }
      keyLines[key] = lines[i].line;
      if (rest === '') {
        const child = parseBlock(i + 1, nextIndent(i, indent));
        if (child.value === null) map[key] = null;
        else { map[key] = child.value; i = child.next - 1; }
      } else if (rest === '[]') {
        map[key] = [];
      } else if (rest === '{}') {
        map[key] = {};
      } else {
        map[key] = stripQuotes(rest, lines[i].line);
      }
      i++;
    }
    if (i < lines.length && lines[i].indent > indent && !lines[i].text.startsWith('- ')) {
      throw new PlanFileError(`unexpected deeper indentation at "${lines[i].text}"`, lines[i].line);
    }
    Object.defineProperty(map, KEY_LINES, { value: keyLines, enumerable: false });
    return { value: map, next: i };
  }

  function nextIndent(i, parentIndent) {
    if (i + 1 >= lines.length) return parentIndent + 2;
    const next = lines[i + 1];
    if (next.indent <= parentIndent) return parentIndent + 2; // empty block -> null
    return next.indent;
  }

  function parseList(start, indent) {
    const list = [];
    let i = start;
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
      const rest = lines[i].text.slice(2);
      const mapMatch = rest.match(/^([A-Za-z0-9_][\w.-]*):\s*(.*)$/);
      if (mapMatch) {
        // list item that is itself a map: first field inline, deeper fields after
        const item = {};
        const [, key, value] = mapMatch;
        assertSafeKey(key, lines[i].line);
        item[key] = value === '' ? null : value === '[]' ? [] : stripQuotes(value, lines[i].line);
        let j = i + 1;
        while (j < lines.length && lines[j].indent > indent && !lines[j].text.startsWith('- ')) {
          const m2 = lines[j].text.match(/^([A-Za-z0-9_][\w.-]*):\s*(.*)$/);
          if (!m2) throw new PlanFileError(`expected "key: value" in list item, got "${lines[j].text}"`, lines[j].line);
          const [, k2, v2] = m2;
          assertSafeKey(k2, lines[j].line);
          if (Object.prototype.hasOwnProperty.call(item, k2)) {
            throw new PlanFileError(`duplicate key "${k2}" in list item`, lines[j].line);
          }
          item[k2] = v2 === '' ? null : v2 === '[]' ? [] : stripQuotes(v2, lines[j].line);
          j++;
        }
        list.push(item);
        i = j;
      } else {
        list.push(stripQuotes(rest, lines[i].line));
        i++;
      }
    }
    return { value: list, next: i };
  }

  const root = parseMap(0, lines.length ? lines[0].indent : 0);
  if (root.next < lines.length) {
    throw new PlanFileError(`unexpected content at "${lines[root.next].text}"`, lines[root.next].line);
  }
  return root.value;
}

const asString = (value, what, line) => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new PlanFileError(`${what} must be a string`, line);
  return value;
};

const asNoteList = (value, what) => {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    if (typeof item === 'string') return { text: item, author: '' };
    if (!item || typeof item !== 'object') throw new PlanFileError(`${what}[${index}] must be a map with text/author`);
    const text = asString(item.text, `${what}[${index}].text`);
    if (!text.trim()) throw new PlanFileError(`${what}[${index}].text must not be empty`);
    return { text, author: asString(item.author, `${what}[${index}].author`) };
  });
};

const asStringList = (value, what) => (
  Array.isArray(value) ? value.map((v, i) => asString(v, `${what}[${i}]`)).filter(v => v.trim()) : []
);

function validateAndNormalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PlanFileError('plan must be a map at the top level');
  const versionValue = raw.version === undefined ? 1 : raw.version;
  if (versionValue !== 1 && versionValue !== '1') {
    throw new PlanFileError(`unsupported version ${JSON.stringify(versionValue)} (expected 1)`);
  }
  const allowed = new Set(['version', 'repowiki', 'knowledgecard', 'scope']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      const line = raw[KEY_LINES] ? raw[KEY_LINES][key] : null;
      throw new PlanFileError(`unknown top-level key "${key}"`, line);
    }
  }
  const repowiki = raw.repowiki || {};
  if (typeof repowiki !== 'object') throw new PlanFileError('repowiki must be a map');
  const template = asString(repowiki.template, 'repowiki.template');
  if (!TEMPLATES.has(template)) {
    throw new PlanFileError(`repowiki.template must be one of: "", "architecture", "product_requirement" (got "${template}")`);
  }
  const documents = Array.isArray(repowiki.documents) ? repowiki.documents.map((doc, index) => {
    if (!doc || typeof doc !== 'object') throw new PlanFileError(`repowiki.documents[${index}] must be a map`);
    const title = asString(doc.title, `documents[${index}].title`);
    if (!title.trim()) throw new PlanFileError(`repowiki.documents[${index}].title must not be empty`);
    return {
      title,
      goal: asString(doc.goal, `documents[${index}].goal`),
      parent: asString(doc.parent, `documents[${index}].parent`),
      hints: asString(doc.hints, `documents[${index}].hints`),
    };
  }) : [];
  for (const doc of documents) {
    if (doc.parent && !documents.some(other => other.title === doc.parent)) {
      throw new PlanFileError(`document "${doc.title}" references unknown parent "${doc.parent}"`);
    }
  }
  const seenTitles = new Set();
  for (const doc of documents) {
    if (seenTitles.has(doc.title)) {
      throw new PlanFileError(`repowiki.documents[N].title duplicates an earlier title "${doc.title}"`);
    }
    seenTitles.add(doc.title);
  }
  for (const doc of documents) {
    if (doc.parent && doc.parent === doc.title) {
      throw new PlanFileError(`document "${doc.title}" cannot be its own parent`);
    }
  }
  const byTitle = new Map(documents.map(doc => [doc.title, doc]));
  for (const doc of documents) {
    if (doc.parent && byTitle.get(doc.parent) && byTitle.get(doc.parent).parent) {
      throw new PlanFileError(`document "${doc.title}" is a grandchild — parents must be top-level documents (one level of nesting only)`);
    }
  }
  const knowledgecard = raw.knowledgecard || {};
  if (typeof knowledgecard !== 'object') throw new PlanFileError('knowledgecard must be a map');
  const scope = raw.scope || {};
  if (typeof scope !== 'object') throw new PlanFileError('scope must be a map');
  const include = asStringList(scope.include, 'scope.include');
  const exclude = asStringList(scope.exclude, 'scope.exclude');
  return {
    version: 1,
    repowiki: { template, notes: asNoteList(repowiki.notes, 'repowiki.notes'), documents },
    knowledgecard: { notes: asNoteList(knowledgecard.notes, 'knowledgecard.notes') },
    scope: { include, exclude },
  };
}

function parseWikiPlanYaml(text) {
  return validateAndNormalize(parseYamlSubset(text));
}

function parseWikiPlanJson(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PlanFileError(`wiki_plan.json is not valid JSON: ${err.message}`);
  }
  return validateAndNormalize(raw);
}

function loadWikiPlan(repoDir) {
  const yamlPath = path.join(repoDir, 'wiki_plan.yaml');
  const jsonPath = path.join(repoDir, 'wiki_plan.json');
  if (fs.existsSync(yamlPath)) return parseWikiPlanYaml(fs.readFileSync(yamlPath, 'utf8'));
  if (fs.existsSync(jsonPath)) return parseWikiPlanJson(fs.readFileSync(jsonPath, 'utf8'));
  return null;
}

module.exports = { loadWikiPlan, parseWikiPlanYaml, parseWikiPlanJson, PlanFileError };
