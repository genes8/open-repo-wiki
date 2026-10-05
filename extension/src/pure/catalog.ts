import * as fs from 'node:fs';
import { wikiPaths } from './paths.js';

export interface CatalogPage {
  path: string; title: string; description: string;
  dependent_files: string[]; parent: string | null;
  isLanding: boolean; quality: 'ok' | 'degraded'; protected: boolean;
}
export interface Catalog {
  repo: string; model: string; language: string; generatedAt: string; pages: CatalogPage[];
}

export function readCatalog(repoRoot: string, language: string): Catalog | null {
  try {
    const raw = JSON.parse(fs.readFileSync(wikiPaths(repoRoot, language).catalogPath, 'utf8'));
    if (!raw || !Array.isArray(raw.pages)) return null;
    const pages: CatalogPage[] = [];
    for (const p of raw.pages) {
      if (!p || typeof p.path !== 'string' || typeof p.title !== 'string') continue;
      pages.push({
        path: p.path,
        title: p.title,
        description: String(p.description || ''),
        dependent_files: Array.isArray(p.dependent_files) ? p.dependent_files.filter((f: unknown): f is string => typeof f === 'string') : [],
        parent: typeof p.parent === 'string' ? p.parent : null,
        isLanding: p.isLanding === true,
        quality: p.quality === 'degraded' ? 'degraded' : 'ok',
        protected: p.protected === true,
      });
    }
    return {
      repo: String(raw.repo || ''),
      model: String(raw.model || ''),
      language: String(raw.language || language),
      generatedAt: String(raw.generatedAt || ''),
      pages,
    };
  } catch {
    return null;
  }
}
