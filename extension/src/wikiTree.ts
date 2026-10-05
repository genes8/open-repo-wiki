import * as vscode from 'vscode';
import { readCatalog, type Catalog } from './pure/catalog';
import { buildTree, pageUriPath, type TreeNode } from './pure/treeModel';

export class WikiTree implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this.event;
  private catalog: Catalog | null = null;

  constructor(private readonly getRoot: () => string | undefined, private readonly getLanguage: () => string) {}

  private get event(): vscode.Event<TreeNode | undefined | void> { return this.emitter.event; }

  public refresh(): void {
    const root = this.getRoot();
    this.catalog = root ? readCatalog(root, this.getLanguage()) : null;
    this.emitter.fire();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      element.page.title,
      element.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.tooltip = new vscode.MarkdownString(
      `${element.page.path}${element.page.protected ? ' 🔒 (protected)' : ''}${element.page.quality === 'degraded' ? ' ⚠ degraded' : ''}`,
    );
    item.description = element.page.protected ? '🔒' : element.page.quality === 'degraded' ? '⚠' : '';
    item.iconPath = element.page.isLanding ? new vscode.ThemeIcon('layout-sidebar-left') : new vscode.ThemeIcon('book');
    item.contextValue = 'page';
    item.command = {
      command: 'openRepoWiki.openPage',
      title: 'Open Page',
      arguments: [element],
    };
    return item;
  }

  public getChildren(element?: TreeNode): TreeNode[] {
    if (!this.catalog) return [];
    if (!element) return buildTree(this.catalog);
    return element.children;
  }

  public pageFilePath(node: TreeNode): string {
    return pageUriPath(node.page.path, this.getLanguage());
  }
}
