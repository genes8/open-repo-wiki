import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { EngineRunner } from './engineRunner.js';
import { resolveEnginePaths, resolveNodeCommand } from './enginePaths.js';
import { buildGenerateArgs, buildListModelsArgs, buildModifyArgs } from './pure/args.js';
import { probeAnthropic, probeOllama, probeOpenAI } from './pure/apiProbe.js';
import { readCatalog } from './pure/catalog.js';
import { envVarNameFor, profileToEngineConfig, readManagedConfig, writeApiKey, writeManagedConfig, type ManagedProfile, type ProviderKind } from './pure/modelStore.js';
import { wikiPaths } from './pure/paths.js';
import { scaffoldPlan } from './pure/planScaffold.js';
import { createRunProgress } from './pure/progress.js';
import { createTreeStatus } from './pure/treeStatus.js';
import { pageUriPath, resolveHref, type TreeNode } from './pure/treeModel.js';
import { WikiPreview } from './preview.js';
import { WikiTree } from './wikiTree.js';
import { ChangeDetector } from './changeDetector.js';
import { UpdateStatusBar } from './statusBar.js';

const outputChannel = vscode.window.createOutputChannel('Repo Wiki Engine');
const runner = new EngineRunner();

const getLanguage = () => vscode.workspace.getConfiguration('openRepoWiki').get<string>('language') || 'en';
const tree = new WikiTree(workspaceRoot, getLanguage);
let treeView: vscode.TreeView<TreeNode> | undefined;
let statusBar: UpdateStatusBar | undefined;

function modelFromArgs(args: string[]): string {
  const index = args.indexOf('-m');
  return index >= 0 && index + 1 < args.length ? args[index + 1] : '';
}

async function runEngineWithProgress(title: string, args: string[], context: vscode.ExtensionContext): Promise<boolean> {
  const root = workspaceRoot();
  if (!root) { void vscode.window.showWarningMessage('Repo Wiki: open a workspace folder first.'); return false; }
  if (runner.isActive()) { void vscode.window.showInformationMessage('Repo Wiki: a run is already in progress.'); return false; }
  statusBar?.hide();
  const config = vscode.workspace.getConfiguration('openRepoWiki');
  const engine = resolveEnginePaths(context.extensionPath, config.get<string>('enginePath') || undefined);
  const node = resolveNodeCommand(config.get<string>('nodePath') || undefined);
  const progressOf = createRunProgress();
  const status = createTreeStatus();
  const model = modelFromArgs(args);
  let finalStats: { generated: number; degraded: number; skipped: number } = { generated: 0, degraded: 0, skipped: 0 };
  let success = false;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title,
    cancellable: true,
  }, async (progress, token) => {
    token.onCancellationRequested(() => runner.cancel());
    progress.report({ message: 'starting engine…', increment: 0 });
    const result = await runner.run(node.command, engine.generateJs, node.prefixArgs, node.env, {
      args,
      cwd: root,
      onEvent: event => {
        const update = progressOf(event);
        if (update) progress.report(update);
        if (treeView) {
          const s = status.step(event);
          if (s) {
            treeView.message = s.message;
            if (s.badge !== undefined && 'badge' in treeView) {
              treeView.badge = { value: s.badge, tooltip: 'pages written' };
            }
          }
        }
        if (event.type === 'run_finished' && event.stats) {
          finalStats = { generated: event.stats.generated, degraded: event.stats.degraded, skipped: event.stats.skipped };
        }
        outputChannel.appendLine(JSON.stringify(event));
      },
      onLog: line => outputChannel.appendLine(line),
    });
    if (result.code !== 0) {
      if (treeView) {
        treeView.message = '✗ last run failed — see output';
        treeView.badge = undefined;
      }
      void vscode.window.showErrorMessage(
        `Repo Wiki: run failed${result.errorEvent?.code ? ` (${result.errorEvent.code})` : ''}: ${result.errorEvent?.message ?? 'see output'}`,
        'Show output',
      ).then(choice => { if (choice === 'Show output') outputChannel.show(); });
    } else {
      tree.refresh();
      statusBar?.hide();
      if (treeView) {
        const s = status.summary(finalStats, model);
        treeView.message = s.message;
        treeView.badge = undefined;
      }
      success = true;
    }
  });
  return success;
}

// ---------------------------------------------------------------------------
// Guided model manager (gear menu). Managed profiles live in
// <workspaceRoot>/repo-wiki.config.json and their key values in
// <workspaceRoot>/.env. The engine's loadConfig discovers the repo
// repo-wiki.config.json BEFORE the bundled app config, so profiles saved here
// win over the app defaults. Merge (never overwrite) so hand-maintained
// entries survive.
// ---------------------------------------------------------------------------

