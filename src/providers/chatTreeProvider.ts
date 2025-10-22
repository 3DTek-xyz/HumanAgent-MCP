import * as vscode from 'vscode';

export class ChatTreeProvider implements vscode.TreeDataProvider<ChatTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<ChatTreeItem | undefined | null | void> = new vscode.EventEmitter<ChatTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<ChatTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private hasActiveChat: boolean = false;

  constructor() {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  updateActiveChat(isActive: boolean): void {
    this.hasActiveChat = isActive;
    this.refresh();
  }

  getTreeItem(element: ChatTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChatTreeItem): Thenable<ChatTreeItem[]> {
    if (!element) {
      // Root level - return chat status
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
      return Promise.resolve([chatItem]);
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