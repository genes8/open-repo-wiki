import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EngineRunner } from './engineRunner.js';
import { resolveEnginePaths, resolveNodeCommand } from './enginePaths.js';
import { buildGenerateArgs, buildListModelsArgs, buildModifyArgs } from './pure/args.js';
import { readCatalog } from './pure/catalog.js';
import { wikiPaths } from './pure/paths.js';
import { scaffoldPlan } from './pure/planScaffold.js';
import { createRunProgress } from './pure/progress.js';
import { pageUriPath, resolveHref, type TreeNode } from './pure/treeModel.js';
import { WikiPreview } from './preview.js';
import { WikiTree } from './wikiTree.js';

const outputChannel = vscode.window.createOutputChannel('Repo Wiki Engine');
const runner = new EngineRunner();

const getLanguage = () => vscode.workspace.getConfiguration('openRepoWiki').get<string>('language') || 'en';
const tree = new WikiTree(workspaceRoot, getLanguage);

async function runEngineWithProgress(title: string, args: string[], context: vscode.ExtensionContext): Promise<boolean> {
  const root = workspaceRoot();
  if (!root) { void vscode.window.showWarningMessage('Repo Wiki: open a workspace folder first.'); return false; }
  if (runner.isActive()) { void vscode.window.showInformationMessage('Repo Wiki: a run is already in progress.'); return false; }
  const config = vscode.workspace.getConfiguration('openRepoWiki');
  const engine = resolveEnginePaths(context.extensionPath, config.get<string>('enginePath') || undefined);
  const node = resolveNodeCommand(config.get<string>('nodePath') || undefined);
  const progressOf = createRunProgress();
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
        outputChannel.appendLine(JSON.stringify(event));
      },
      onLog: line => outputChannel.appendLine(line),
    });
    if (result.code !== 0) {
      void vscode.window.showErrorMessage(
        `Repo Wiki: run failed${result.errorEvent?.code ? ` (${result.errorEvent.code})` : ''}: ${result.errorEvent?.message ?? 'see output'}`,
        'Show output',
      ).then(choice => { if (choice === 'Show output') outputChannel.show(); });
    } else {
      tree.refresh();
      success = true;
    }
  });
  return success;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(outputChannel);

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

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('openRepoWiki.pages', tree),
    vscode.commands.registerCommand('openRepoWiki.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('openRepoWiki.openPage', async (node: TreeNode) => {
      await showPage(node);
    }),
  );
  tree.refresh();

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.showOutput', () => outputChannel.show()));

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', 'openRepoWiki')));

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