const MANAGED_CONFIG_FILENAME = 'repo-wiki.config.json';
const ENV_FILENAME = '.env';

interface KindMeta { label: string; detail: string; defaultName: string; defaultBaseUrl: string }

const KIND_META: Record<ProviderKind, KindMeta> = {
  openai: {
    label: 'OpenAI-compatible',
    detail: 'LM Studio, vLLM, llama.cpp, Zhipu GLM, Kimi, …',
    defaultName: 'openai-local',
    defaultBaseUrl: 'http://localhost:1234/v1',
  },
  anthropic: {
    label: 'Anthropic-compatible',
    detail: 'Zhipu GLM Coding Plan, Claude, …',
    defaultName: 'anthropic',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  },
  ollama: {
    label: 'Ollama (local)',
    detail: 'Native /api/chat endpoint, no key',
    defaultName: 'ollama',
    defaultBaseUrl: 'http://localhost:11434',
  },
};

function isGitignored(root: string, relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', relPath], { cwd: root, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function probeModel(kind: ProviderKind, baseUrl: string, apiKey: string, model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (kind === 'openai') return probeOpenAI(baseUrl, apiKey, model);
  if (kind === 'anthropic') return probeAnthropic(baseUrl, apiKey, model);
  return probeOllama(baseUrl, model);
}

async function showSettingsMenu(context: vscode.ExtensionContext, tree: WikiTree): Promise<void> {
  void context;
  void tree;
  const choice = await vscode.window.showQuickPick(
    [
      { label: '➕ Add / edit model…', value: 'add' as const },
      { label: '🔑 Set API key…', value: 'key' as const },
      { label: '🤖 Select model…', value: 'select' as const },
      { label: '⚙️ All settings…', value: 'all' as const },
    ],
    { placeHolder: 'Repo Wiki — model settings' },
  );
  if (!choice) return;
  switch (choice.value) {
    case 'add': await addOrEditModel(); return;
    case 'key': await setApiKey(); return;
    case 'select': await vscode.commands.executeCommand('openRepoWiki.selectModel'); return;
    case 'all': await vscode.commands.executeCommand('workbench.action.openSettings', 'openRepoWiki'); return;
  }
}

