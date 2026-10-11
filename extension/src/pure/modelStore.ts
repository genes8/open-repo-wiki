import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProviderKind = 'openai' | 'anthropic' | 'ollama';
export interface ManagedProfile {
  name: string; provider: ProviderKind; baseUrl: string; model: string;
  maxTokens?: number; concurrency?: number; think?: boolean;
}

export function readRawManagedConfig(configPath: string): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    return {};
  } catch { return {}; }
}

export function readManagedConfig(configPath: string): { default?: string; models: Record<string, ManagedProfile & { apiKey?: string }> } {
  const raw = readRawManagedConfig(configPath);
  const result: { default?: string; models: Record<string, ManagedProfile & { apiKey?: string }> } = {
    models: raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)
      ? raw.models as Record<string, ManagedProfile & { apiKey?: string }>
      : {},
  };
  if (typeof raw.default === 'string') result.default = raw.default;
  return result;
}

export function writeManagedConfig(configPath: string, config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

export function upsertModel(configPath: string, name: string, engineProfile: Record<string, unknown>): void {
  const raw = readRawManagedConfig(configPath);
  if (!raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models)) {
    raw.models = {};
  }
  (raw.models as Record<string, unknown>)[name] = engineProfile;
  if (raw.default === undefined) raw.default = name;
  writeManagedConfig(configPath, raw);
}

export function writeApiKey(envPath: string, varName: string, key: string): void {
  let text = '';
  try { text = fs.readFileSync(envPath, 'utf8'); } catch { /* new */ }
  const rx = new RegExp(`^${varName}=.*$`, 'm');
  const line = `${varName}=${key}`;
  const next = rx.test(text) ? text.replace(rx, () => line) : (text.endsWith('\n') || !text ? text + line : text + '\n' + line);
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
    ...(profile.provider !== 'ollama' ? { apiKey: `env:${envVarNameFor(profile.name)}` } : {}),
    maxTokens: profile.maxTokens ?? 16384,
    ...(profile.concurrency ? { concurrency: profile.concurrency } : {}),
    ...(profile.think === false ? { think: false } : {}),
  };
}
