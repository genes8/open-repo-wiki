import * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {
  // Wired up task by task: tree (T4), preview (T5), commands (T3/T6), change detection (T7).
}

export function deactivate(): void {
  // Engine child termination lands in Task 3.
}
