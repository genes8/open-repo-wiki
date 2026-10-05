import * as vscode from 'vscode';
import * as path from 'node:path';
import { readCatalog } from './pure/catalog';

const DEBOUNCE_MS = 2000;

export class ChangeDetector implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private readonly disposable: vscode.Disposable;

  constructor(
    private readonly getRoot: () => string | undefined,
    private readonly getLanguage: () => string,
    private readonly onChanged: (autoRun: boolean) => void,
  ) {
    this.disposable = vscode.workspace.onDidSaveTextDocument(doc => this.onSave(doc));
  }

  private onSave(doc: vscode.TextDocument): void {
    const root = this.getRoot();
    if (!root || doc.uri.scheme !== 'file') return;
    const rel = path.relative(root, doc.uri.fsPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    // Wiki markdown edits are the protection path (engine handles them); only
    // SOURCE files trigger update hints.
    if (rel.split(path.sep).includes('.local-wiki')) return;
    const catalog = readCatalog(root, this.getLanguage());
    if (!catalog) return;
    const relPosix = rel.split(path.sep).join('/');
    const belongs = catalog.pages.some(page => page.dependent_files.includes(relPosix));
    if (!belongs) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const auto = vscode.workspace.getConfiguration('openRepoWiki').get<string>('autoUpdate') || 'notify';
      if (auto !== 'off') this.onChanged(auto === 'auto');
    }, DEBOUNCE_MS);
  }

  public dispose(): void {
    clearTimeout(this.timer);
    this.disposable.dispose();
  }
}