async function addOrEditModel(): Promise<void> {
  const root = workspaceRoot();
  if (!root) { void vscode.window.showWarningMessage('Repo Wiki: open a workspace folder first.'); return; }
  const configPath = path.join(root, MANAGED_CONFIG_FILENAME);
  const envPath = path.join(root, ENV_FILENAME);

  const kindPick = await vscode.window.showQuickPick(
    (['openai', 'anthropic', 'ollama'] as const).map(k => ({ label: KIND_META[k].label, detail: KIND_META[k].detail, provider: k })),
    { placeHolder: 'Provider kind' },
  );
  if (!kindPick) return;
  const kind = kindPick.provider;

  const config = readManagedConfig(configPath);
  const nameInput = await vscode.window.showInputBox({
    prompt: 'Profile name',
    value: KIND_META[kind].defaultName,
    ignoreFocusOut: true,
  });
  if (!nameInput) return;
  const name = nameInput.trim();
  if (!name) { void vscode.window.showWarningMessage('Repo Wiki: profile name cannot be empty.'); return; }

  // Editing an existing managed profile prefills its saved values.
  const existing = config.models[name];

  const baseUrl = await vscode.window.showInputBox({
    prompt: 'Base URL',
    value: (existing && typeof existing.baseUrl === 'string' && existing.baseUrl) || KIND_META[kind].defaultBaseUrl,
    ignoreFocusOut: true,
  });
  if (!baseUrl) return;

  const model = await vscode.window.showInputBox({
    prompt: 'Model id',
    value: existing && typeof existing.model === 'string' ? existing.model : '',
    ignoreFocusOut: true,
  });
  if (!model) return;

  let apiKey = '';
  if (kind !== 'ollama') {
    const key = await vscode.window.showInputBox({
      prompt: kind === 'openai' ? 'API key (optional for local servers)' : 'API key',
      password: true,
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    apiKey = key;
  }

  const profile: ManagedProfile = { name, provider: kind, baseUrl, model };
  const { proceed, apiKey: finalKey } = await testProfileBeforeSave(kind, baseUrl, model, apiKey);
  if (!proceed) return;

  // This file is user-visible and engine-discovered: the engine reads
  // <workspace>/repo-wiki.config.json BEFORE the app config, so merge into the
  // existing models map instead of replacing it.
  const models: Record<string, unknown> = { ...config.models };
  models[name] = profileToEngineConfig(profile);
  writeManagedConfig(configPath, { default: config.default || name, models });
  if (kind !== 'ollama' && finalKey) {
    writeApiKey(envPath, envVarNameFor(name), finalKey);
  }
  if (isGitignored(root, ENV_FILENAME)) {
    void vscode.window.showInformationMessage(`Repo Wiki: Saved ${name} → repo-wiki.config.json + .env (gitignored).`);
  } else {
    void vscode.window.showWarningMessage(`Repo Wiki: Saved ${name} → repo-wiki.config.json + .env. Warning: .env is not gitignored in this repo — your key may be committed.`);
  }
}

async function testProfileBeforeSave(kind: ProviderKind, baseUrl: string, model: string, initialKey: string): Promise<{ proceed: boolean; apiKey: string }> {
  let apiKey = initialKey;
  for (;;) {
    const answer = await vscode.window.showQuickPick(
      [{ label: 'Test', description: 'probe the endpoint now' }, { label: 'Skip', description: 'save without testing' }],
      { placeHolder: 'Test this model before saving?' },
    );
    if (!answer || answer.label === 'Skip') return { proceed: true, apiKey };
    const result = await probeModel(kind, baseUrl, apiKey, model);
    if (result.ok) {
      void vscode.window.showInformationMessage('Repo Wiki: probe OK — the endpoint responds.');
      return { proceed: true, apiKey };
    }
    if (kind === 'ollama') {
      const action = await vscode.window.showErrorMessage(`Repo Wiki: probe failed — ${result.error}`, 'Skip');
      if (action === 'Skip') return { proceed: true, apiKey };
      return { proceed: false, apiKey };
    }
    const action = await vscode.window.showErrorMessage(`Repo Wiki: probe failed — ${result.error}`, 'Retry key', 'Skip');
    if (action === 'Skip') return { proceed: true, apiKey };
    if (action === 'Retry key') {
      const next = await vscode.window.showInputBox({ prompt: 'API key', password: true, ignoreFocusOut: true });
      if (next === undefined) return { proceed: false, apiKey };
      apiKey = next;
      continue;
    }
    return { proceed: false, apiKey };
  }
}

async function setApiKey(): Promise<void> {
  const root = workspaceRoot();
  if (!root) { void vscode.window.showWarningMessage('Repo Wiki: open a workspace folder first.'); return; }
  const configPath = path.join(root, MANAGED_CONFIG_FILENAME);
  const envPath = path.join(root, ENV_FILENAME);
  const config = readManagedConfig(configPath);
  const names = Object.keys(config.models);
  if (!names.length) { void vscode.window.showWarningMessage('Repo Wiki: no managed models yet — add one first.'); return; }

  const picked = await vscode.window.showQuickPick(
    names.map(n => ({ label: n, description: `${config.models[n].provider}: ${config.models[n].model}` })),
    { placeHolder: 'Model profile' },
  );
  if (!picked) return;
  const name = picked.label;
  const profile = config.models[name];
  if (profile.provider === 'ollama') { void vscode.window.showInformationMessage('Repo Wiki: Ollama profiles use no API key.'); return; }

  let key = await vscode.window.showInputBox({ prompt: `API key for ${name}`, password: true, ignoreFocusOut: true });
  if (key === undefined) return;
  if (!key.trim()) { void vscode.window.showWarningMessage('Repo Wiki: key cannot be empty.'); return; }

  for (;;) {
    const result = await probeModel(profile.provider, profile.baseUrl, key, profile.model);
    if (result.ok) { void vscode.window.showInformationMessage(`Repo Wiki: key works for ${name}.`); break; }
    const action = await vscode.window.showErrorMessage(`Repo Wiki: probe failed — ${result.error}`, 'Retry key', 'Save anyway');
    if (action === 'Save anyway') break;
    if (action === 'Retry key') {
      const next = await vscode.window.showInputBox({ prompt: `API key for ${name}`, password: true, ignoreFocusOut: true });
      if (next === undefined) return;
      key = next;
      continue;
    }
    return;
  }

  writeApiKey(envPath, envVarNameFor(name), key);
  void vscode.window.showInformationMessage(`Repo Wiki: saved API key for ${name} → .env`);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(outputChannel);

  const status = new UpdateStatusBar(() => void vscode.commands.executeCommand('openRepoWiki.generate'));
  statusBar = status;
  context.subscriptions.push(status);

  const changeDetector = new ChangeDetector(
    workspaceRoot,
    getLanguage,
    (autoRun) => { if (autoRun) void vscode.commands.executeCommand('openRepoWiki.generate'); else status.show(); },
  );
  context.subscriptions.push(changeDetector);

  const preview = new WikiPreview(context.extensionPath);
  let currentPagePath = '';

  const showPage = async (page: TreeNode): Promise<void> => {
    const root = workspaceRoot();
    if (!root) return;
    const pageFile = path.join(root, pageUriPath(page.page.path, getLanguage()));
    try {
      const markdown = await fsp.readFile(pageFile, 'utf8');
      currentPagePath = page.page.path;
      preview.show(
        { path: page.page.path, title: page.page.title, markdown, protected: page.page.protected, quality: page.page.quality },
        (href) => {
          const navRoot = workspaceRoot();
          if (!navRoot) return;
          const catalog = readCatalog(navRoot, getLanguage());
          if (!catalog) { void vscode.window.showWarningMessage('Repo Wiki: no catalog available for navigation.'); return; }
          const target = resolveHref(catalog, currentPagePath, href);
          if (!target) { void vscode.window.showWarningMessage(`Repo Wiki: cannot resolve link: ${href}`); return; }
          const targetPage = catalog.pages.find(p => p.path === target);
          if (!targetPage) { void vscode.window.showWarningMessage(`Repo Wiki: page not in catalog: ${target}`); return; }
          void showPage({ page: targetPage, children: [] });
        },
        (pagePath) => {
          const editRoot = workspaceRoot();
          if (!editRoot) return;
          const uri = vscode.Uri.file(path.join(editRoot, pageUriPath(pagePath, getLanguage())));
          void vscode.window.showTextDocument(uri).then(undefined, () => {
            void vscode.window.showErrorMessage(`Repo Wiki: page file missing: ${pagePath}`);
          });
        },
      );
    } catch {
      void vscode.window.showErrorMessage(`Repo Wiki: page file missing: ${page.page.path}`);
    }
  };

  treeView = vscode.window.createTreeView('openRepoWiki.pages', { treeDataProvider: tree });
  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand('openRepoWiki.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('openRepoWiki.openPage', async (node?: TreeNode) => {
      if (!node) return; // palette invocation without a tree item: nothing to open
      await showPage(node);
    }),
  );
  tree.refresh();

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.showOutput', () => outputChannel.show()));

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.openSettings', () =>
    showSettingsMenu(context, tree)));

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.generate', async () => {
    const root = workspaceRoot();
    if (!root) { void vscode.window.showWarningMessage('Repo Wiki: open a workspace folder first.'); return; }
    const config = vscode.workspace.getConfiguration('openRepoWiki');
    const args = buildGenerateArgs({
      repoRoot: root,
      language: getLanguage(),
      model: config.get<string>('defaultModel') || undefined,
      configPath: config.get<string>('configPath') || undefined,
    });
    if (await runEngineWithProgress('Repo Wiki: generating', args, context)) {
      void vscode.window.showInformationMessage('Repo Wiki: generation finished.');
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.modifyPage', async (node?: TreeNode) => {
    const root = workspaceRoot();
    if (!root) return;
    const config = vscode.workspace.getConfiguration('openRepoWiki');
    const language = getLanguage();
    const catalog = readCatalog(root, language);
    if (!catalog) { void vscode.window.showWarningMessage('Repo Wiki: generate a wiki first.'); return; }
    let pagePath = node?.page.path;
    if (!pagePath) {
      const picked = await vscode.window.showQuickPick(
        catalog.pages.map(p => ({ label: p.title, description: p.path, detail: p.protected ? '🔒 protected' : undefined, path: p.path })),
        { placeHolder: 'Which page?' },
      );
      if (!picked) return;
      pagePath = picked.path;
    }
    const operation = await vscode.window.showQuickPick(
      [
        { label: 'Modify', description: 'targeted edits, keep structure', value: 'modify' as const },
        { label: 'Supplement', description: 'append new content only', value: 'supplement' as const },
        { label: 'Rewrite', description: 'full rewrite', value: 'rewrite' as const },
      ],
      { placeHolder: `Operation on ${pagePath}` },
    );
    if (!operation) return;
    const instruction = await vscode.window.showInputBox({
      prompt: `Instruction for ${operation.value} of ${pagePath}`,
      ignoreFocusOut: true,
    });
    if (!instruction) return;
    const args = buildModifyArgs({
      repoRoot: root,
      language,
      model: config.get<string>('defaultModel') || undefined,
      configPath: config.get<string>('configPath') || undefined,
      pagePath,
      operation: operation.value,
      instruction,
    });
    if (await runEngineWithProgress('Repo Wiki: modifying', args, context)) {
      void vscode.window.showInformationMessage(`Repo Wiki: modified ${pagePath}.`);
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.editPlan', async () => {
    const root = workspaceRoot();
    if (!root) return;
    const file = scaffoldPlan(root);
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    void vscode.window.showInformationMessage('Repo Wiki: after editing wiki_plan.yaml, run Generate to apply.');
  }));

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.selectModel', async () => {
    const root = workspaceRoot();
    if (!root) return;
    if (runner.isActive()) { void vscode.window.showInformationMessage('Repo Wiki: a run is already in progress.'); return; }
    const config = vscode.workspace.getConfiguration('openRepoWiki');
    const engine = resolveEnginePaths(context.extensionPath, config.get<string>('enginePath') || undefined);
    const node = resolveNodeCommand(config.get<string>('nodePath') || undefined);
    const profiles: Array<{ name: string; provider: string; model: string; isDefault: boolean }> = [];
    const result = await runner.run(node.command, engine.generateJs, node.prefixArgs, node.env, {
      args: buildListModelsArgs({ repoRoot: root, configPath: config.get<string>('configPath') || undefined }),
      cwd: root,
      onEvent: event => {
        if (event.type === 'model_profile' && event.name) {
          profiles.push({ name: event.name, provider: event.provider || '', model: event.model || '', isDefault: event.default === true });
        }
      },
    });
    if (!profiles.length) { void vscode.window.showErrorMessage(`Repo Wiki: no model profiles (${result.errorEvent?.message ?? 'check config'})`); return; }
    const picked = await vscode.window.showQuickPick(
      profiles.map(p => ({ label: p.name, description: `${p.provider}: ${p.model}`, detail: p.isDefault ? 'config default' : undefined, name: p.name })),
      { placeHolder: 'Default model profile' },
    );
    if (picked) await config.update('defaultModel', picked.name, vscode.ConfigurationTarget.Global);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.selectLanguage', async () => {
    const config = vscode.workspace.getConfiguration('openRepoWiki');
    const picked = await vscode.window.showQuickPick(
      ['en', 'sr', 'zh', 'de', 'fr', 'es'].map(l => ({ label: l })),
      { placeHolder: 'Wiki language (creates .local-wiki/<lang>)' },
    );
    if (picked) {
      await config.update('language', picked.label, vscode.ConfigurationTarget.Workspace);
      tree.refresh();
    }
  }));

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.exportPdf', async () => {
    const root = workspaceRoot();
    if (!root) return;
    if (runner.isActive()) { void vscode.window.showInformationMessage('Repo Wiki: a run is already in progress.'); return; }
    const config = vscode.workspace.getConfiguration('openRepoWiki');
    const engine = resolveEnginePaths(context.extensionPath, config.get<string>('enginePath') || undefined);
    const node = resolveNodeCommand(config.get<string>('nodePath') || undefined);
    const language = config.get<string>('language') || 'en';
    const outDir = wikiPaths(root, language).outDir;
    if (!fs.existsSync(outDir)) { void vscode.window.showWarningMessage('Repo Wiki: generate a wiki first.'); return; }
    // PDF export needs playwright + pdf-lib resolvable next to the engine script.
    const engineDir = path.dirname(engine.exportJs);
    const hasPdfDeps = ['playwright', 'pdf-lib'].every(dep =>
      fs.existsSync(path.join(engineDir, 'node_modules', dep)) || fs.existsSync(path.join(engineDir, '..', 'node_modules', dep)),
    );
    if (!hasPdfDeps) {
      const choice = await vscode.window.showWarningMessage(
        'PDF export needs the engine\'s optional packages (playwright, pdf-lib).',
        'How to install',
      );
      if (choice === 'How to install') {
        void vscode.env.openExternal(vscode.Uri.parse('https://github.com/genes8/open-repo-wiki#install'));
      }
      return;
    }
    const pdfDir = path.join(root, 'wiki-pdf');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Repo Wiki: exporting PDF', cancellable: false }, async () => {
      const result = await runner.run(node.command, engine.exportJs, node.prefixArgs, node.env, {
        args: [outDir, pdfDir],
        cwd: root,
        onEvent: () => {},
        onLog: line => outputChannel.appendLine(line),
      });
      if (result.code === 0) {
        void vscode.window.showInformationMessage('Repo Wiki: PDF export finished.', 'Reveal folder').then(c => {
          if (c === 'Reveal folder') void vscode.env.openExternal(vscode.Uri.file(pdfDir));
        });
      } else {
        void vscode.window.showErrorMessage('Repo Wiki: PDF export failed — see output.');
      }
    });
  }));
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function deactivate(): void {
  runner.cancel();
}
