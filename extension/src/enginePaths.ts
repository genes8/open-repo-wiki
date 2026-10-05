import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface EnginePaths {
  generateJs: string;
  exportJs: string;
  source: 'setting' | 'monorepo' | 'bundled';
}

/**
 * Resolve the engine entrypoints in priority order:
 *   1. `enginePath` setting (folder containing generate.js / export.js)
 *   2. monorepo checkout next to the extension (repo-root/generate.js)
 *   3. bundled engine under dist/engine/*.cjs
 */
export function resolveEnginePaths(extensionPath: string, enginePathSetting?: string): EnginePaths {
  if (enginePathSetting) {
    const generateJs = path.join(enginePathSetting, 'generate.js');
    if (fs.existsSync(generateJs)) {
      return { generateJs, exportJs: path.join(enginePathSetting, 'export.js'), source: 'setting' };
    }
  }
  const monorepo = path.resolve(extensionPath, '..');
  if (fs.existsSync(path.join(monorepo, 'generate.js'))) {
    return { generateJs: path.join(monorepo, 'generate.js'), exportJs: path.join(monorepo, 'export.js'), source: 'monorepo' };
  }
  return {
    generateJs: path.join(extensionPath, 'dist', 'engine', 'generate.cjs'),
    exportJs: path.join(extensionPath, 'dist', 'engine', 'export.cjs'),
    source: 'bundled',
  };
}

export interface ResolvedNodeCommand {
  command: string;
  prefixArgs: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve the Node binary used to spawn the engine, probing each candidate
 * with `-v` (1500ms timeout) and picking the first that exits 0. Order:
 *   1. `nodePath` setting (if configured)
 *   2. `node` from PATH
 *   3. the current process executable forced into Node mode via
 *      ELECTRON_RUN_AS_NODE=1 (VSCode extension host / Electron)
 */
export function resolveNodeCommand(nodePathSetting?: string): ResolvedNodeCommand {
  const candidates: ResolvedNodeCommand[] = [];
  if (nodePathSetting) candidates.push({ command: nodePathSetting, prefixArgs: [], env: {} });
  candidates.push({ command: 'node', prefixArgs: [], env: {} });
  candidates.push({ command: process.execPath, prefixArgs: [], env: { ELECTRON_RUN_AS_NODE: '1' } });

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, ["-v"], { timeout: 1500, encoding: "utf8", env: { ...process.env, ...candidate.env } });
    if (probe.status === 0 && !probe.error) return candidate;
  }
  return candidates[candidates.length - 1];
}
