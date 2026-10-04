'use strict';
/**
 * Typed run-event plumbing for the wiki engine. api.js emits structured
 * events; reporters render them for humans (CLI default) or as NDJSON
 * (--json-events, consumed by the VSCode extension / other tools).
 */
const { EventEmitter } = require('node:events');

function createEventBus() {
  const bus = new EventEmitter();
  const emit = (type, payload = {}) => {
    bus.emit('event', { type, ts: new Date().toISOString(), ...payload });
  };
  return { bus, emit };
}

// Exact strings the CLI printed before extraction; tests and users rely on them.
function createHumanReporter(log = line => console.log(line)) {
  const statusLabel = {
    generated: (e) => `  OK    ${e.path} (${e.chars} chars, ${e.files} source files)`,
    degraded: (e) => `  WARN  ${e.path}: published degraded after 3 attempts (${e.codes})`,
    protected: (e) => `  SKIP  ${e.path} (protected: ${e.reason || 'curated'})`,
    skipped: (e) => `  SKIP  ${e.path} (${e.reason || 'unchanged'})`,
  };
  return (event) => {
    switch (event.type) {
      case 'run_started':
        log(`Repo:   ${event.repo}`);
        log(`Model:  ${event.model} (${event.provider}: ${event.modelId})`);
        log(`Config: ${event.configPath}`);
        log(`Out:    ${event.outDir}\n`);
        break;
      case 'env_loaded': log(`  loaded .env (${event.count} var${event.count === 1 ? '' : 's'})`); break;
      case 'scan_done': log(`  ${event.files} files considered\n`); break;
      case 'scan_warning': log(`  WARN  ${event.message}`); break;
      case 'plan_started': log('Planning wiki structure...'); break;
      case 'plan_retry': log(`  REPAIR plan attempt ${event.attempt}/2 (${event.codes})`); break;
      case 'plan_ready':
        log(`  ${event.pages.length} pages planned:`);
        for (const p of event.pages) log(`    - ${p.path}  (${p.title})`);
        if (event.coverage) log(`  coverage: attached ${event.coverage} otherwise-undocumented source file(s) to pages`);
        break;
      case 'dry_run': log('\nDry run — no pages written.'); break;
      case 'page_start': log(`  GEN   ${event.path} ...`); break;
      case 'page_retry': log(`  REPAIR ${event.path} attempt ${event.attempt}/2 (${event.codes})`); break;
      case 'page_note': log(`  note  ${event.path}: ${event.message}`); break;
      case 'page_done': log(statusLabel[event.status](event)); break;
      case 'page_fail': log(`  FAIL  ${event.path}: ${String(event.message).split('\n')[0]}`); break;
      case 'stale_removed': log(`  removed stale: ${event.path}`); break;
      case 'catalog_written': log(`  catalog + index staged -> ${event.metaDir}`); break;
      case 'knowledge_started': log('\nGenerating knowledge cards...'); break;
      case 'knowledge_card_fail': log(`  FAIL  ${event.path}: ${String(event.message).split('\n')[0]}`); break;
      case 'knowledge_done':
        log(`  knowledge: ${event.generated} cards written, ${event.duplicates} duplicates skipped, `
          + `${event.removed} stale removed -> ${event.dir}`);
        break;
      case 'knowledge_failed_run': log(`  knowledge: ${event.failed} failed; staged run will be discarded`); break;
      case 'run_aborted':
        log(`\nAborted: ${event.ok} staged, ${event.skipped} skipped, ${event.failed} ${event.subject} failures; live wiki unchanged`);
        break;
      case 'run_finished':
        log(`\nDone: ${event.stats.generated} generated, ${event.stats.degraded} degraded, `
          + `${event.stats.skipped} skipped, ${event.stats.failed} page failures, `
          + `${event.stats.knowledgeFailed} knowledge failures -> ${event.outDir}`);
        log(event.tip);
        break;
      case 'cleanup_warning': log(`  WARN  backup cleanup (${event.target}): ${event.message}`); break;
      default: break; // unknown events are ignored by the human reporter
    }
  };
}

function createNdjsonReporter(write = chunk => process.stdout.write(chunk)) {
  return (event) => { write(`${JSON.stringify(event)}\n`); };
}

module.exports = { createEventBus, createHumanReporter, createNdjsonReporter };
