import { wikiPaths } from './paths.js';

export interface EngineTarget { repoRoot: string; language: string; model?: string; configPath?: string }

function baseArgs(t: EngineTarget): string[] {
  const args = [t.repoRoot, '--json-events', '-o', wikiPaths(t.repoRoot, t.language).outDir];
  if (t.model) args.push('-m', t.model);
  if (t.configPath) args.push('--config', t.configPath);
  return args;
}

export interface GenerateOptions extends EngineTarget { force?: boolean; knowledge?: boolean }

export function buildGenerateArgs(o: GenerateOptions): string[] {
  const args = baseArgs(o);
  if (o.force) args.push('--force');
  if (o.knowledge) args.push('--knowledge');
  return args;
}

export interface ModifyOptions extends EngineTarget { pagePath: string; operation: 'modify' | 'supplement' | 'rewrite'; instruction: string }

export function buildModifyArgs(o: ModifyOptions): string[] {
  return [...baseArgs(o), '--modify', o.pagePath, '--op', o.operation, '--instruction', o.instruction];
}

export function buildListModelsArgs(o: { repoRoot: string; configPath?: string }): string[] {
  const args = [o.repoRoot, '--list-models', '--json-events'];
  if (o.configPath) args.push('--config', o.configPath);
  return args;
}
