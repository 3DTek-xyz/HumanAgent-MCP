import * as vscode from 'vscode';
import { McpServer } from '../mcp/server';
import { ChatMessage } from '../mcp/types';
import { McpConfigManager } from '../mcp/mcpConfigManager';

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'humanagent-mcp.chatView';

  private _view?: vscode.WebviewView;
  private mcpServer: McpServer;
  private mcpConfigManager?: McpConfigManager;
  private extensionPath: string;
  private messages: ChatMessage[] = [];
  private currentRequestId?: string;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    mcpServer: McpServer,
    mcpConfigManager?: McpConfigManager
  ) {
    this.mcpServer = mcpServer;
    this.mcpConfigManager = mcpConfigManager;
    this.extensionPath = _extensionUri.fsPath;
  }

  public displayHumanAgentMessage(message: string, context?: string, requestId?: string) {
    // Store the current request ID for response handling
    this.currentRequestId = requestId;
    
    // Combine context and message if context exists
    const fullMessage = context ? `${context}\n\n${message}` : message;
    
    // Add AI message to chat
    const aiMessage: ChatMessage = {
      id: Date.now().toString(),
      content: fullMessage,
      sender: 'agent',
      timestamp: new Date(),
      type: 'text'
    };
    
    this.messages.push(aiMessage);
    this.updateWebview();
    
    // Focus the chat webview
    if (this._view) {
      this._view.show?.(true);
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri
      ]
    };

    this.updateWebview();

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          await this.sendHumanResponse(data.content);
          break;
        case 'mcpAction':
          await this.handleMcpAction(data.action);
          break;
        case 'requestServerStatus':
          this.updateServerStatus();
          break;
      }
    });
  }

  private async sendHumanResponse(content: string) {
    try {
      console.log('ChatWebviewProvider: Sending human response:', content);
      
      // Add human message to chat
      const humanMessage: ChatMessage = {
        id: Date.now().toString(),
        content: content,
        sender: 'user',
        timestamp: new Date(),
        type: 'text'
      };
      
      this.messages.push(humanMessage);
      this.updateWebview();

      // Send response back to MCP server
      if (this.currentRequestId) {
        console.log('ChatWebviewProvider: Responding to request ID:', this.currentRequestId);
        this.mcpServer.respondToHumanRequest(this.currentRequestId, content);
        this.currentRequestId = undefined;
      }
    } catch (error) {
      console.error('ChatWebviewProvider: Error in sendHumanResponse:', error);
    }
  }

  public async waitForHumanResponse(): Promise<string> {
    // This method is no longer needed since we use direct callbacks
    throw new Error('waitForHumanResponse is deprecated - use direct response handling');
  }

  private updateWebview() {
    if (this._view) {
      this._view.webview.html = this._getHtmlForWebview(this._view.webview);
    }
  }

  private updateServerStatus() {
    if (!this._view) {
      return;
    }

    const tools = this.mcpServer.getAvailableTools();
    const pendingRequests = this.mcpServer.getPendingRequests();
    const isRegistered = this.mcpConfigManager?.isMcpServerRegistered() ?? false;

    this._view.webview.postMessage({
      type: 'serverStatus',
      data: {
        running: true,
        tools: tools.length,
        pendingRequests: pendingRequests.length,
        registered: isRegistered
      }
    });
  }

  private async handleMcpAction(action: string) {
    try {
      switch (action) {
        case 'start':
          await this.mcpServer.start();
          vscode.window.showInformationMessage('MCP Server started');
          break;
        case 'stop':
          await this.mcpServer.stop();
          vscode.window.showInformationMessage('MCP Server stopped');
          break;
        case 'restart':
          await this.mcpServer.stop();
          await this.mcpServer.start();
          vscode.window.showInformationMessage('MCP Server restarted');
          break;
        case 'register':
          // Use the MCP configuration from the parent command
          vscode.commands.executeCommand('humanagent-mcp.configureMcp');
          break;
        case 'unregister':
          vscode.commands.executeCommand('humanagent-mcp.configureMcp');
          break;
        case 'configure':
          vscode.commands.executeCommand('humanagent-mcp.configureMcp');
          break;
      }
      
      // Update status after action
      this.updateServerStatus();
    } catch (error) {
      vscode.window.showErrorMessage(`MCP action failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const messagesHtml = this.messages.map(message => {
      const messageClass = message.sender === 'agent' ? 'ai-message' : 'human-message';
      const timestamp = message.timestamp.toLocaleTimeString();
      const senderLabel = message.sender === 'agent' ? 'AI' : 'Human';
      return `
        <div class="message ${messageClass}">
          <div class="message-header">
            <span class="sender">${senderLabel}</span>
            <span class="timestamp">${timestamp}</span>
          </div>
          <div class="message-content">${this._escapeHtml(String(message.content || ''))}</div>
        </div>
      `;
    }).join('');

    const hasPendingResponse = this.currentRequestId ? 'waiting' : '';

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>HumanAgent Chat</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            line-height: 1.4;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
          }

          .header {
            padding: 10px;
            border-bottom: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-panel-background);
          }

          .status {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
          }

          .status-indicator {
            display: flex;
            align-items: center;
            gap: 5px;
          }

          .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--vscode-charts-green);
          }

          .control-buttons {
            display: flex;
            gap: 5px;
          }

          .cog-button {
            padding: 4px 8px;
            font-size: 14px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
          }

          .cog-button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }

          .control-button {
            padding: 4px 8px;
            font-size: 11px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
          }

          .control-button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }

          .messages {
            flex: 1;
            overflow-y: auto;
            padding: 10px;
          }

          .message {
            margin-bottom: 15px;
            padding: 10px;
            border-radius: 5px;
            border-left: 3px solid;
          }

          .ai-message {
            background-color: var(--vscode-editor-selectionBackground);
            border-left-color: var(--vscode-charts-blue);
          }

          .human-message {
            background-color: var(--vscode-editor-hoverHighlightBackground);
            border-left-color: var(--vscode-charts-green);
          }

          .message-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 5px;
            font-size: 12px;
            opacity: 0.8;
          }

          .sender {
            font-weight: bold;
          }

          .timestamp {
            font-size: 11px;
          }

          .message-content {
            white-space: pre-wrap;
            word-wrap: break-word;
          }

          .input-area {
            padding: 10px;
            border-top: 1px solid var(--vscode-panel-border);
            background-color: var(--vscode-panel-background);
          }

          .input-container {
            display: flex;
            gap: 5px;
          }

          .message-input {
            flex: 1;
            padding: 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 3px;
            font-family: inherit;
            font-size: inherit;
          }

          .send-button {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
          }

          .send-button:hover {
            background-color: var(--vscode-button-hoverBackground);
          }

          .send-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .waiting-indicator {
            text-align: center;
            padding: 10px;
            font-style: italic;
            color: var(--vscode-descriptionForeground);
          }

          .empty-state {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="status">
            <div class="status-indicator">
              <div class="status-dot"></div>
              <span>HumanAgent MCP Server</span>
            </div>
            <div class="control-buttons">
              <button class="control-button" onclick="requestServerStatus()">Status</button>
              <button class="cog-button" onclick="showConfigMenu()" title="Configure MCP">⚙️</button>
            </div>
          </div>
        </div>

        <div class="messages" id="messages">
          ${messagesHtml || '<div class="empty-state">Waiting for AI messages...</div>'}
          ${hasPendingResponse ? '<div class="waiting-indicator">⏳ Waiting for your response...</div>' : ''}
        </div>

        <div class="input-area">
          <div class="input-container">
            <input type="text" class="message-input" id="messageInput" placeholder="Type your response..." ${hasPendingResponse ? '' : 'disabled'}>
            <button class="send-button" id="sendButton" onclick="sendMessage()" ${hasPendingResponse ? '' : 'disabled'}>Send</button>
          </div>
        </div>

        <script>
          const vscode = acquireVsCodeApi();

          document.getElementById('messageInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          });

          function showConfigMenu() {
            vscode.postMessage({
              type: 'mcpAction',
              action: 'configure'
            });
          }

          function sendMessage() {
            const input = document.getElementById('messageInput');
            const message = input.value.trim();
            
            if (message) {
              vscode.postMessage({
                type: 'sendMessage',
                content: message
              });
              input.value = '';
            }
          }

          function handleMcpAction(action) {
            vscode.postMessage({
              type: 'mcpAction',
              action: action
            });
          }

          function requestServerStatus() {
            vscode.postMessage({
              type: 'requestServerStatus'
            });
          }

          // Auto-scroll to bottom
          const messagesContainer = document.getElementById('messages');
          messagesContainer.scrollTop = messagesContainer.scrollHeight;

          // Listen for server status updates
          window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'serverStatus') {
              // Could update UI with server status if needed
              console.log('Server status:', message.data);
            }
          });
        </script>
      </body>
      </html>
    `;
  }

  private _escapeHtml(text: string): string {
    if (typeof text !== 'string') {
      text = String(text || '');
    }
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
}