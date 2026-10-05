import * as vscode from 'vscode';
import * as path from 'node:path';

export interface PreviewPage { path: string; title: string; markdown: string; protected: boolean; quality: 'ok' | 'degraded' }

export class WikiPreview {
  private panel: vscode.WebviewPanel | null = null;

  constructor(private readonly extensionPath: string) {}

  public show(page: PreviewPage, onNavigate: (href: string) => void, onEditSource: (pagePath: string) => void): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('openRepoWiki.preview', 'Repo Wiki Preview', vscode.ViewColumn.Beside, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath, 'dist', 'webview'))],
      });
      this.panel.webview.html = this.buildHtml(this.panel.webview);
      this.panel.webview.onDidReceiveMessage(message => {
        if (!message || typeof message !== 'object') return;
        if (message.command === 'navigate' && typeof message.href === 'string') onNavigate(message.href);
        if (message.command === 'editSource' && typeof message.path === 'string') onEditSource(message.path);
        if (message.command === 'openExternal' && typeof message.href === 'string') {
          void vscode.env.openExternal(vscode.Uri.parse(message.href));
        }
      });
      this.panel.onDidDispose(() => { this.panel = null; });
    } else {
      this.panel.reveal();
    }
    void this.panel.webview.postMessage({ command: 'show', page });
  }

  private buildHtml(webview: vscode.Webview): string {
    const dir = (file: string) => webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionPath, 'dist', 'webview', file)));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:;">
  <link rel="stylesheet" href="${dir('highlight.css')}">
  <link rel="stylesheet" href="${dir('page.css')}">
</head>
<body>
  <header id="topbar"><span id="title"></span><span id="badges"></span><button id="edit-source" type="button">Edit source</button></header>
  <main id="page"></main>
  <script src="${dir('marked.js')}"></script>
  <script src="${dir('highlight.js')}"></script>
  <script src="${dir('mermaid.js')}"></script>
  <script src="${dir('webview.js')}"></script>
</body>
</html>`;
  }
}
