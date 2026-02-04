import * as vscode from 'vscode';

export class ChatTreeProvider implements vscode.TreeDataProvider<ChatTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ChatTreeItem | undefined | null | void> = new vscode.EventEmitter<ChatTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ChatTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private hasActiveChat: boolean = false;
  private proxyStatus: { running: boolean; port: number } | undefined;

  constructor() {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  updateActiveChat(isActive: boolean): void {
    this.hasActiveChat = isActive;
    this.refresh();
  }

  updateProxyStatus(status: { running: boolean; port: number } | undefined): void {
    this.proxyStatus = status;
    this.refresh();
  }

  getTreeItem(element: ChatTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChatTreeItem): Thenable<ChatTreeItem[]> {
    if (!element) {
      // Root level - return chat status and proxy status
      const items: ChatTreeItem[] = [];
      
      const chatItem = new ChatTreeItem(
        this.hasActiveChat ? 'HumanAgent Chat (Active)' : 'HumanAgent Chat',
        'chat',
        vscode.TreeItemCollapsibleState.None,
        'chat',
        {
          command: 'humanagent-mcp.openChat',
          title: 'Open Chat',
          arguments: []
        }
      );
      items.push(chatItem);
      
      // Add proxy status item
      if (this.proxyStatus) {
        const proxyLabel = this.proxyStatus.running 
          ? `Proxy (Port ${this.proxyStatus.port})` 
          : 'Proxy (Stopped)';
        const proxyItem = new ChatTreeItem(
          proxyLabel,
          'proxy',
          vscode.TreeItemCollapsibleState.None,
          'proxy',
          undefined
        );
        items.push(proxyItem);
      }
      
      return Promise.resolve(items);
    }
    return Promise.resolve([]);
  }
}

export class ChatTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly itemId: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly command?: vscode.Command
  ) {
    super(label, collapsibleState);
    this.tooltip = `${this.label}`;
    this.description = contextValue === 'chat' ? 'MCP Communication' : '';
  }
}