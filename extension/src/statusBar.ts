import * as vscode from 'vscode';

export class UpdateStatusBar {
  private item: vscode.StatusBarItem;

  constructor(onGenerate: () => void) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.item.text = '$(book) Repo Wiki: update available';
    this.item.tooltip = 'Source files referenced by the wiki changed — regenerate?';
    this.item.command = 'openRepoWiki.generate';
    this.item.hide();
  }

  public show(): void { this.item.show(); }
  public hide(): void { this.item.hide(); }
  public dispose(): void { this.item.dispose(); }
}
