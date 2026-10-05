import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { EngineRunner } from './engineRunner.js';
import { resolveEnginePaths, resolveNodeCommand } from './enginePaths.js';
import { buildGenerateArgs } from './pure/args.js';
import { readCatalog } from './pure/catalog.js';
import { createRunProgress } from './pure/progress.js';
import { pageUriPath, resolveHref, type TreeNode } from './pure/treeModel.js';
import { WikiPreview } from './preview.js';
import { WikiTree } from './wikiTree.js';

const outputChannel = vscode.window.createOutputChannel('Repo Wiki Engine');
const runner = new EngineRunner();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(outputChannel);

  const getLanguage = () => vscode.workspace.getConfiguration('openRepoWiki').get<string>('language') || 'en';
  const tree = new WikiTree(workspaceRoot, getLanguage);
  const preview = new WikiPreview(context.extensionPath);
  let currentPagePath = '';

  const showPage = async (page: TreeNode): Promise<void> => {
    const root = workspaceRoot();
    if (!root) return;
    const pageFile = path.join(root, pageUriPath(page.page.path, getLanguage()));
    try {
      const markdown = await fs.readFile(pageFile, 'utf8');
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

  context.subscriptions.push(vscode.commands.registerCommand('openRepoWiki.generate', async () => {
    const repoRoot = workspaceRoot();
    if (!repoRoot) { void vscode.window.showWarningMessage('Repo Wiki: open a workspace folder first.'); return; }
    if (runner.isActive()) { void vscode.window.showInformationMessage('Repo Wiki: a run is already in progress.'); return; }
    const config = vscode.workspace.getConfiguration('openRepoWiki');
    const engine = resolveEnginePaths(context.extensionPath, config.get<string>('enginePath') || undefined);
    const node = resolveNodeCommand(config.get<string>('nodePath') || undefined);
    const args = buildGenerateArgs({
      repoRoot,
      language: config.get<string>('language') || 'en',
      model: config.get<string>('defaultModel') || undefined,
      configPath: config.get<string>('configPath') || undefined,
    });
    const progressOf = createRunProgress();
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Repo Wiki: generating',
      cancellable: true,
    }, async (progress, token) => {
      token.onCancellationRequested(() => runner.cancel());
      progress.report({ message: 'starting engine…', increment: 0 });
      const result = await runner.run(node.command, engine.generateJs, node.prefixArgs, node.env, {
        args,
        cwd: repoRoot,
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
        void vscode.window.showInformationMessage('Repo Wiki: generation finished.');
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
