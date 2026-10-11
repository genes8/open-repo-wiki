import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProviderKind = 'openai' | 'anthropic' | 'ollama';
export interface ManagedProfile {
  name: string; provider: ProviderKind; baseUrl: string; model: string;
  maxTokens?: number; concurrency?: number; think?: boolean;
}

export function readManagedConfig(configPath: string): { default?: string; models: Record<string, ManagedProfile & { apiKey?: string }> } {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { default: raw.default, models: raw.models && typeof raw.models === 'object' ? raw.models : {} };
  } catch { return { models: {} }; }
}

export function writeManagedConfig(configPath: string, config: { default?: string; models: Record<string, unknown> }): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

export function writeApiKey(envPath: string, varName: string, key: string): void {
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { /* new */ }
  const rx = new RegExp(`^${varName}=.*$`, 'm');
  const line = `${varName}=${key}`;
  const next = rx.test(text) ? text.replace(rx, line) : (text.endsWith('\n') || !text ? text + line : text + '\n' + line);
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, next.endsWith('\n') || !next ? next : next + '\n');
}

export function envVarNameFor(profileName: string): string {
  const base = profileName.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  return `REPO_WIKI_KEY_${base}`;
}

export function profileToEngineConfig(profile: ManagedProfile): Record<string, unknown> {
  return {
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: `env:${envVarNameFor(profile.name)}`,
    maxTokens: profile.maxTokens ?? 16384,
    ...(profile.concurrency ? { concurrency: profile.concurrency } : {}),
    ...(profile.think === false ? { think: false } : {}),
  };
}
