import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const engineRoot = resolve(root, '..');
const watch = process.argv.includes('--watch');

mkdirSync(join(root, 'dist', 'webview'), { recursive: true });

// 1) The extension host bundle.
await build({
  entryPoints: [join(root, 'src', 'extension.ts')],
  bundle: true,
  outfile: join(root, 'dist', 'extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  ...(watch ? { watch: true } : {}),
});

// 2) The engine bundles (self-contained; optional natives fail at runtime via
//    their own try/catch paths exactly like an install without them).
for (const [entry, outfile] of [
  [join(engineRoot, 'generate.js'), 'generate.cjs'],
  [join(engineRoot, 'export.js'), 'export.cjs'],
]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    outfile: join(root, 'dist', 'engine', outfile),
    external: ['node-llama-cpp', 'playwright', 'pdf-lib'],
    format: 'cjs',
    platform: 'node',
    target: 'node16',
    sourcemap: false,
    banner: { js: "const __non_webpack_require__ = require;" },
    logLevel: 'info',
  });
}

// 3) Vendored webview assets (UMD builds shipped as static files).
const vendor = join(root, 'node_modules');
const webview = join(root, 'dist', 'webview');
for (const [from, to] of [
  [join(vendor, 'marked', 'lib', 'marked.umd.js'), 'marked.js'],
  [join(vendor, 'highlight.js', 'lib', 'index.js'), 'highlight.js'],
  [join(vendor, 'highlight.js', 'styles', 'github.css'), 'highlight.css'],
  [join(vendor, 'mermaid', 'dist', 'mermaid.min.js'), 'mermaid.js'],
]) {
  cpSync(from, join(webview, to));
}

// 4) Our webview sources (html/css/glue).
for (const file of ['page.html', 'page.css', 'webview.js']) {
  cpSync(join(root, 'webview', file), join(webview, file));
}
console.log('build complete: dist/extension.js, dist/engine/*, dist/webview/*');
