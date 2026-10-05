import * as path from 'node:path';

export interface WikiPaths { outDir: string; metaDir: string; catalogPath: string }

export function wikiPaths(repoRoot: string, language: string): WikiPaths {
  const safeLang = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(language) ? language : 'en';
  const outDir = path.join(repoRoot, '.local-wiki', safeLang, 'content');
  return {
    outDir,
    metaDir: path.join(path.dirname(outDir), 'meta'),
    catalogPath: path.join(path.dirname(outDir), 'meta', 'catalog.json'),
  };
}
