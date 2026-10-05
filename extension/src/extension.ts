import * as vscode from 'vscode';
import { EngineRunner } from './engineRunner.js';
import { resolveEnginePaths, resolveNodeCommand } from './enginePaths.js';
import { buildGenerateArgs } from './pure/args.js';
import { createRunProgress } from './pure/progress.js';

const outputChannel = vscode.window.createOutputChannel('Repo Wiki Engine');
const runner = new EngineRunner();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(outputChannel);

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
        // Task 4: tree.refresh()
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
