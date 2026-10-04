#!/usr/bin/env node
/**
 * CLI entry for the local Repo Wiki generator. All orchestration lives in
 * lib/api.js; this file parses arguments, picks a reporter (human or NDJSON),
 * and maps ApiError codes to exit codes.
 */
const fs = require('fs');
const path = require('path');
const {
  generateWiki,
  modifyWiki,
  loadConfig,
  loadDotenv,
  listModels,
  ApiError,
} = require('./lib/api');
const { createHumanReporter, createNdjsonReporter } = require('./lib/events');

const HELP = `Local Repo Wiki generator

Usage: node generate.js [repoDir] [options]

Options:
  -m, --model <name>    model profile from config (default: config "default")
  -o, --out <dir>       output dir (default: <repoDir>/.local-wiki/en/content)
  -c, --config <file>   config file (default: <repoDir>/repo-wiki.config.json,
                        then <appDir>/config.json)
      --pages <substr>  only (re)generate pages whose path contains substring
      --concurrency <n> pages generated in parallel (default: profile/config, else 1)
      --template <name> page template: "standard" (citations + TOC) or "minimal"
      --knowledge       also generate the structured knowledge-card layer
      --force           regenerate everything, ignore the incremental cache
      --dry-run         print the wiki plan and exit without writing pages
      --prune           delete managed pages omitted by a successful,
                        non-regressive full plan
      --accept-plan-shrink
                        accept a regressive plan and delete omitted managed pages
      --json-events     machine mode: NDJSON events on stdout instead of human logs
      --modify <path>   modify an existing page (see --op); pairs with --instruction
      --op <name>       operation for --modify: modify | supplement | rewrite
      --instruction <text>
                        instruction describing the desired change (required with --modify)
      --list-models     list configured model profiles and exit
  -h, --help            show this help

Environment: REPO_WIKI_MODEL overrides the default model profile.`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model' || a === '-m') args.model = argv[++i];
    else if (a === '--out' || a === '-o') args.out = argv[++i];
    else if (a === '--config' || a === '-c') args.config = argv[++i];
    else if (a === '--pages') args.pages = argv[++i];
    else if (a === '--concurrency') args.concurrency = argv[++i];
    else if (a === '--template') args.template = argv[++i];
    else if (a === '--knowledge') args.knowledge = true;
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--prune') args.prune = true;
    else if (a === '--accept-plan-shrink') args.acceptPlanShrink = true;
    else if (a === '--json-events') args.jsonEvents = true;
    else if (a === '--modify') args.modify = argv[++i];
    else if (a === '--op') args.op = argv[++i];
    else if (a === '--instruction') args.instruction = argv[++i];
    else if (a === '--list-models') args.listModels = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }
  if (args.pages && (args.prune || args.acceptPlanShrink)) {
    console.error('--pages cannot be combined with --prune or --accept-plan-shrink');
    process.exit(1);
  }
  const repoDir = path.resolve(args._[0] || process.cwd());
  if (fs.existsSync(repoDir) && !fs.statSync(repoDir).isDirectory()) {
    console.error(`Repository directory not found: ${repoDir}`);
    process.exit(1);
  }

  const report = args.jsonEvents ? createNdjsonReporter() : createHumanReporter();

  if (args.listModels) {
    if (args.jsonEvents) {
      loadDotenv(repoDir);
    } else {
      loadDotenv(repoDir, (type, payload) => report({ type, ...payload }));
    }
    const { config } = loadConfig(args, repoDir);
    if (args.jsonEvents) {
      for (const [name, p] of Object.entries(config.models || {})) {
        report({ type: 'model_profile', name, default: name === config.default, provider: p.provider, model: p.model || p.modelPath || null });
      }
    } else {
      listModels(config);
    }
    process.exit(0);
  }

  try {
    if (args.modify) {
      await modifyWiki(repoDir, args, report);
    } else {
      await generateWiki(repoDir, args, report);
    }
    process.exit(0);
  } catch (err) {
    const code = err instanceof ApiError && err.code ? err.code : 'fatal';
    const message = String(err && err.message || err);
    if (args.jsonEvents) report({ type: 'run_error', code, message });
    else console.error(`Fatal: ${message}`);
    process.exit(1);
  }
})();
