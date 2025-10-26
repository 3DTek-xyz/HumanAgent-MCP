import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { McpServer } from '../mcp/server';
import { ChatMessage } from '../mcp/types';
import { McpConfigManager } from '../mcp/mcpConfigManager';
import { AudioNotification } from '../audio/audioNotification';

export class ChatWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'humanagent-mcp.chatView';

  private _view?: vscode.WebviewView;
  private mcpServer: McpServer | null;
  private mcpConfigManager?: McpConfigManager;
  private extensionPath: string;
  // Messages are now loaded dynamically in webview JavaScript
  private currentRequestId?: string;
  private registrationCheckComplete = false;
  private notificationSettings = {
    enableSound: true,
    enableFlashing: true
  };

  constructor(
    private readonly _extensionUri: vscode.Uri,
    mcpServer: McpServer | null,
    mcpConfigManager?: McpConfigManager,
    private readonly workspaceSessionId?: string,
    private readonly context?: vscode.ExtensionContext,
    private readonly mcpProvider?: any
  ) {
    this.mcpServer = mcpServer;
    this.mcpConfigManager = mcpConfigManager;
    this.extensionPath = _extensionUri.fsPath;
    this.loadNotificationSettings();
  }

  private async loadConversationHistory() {
    if (!this.mcpServer || !this.workspaceSessionId) {
      return;
    }

    try {
      // Messages are now loaded dynamically by webview JavaScript
      console.log(`Loading conversation history for session: ${this.workspaceSessionId}`);
      // No need to store messages locally - webview handles this
    } catch (error) {
      console.error('Failed to load conversation history:', error);
    }
  }

  private loadNotificationSettings() {
    try {
      // Load settings from VS Code configuration
      const config = vscode.workspace.getConfiguration('humanagent-mcp');
      this.notificationSettings = {
        enableSound: config.get<boolean>('notifications.enableSound', true),
        enableFlashing: config.get<boolean>('notifications.enableFlashing', true)
      };
    } catch (error) {
      console.error('ChatWebviewProvider: Error loading notification settings:', error);
      // Use defaults on error
    }
  }

  public async displayHumanAgentMessage(message: string, context?: string, requestId?: string) {
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
    
    // AI messages are now handled by SSE events - no need to store locally
    this.updateWebview();
    
    // Play notification sound if enabled
    if (this.notificationSettings.enableSound) {
      await this.playNotificationSound();
    }
    
    // Trigger flashing animation if enabled
    if (this.notificationSettings.enableFlashing) {
      this.triggerFlashingBorder();
    }
    
    // Focus the chat webview
    if (this._view) {
      this._view.show?.(true);
    }
  }

  private async playNotificationSound() {
    try {
      // Play sound using Node.js audio system (bypasses browser restrictions)
      await AudioNotification.playNotificationBeep();
    } catch (error) {
      console.error('ChatWebviewProvider: Error playing notification sound:', error);
    }
  }

  private triggerFlashingBorder() {
    if (this._view) {
      // Send a message to the webview to trigger the flashing animation
      this._view.webview.postMessage({
        type: 'flashBorder'
      });
    }
  }

  public clearPendingRequest() {
    // Clear the request ID when AI is done processing
    this.currentRequestId = undefined;
    this.updateWebview();
  }

  resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, _token: vscode.CancellationToken) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this._extensionUri
      ]
    };

    // Load conversation history from centralized chat manager
    this.loadConversationHistory();
    
    // Only update webview if registration check is complete, otherwise it will be updated when notifyRegistrationComplete is called
    if (this.registrationCheckComplete) {
      this.updateWebview();
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          await this.sendHumanResponse(data.content, data.requestId);
          break;
        case 'mcpAction':
          await this.handleMcpAction(data.action);
          break;
        case 'requestServerStatus':
          // Call the dedicated status command from extension.ts
          vscode.commands.executeCommand('humanagent-mcp.showStatus');
          break;
        case 'playNotificationSound':
          // Play sound from extension side (Node.js) when webview requests it
          if (this.notificationSettings.enableSound) {
            await this.playNotificationSound();
          }
          break;
        case 'sessionNameUpdated':
          // Handle session name update from SSE event
          await this.handleSessionNameUpdate(data.sessionId, data.name);
          break;
      }
    });
  }

  private async sendHumanResponse(content: string, requestId?: string) {
    try {
      console.log('ChatWebviewProvider: Sending human response:', content);
      
      // Don't add to local messages array - let server handle storage and SSE handle updates

      // Send response back to standalone MCP server via HTTP
      const responseRequestId = requestId || this.currentRequestId;
      if (responseRequestId) {
        console.log('ChatWebviewProvider: Responding to request ID:', responseRequestId);
        
        try {
          const response = await fetch('http://localhost:3737/response', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              requestId: responseRequestId,
              response: content,
              source: 'vscode'
            })
          });
          
          if (response.ok) {
            const result = await response.json();
            console.log('ChatWebviewProvider: Response sent successfully:', result);
          } else {
            console.error('ChatWebviewProvider: Failed to send response:', response.status, response.statusText);
          }
        } catch (httpError) {
          console.error('ChatWebviewProvider: HTTP error sending response:', httpError);
        }
        
        this.currentRequestId = undefined;
        this.updateWebview(); // Force UI update to clear "waiting" state
      } else {
        console.warn('ChatWebviewProvider: No pending request to respond to');
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

  public refreshWebview() {
    this.updateWebview();
  }

  public notifyRegistrationComplete() {
    this.registrationCheckComplete = true;
    if (this._view) {
      this.updateWebview();
    }
  }

  private updateServerStatus() {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({
      type: 'serverStatus',
      data: {
        running: true, // Assume standalone server is running if configured
        tools: 1, // Default tool count
        pendingRequests: 0, // Can't get from standalone server easily
        registered: true, // Always true with native provider
        configType: 'native' // Native provider registration
      }
    });
  }

  private async createPromptOverrideFile() {
    try {
      console.log('ChatWebviewProvider: Creating prompt override file...');
      
      // Get current workspace folder
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('No workspace folder found. Open a workspace to create override file.');
        return;
      }

      const vscodeDir = path.join(workspaceFolder.uri.fsPath, '.vscode');
      const overrideFilePath = path.join(vscodeDir, 'HumanAgentOverride.json');

      // Create .vscode directory if it doesn't exist
      if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
      }

      // Check if file already exists
      if (fs.existsSync(overrideFilePath)) {
        const result = await vscode.window.showWarningMessage(
          'Override file already exists. Do you want to overwrite it?',
          'Overwrite', 'Cancel'
        );
        if (result !== 'Overwrite') {
          return;
        }
      }

      // Get current tool configuration from server - NO FALLBACKS!
      const response = await fetch('http://localhost:3737/tools');
      if (!response.ok) {
        throw new Error(`Failed to fetch tools from server: ${response.status}`);
      }
      
      const toolsData = await response.json() as { tools: any[] };
      const defaultTool = toolsData.tools.find((tool: any) => tool.name === 'HumanAgent_Chat');
      if (!defaultTool) {
        throw new Error('HumanAgent_Chat tool not found on server');
      }
      
      console.log('ChatWebviewProvider: Fetched current tool configuration from server');

      // Create example tool with medium detail
      const exampleTool = {
        name: 'example_custom_tool',
        description: 'Brief description of what this tool does and its main purpose. Include key usage notes and important warnings when applicable.',
        inputSchema: {
          type: 'object',
          properties: {
            input_param: {
              type: 'string',
              description: 'What this parameter does and how it should be formatted'
            },
            optional_param: {
              type: 'number',
              description: 'Optional parameter with default behavior explained',
              default: 100
            }
          },
          required: ['input_param']
        }
      };

      // Create override configuration  
      const overrideConfig = {
        version: '1.0.0',
        description: 'HumanAgent MCP Tool Overrides for this workspace. Modify tool configurations below to customize MCP server behavior.',
        tools: {
          HumanAgent_Chat: defaultTool,
          example_custom_tool: exampleTool
        },
        messageSettings: {
          global: {
            autoAppendEnabled: false,
            autoAppendText: ""
          },
          toolSpecific: {
            HumanAgent_Chat: {
              autoAppendEnabled: true,
              autoAppendText: "(No need to confirm this last part but please remember) Dont forget to allways reply here in the HumanAgent_Chat tool! Dont circumevent this tool unless asked explicitly by the user. "
            }
          }
        }
      };

      // Write the file
      fs.writeFileSync(overrideFilePath, JSON.stringify(overrideConfig, null, 2));
      
      // Update webview to reflect that override file now exists
      if (this._view) {
        this._view.webview.postMessage({
          command: 'updateOverrideFileExists',
          exists: true
        });
      }
      
      vscode.window.showInformationMessage(
        `Override file created at ${overrideFilePath}. Modify the tool configuration as needed.`,
        'Open File'
      ).then(selection => {
        if (selection === 'Open File') {
          vscode.window.showTextDocument(vscode.Uri.file(overrideFilePath));
        }
      });

      console.log('ChatWebviewProvider: Override file created successfully');
      
    } catch (error) {
      console.error('ChatWebviewProvider: Error creating override file:', error);
      vscode.window.showErrorMessage(`Failed to create override file: ${error}`);
    }
  }

  private async handleMcpAction(action: string) {
    try {
      switch (action) {
        case 'start':
        case 'stop':
        case 'restart':
          vscode.window.showInformationMessage('MCP Server management not available - using standalone server');
          break;
        case 'register':
        case 'unregister':
          // Registration handled automatically by native provider
          vscode.window.showInformationMessage('HumanAgent MCP registration is handled automatically by the native provider.');
          break;
        case 'configure':
          vscode.commands.executeCommand('humanagent-mcp.configureMcp');
          break;
        case 'testSound':
          // Test notification sound by triggering a fake notification
          await this.displayHumanAgentMessage('🔊 Audio test - this is a test notification sound!', 'Testing audio notifications', 'test-audio');
          break;
        case 'requestServerStatus':
          // Show the same notification popup as the main status command
          vscode.commands.executeCommand('humanagent-mcp.showStatus');
          break;
        case 'overridePrompt':
          await this.createPromptOverrideFile();
          break;
        case 'nameSession':
          await this.nameCurrentSession();
          break;
        case 'openWebView':
          await this.openWebInterface();
          break;
      }
      
      // Update status after action
      this.updateServerStatus();
    } catch (error) {
      vscode.window.showErrorMessage(`MCP action failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async nameCurrentSession() {
    try {
      const sessionId = this.workspaceSessionId;
      if (!sessionId) {
        vscode.window.showErrorMessage('No active session to name.');
        return;
      }

      // Prompt user for session name
      const sessionName = await vscode.window.showInputBox({
        prompt: 'Enter a friendly name for this chat session',
        placeHolder: 'e.g., "Project Debugging", "Feature Discussion"',
        validateInput: (text) => {
          if (!text || text.trim().length === 0) {
            return 'Session name cannot be empty';
          }
          if (text.length > 50) {
            return 'Session name must be 50 characters or less';
          }
          return null;
        }
      });

      if (!sessionName) {
        return; // User cancelled
      }

      // Send session name to server
      const response = await fetch('http://localhost:3737/sessions/name', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sessionId: sessionId,
          name: sessionName.trim()
        })
      });

      if (response.ok) {
        // Persist the session name using the same method as session ID
        if (this.context) {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const workspaceKey = workspaceRoot ? `workspace-${require('crypto').createHash('md5').update(workspaceRoot).digest('hex')}` : 'no-workspace';
          await this.context.globalState.update(`sessionName-${workspaceKey}`, sessionName.trim());
        }
        
        vscode.window.showInformationMessage(`Session named: "${sessionName}"`);
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

    } catch (error) {
      console.error('ChatWebviewProvider: Error naming session:', error);
      vscode.window.showErrorMessage(`Failed to name session: ${error}`);
    }
  }

  private async handleSessionNameUpdate(sessionId: string, name: string) {
    // Handle session name update received via SSE from server
    try {
      console.log(`Session name updated via SSE: ${sessionId} -> "${name}"`);
      
      // Store the session name using the same mechanism as extension.ts
      if (this.context) {
        await this.context.globalState.update(`humanagent-session-name-${sessionId}`, name);
        console.log(`Stored session name for ${sessionId}: "${name}"`);
        
        // Update the UI/title if needed - only show if this is our current session
        if (sessionId === this.workspaceSessionId) {
          vscode.window.showInformationMessage(`Session renamed: "${name}"`);
        }
      }
    } catch (error) {
      console.error('ChatWebviewProvider: Error handling session name update:', error);
    }
  }

  private async openWebInterface() {
    try {
      const webUrl = 'http://localhost:3737/HumanAgent';
      
      // Open in external browser
      await vscode.env.openExternal(vscode.Uri.parse(webUrl));
      
      vscode.window.showInformationMessage('Web interface opened in browser');
      
    } catch (error) {
      console.error('ChatWebviewProvider: Error opening web interface:', error);
      vscode.window.showErrorMessage(`Failed to open web interface: ${error}`);
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // Check if HumanAgentOverride.json exists in workspace
    let overrideFileExists = false;
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
      const workspaceFolder = vscode.workspace.workspaceFolders[0];
      const overrideFilePath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'HumanAgentOverride.json');
      overrideFileExists = fs.existsSync(overrideFilePath);
    }

    // Messages will be loaded dynamically from server via JavaScript
    const messagesHtml = '<div id="messages-loading">Loading conversation history...</div>';

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
            transition: border 0.1s ease-in-out;
          }

          body.flashing {
            border: 3px solid var(--vscode-charts-orange);
            animation: flashBorder 2s ease-in-out;
          }

          @keyframes flashBorder {
            0% { border-color: var(--vscode-charts-orange); }
            25% { border-color: transparent; }
            50% { border-color: var(--vscode-charts-orange); }
            75% { border-color: transparent; }
            100% { border-color: transparent; }
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
              <span id="server-status-text">HumanAgent MCP Server</span>
            </div>
            <div class="control-buttons">
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
          
          // Set session ID and override file flag
          const sessionId = '${this.workspaceSessionId}';
          window.overrideFileExists = ${overrideFileExists};
          
          // Play notification beep sound
          function playNotificationBeep() {
            // Request sound from extension (Node.js side) instead of browser
            try {
              vscode.postMessage({
                type: 'playNotificationSound'
              });
              console.log('Sound notification requested from extension');
            } catch (error) {
              console.error('Failed to request sound notification:', error);
            }
          }
          
          document.getElementById('messageInput').addEventListener('keypress', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          });

          function showConfigMenu() {
            // Create dropdown menu
            const existingMenu = document.getElementById('configMenu');
            if (existingMenu) {
              existingMenu.remove();
              return;
            }
            
            const menu = document.createElement('div');
            menu.id = 'configMenu';
            menu.style.position = 'absolute';
            menu.style.top = '30px';
            menu.style.right = '10px';
            menu.style.background = 'var(--vscode-menu-background)';
            menu.style.border = '1px solid var(--vscode-menu-border)';
            menu.style.borderRadius = '3px';
            menu.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
            menu.style.zIndex = '1000';
            menu.style.minWidth = '150px';
            
            // Get dynamic options based on current status
            const options = getDynamicMenuOptions();
            
            options.forEach(option => {
              const item = document.createElement('div');
              item.textContent = option.text;
              item.style.padding = '8px 12px';
              item.style.cursor = 'pointer';
              item.style.color = 'var(--vscode-menu-foreground)';
              item.onmouseover = () => item.style.background = 'var(--vscode-menu-selectionBackground)';
              item.onmouseout = () => item.style.background = 'transparent';
              item.onclick = () => {
                vscode.postMessage({
                  type: 'mcpAction',
                  action: option.action
                });
                menu.remove();
              };
              menu.appendChild(item);
            });
            
            document.body.appendChild(menu);
            
            // Close menu when clicking elsewhere
            setTimeout(() => {
              document.addEventListener('click', (e) => {
                if (!menu.contains(e.target)) {
                  menu.remove();
                }
              }, { once: true });
            }, 10);
          }

          function sendMessage() {
            const input = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            const message = input.value.trim();
            
            if (message) {
              // Don't add message to DOM - let SSE handle it to avoid duplicates
              
              // Send message to extension
              vscode.postMessage({
                type: 'sendMessage',
                content: message,
                requestId: currentPendingRequestId
              });
              
              // Clear input and disable controls
              input.value = '';
              input.disabled = true;
              sendButton.disabled = true;
              
              // Clear the pending request ID
              currentPendingRequestId = null;
            }
          }

          // Global variable to store current server status
          let currentServerStatus = null;

          function getDynamicMenuOptions() {
            // Simplified menu options (no registration needed with native provider)
            const options = [
              { text: '📊 Show Status', action: 'requestServerStatus' },
              { text: window.overrideFileExists ? '📁 Recreate Override File' : '📁 Create Override File', action: 'overridePrompt' },
              { text: '📝 Name This Chat', action: 'nameSession' },
              { text: '🌐 Open Web View', action: 'openWebView' }
            ];
            
            // Override file changes require VS Code restart/reload to take effect
            
            options.push({ text: '⚙️ Configure MCP', action: 'configure' });
            
            return options;
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

          // Listen for messages from extension
          window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'serverStatus') {
              // Update global status variable
              currentServerStatus = message.data;
              
              // Update status text based on configuration
              const statusElement = document.getElementById('server-status-text');
              if (statusElement && message.data.configType) {
                if (message.data.configType === 'native') {
                  statusElement.textContent = 'HumanAgent MCP Server (Connected)';
                } else {
                  statusElement.textContent = 'HumanAgent MCP Server (Unknown)';
                }
              }
              console.log('Server status:', message.data);
            } else if (message.type === 'flashBorder') {
              // Trigger flashing border animation
              document.body.classList.add('flashing');
              setTimeout(() => {
                document.body.classList.remove('flashing');
              }, 2000);
            } else if (message.type === 'playSound') {
              // Play notification sound
              console.log('Playing notification sound...');
              playNotificationBeep();
            } else if (message.command === 'updateOverrideFileExists') {
              // Update override file existence and refresh cog menu
              window.overrideFileExists = message.exists;
              console.log('Updated overrideFileExists to:', message.exists);
            }
          });

          // Set up SSE connection for real-time server events
          let currentEventSource = null;
          let connectionInProgress = false;
          
          function setupSSEConnection() {
            if (connectionInProgress) {
              console.log('⚠️ SSE connection already in progress, skipping duplicate attempt');
              return;
            }
            
            connectionInProgress = true;
            
            try {
              // Close existing connection if present
              if (currentEventSource && currentEventSource.readyState !== 2) { // 2 = CLOSED
                console.log('🔄 Closing existing EventSource before creating new one');
                currentEventSource.close();
              }
              
              console.log('Setting up SSE connection to MCP server for session:', sessionId);
              const eventSource = new EventSource(\`http://localhost:3737/mcp?sessionId=\${sessionId}\`);
              currentEventSource = eventSource;
              
              // Enhanced connection health monitoring
              let lastHeartbeat = Date.now();
              let heartbeatTimeout = null;
              let messageCount = 0;
              let connectionStartTime = Date.now();
              
              // Monitor heartbeat to detect stale connections
              function resetHeartbeatTimeout() {
                if (heartbeatTimeout) {
                  clearTimeout(heartbeatTimeout);
                }
                heartbeatTimeout = setTimeout(() => {
                  console.error('❌ SSE Connection Analysis:');
                  console.error('  - No heartbeat for 25 seconds, EventSource appears stale');
                  console.error('  - Last heartbeat:', new Date(lastHeartbeat).toISOString());
                  console.error('  - Connection duration:', Math.round((Date.now() - connectionStartTime) / 1000), 'seconds');
                  console.error('  - Messages received:', messageCount);
                  console.error('  - EventSource readyState:', eventSource.readyState);
                  console.error('  - Reconnecting...');
                  eventSource.close();
                  connectionInProgress = false;
                  setTimeout(setupSSEConnection, 1000);
                }, 25000); // Timeout after 25 seconds (2.5x heartbeat interval)
              }
              
              eventSource.onopen = function(event) {
                console.log('✅ SSE connection opened for session:', sessionId);
                console.log('   EventSource readyState:', eventSource.readyState);
                console.log('   Connection time:', new Date().toISOString());
                lastHeartbeat = Date.now();
                connectionStartTime = Date.now();
                messageCount = 0;
                connectionInProgress = false; // Connection successful, allow future connections
                resetHeartbeatTimeout();
              };
              
              eventSource.onmessage = function(event) {
                try {
                  messageCount++;
                  const data = JSON.parse(event.data);
                  
                  // Handle heartbeat for connection monitoring
                  if (data.type === 'heartbeat') {
                    lastHeartbeat = Date.now();
                    resetHeartbeatTimeout();
                    console.log('💓 Heartbeat received at', new Date().toISOString(), '(msg #' + messageCount + ')');
                    return; // Don't log heartbeats further
                  }
                  
                  console.log('📨 SSE event received (msg #' + messageCount + '):', data);
                  
                  if (data.type === 'request-state-change') {
                    handleRequestStateChange(data.data);
                  } else if (data.type === 'chat_message') {
                    handleIncomingChatMessage(data);
                  } else if (data.type === 'session-name-changed') {
                    handleSessionNameChanged(data.data);
                  // Removed web_user_message auto-trigger - no longer needed
                  }
                } catch (error) {
                  console.error('Error parsing SSE data:', error);
                }
              };
              
              eventSource.onerror = function(error) {
                console.error('❌ SSE connection error detected:');
                console.error('   Error object:', error);
                console.error('   EventSource readyState:', eventSource.readyState);
                console.error('   Connection duration:', Math.round((Date.now() - connectionStartTime) / 1000), 'seconds');
                console.error('   Messages received before error:', messageCount);
                console.error('   Last heartbeat:', new Date(lastHeartbeat).toISOString());
                
                if (heartbeatTimeout) {
                  clearTimeout(heartbeatTimeout);
                }
                
                // Log readyState meaning
                const stateNames = ['CONNECTING', 'OPEN', 'CLOSED'];
                console.error('   EventSource state:', stateNames[eventSource.readyState] || 'UNKNOWN');
                
                // Reset connection state and try to reconnect after 5 seconds
                connectionInProgress = false;
                console.log('🔄 Reconnecting SSE in 5 seconds...');
                setTimeout(setupSSEConnection, 5000);
              };
              
            } catch (error) {
              console.error('Failed to setup SSE connection:', error);
              connectionInProgress = false;
            }
          }

          // Global variable to store current request ID for responses
          let currentPendingRequestId = null;

          function handleRequestStateChange(data) {
            console.log('Handling request state change:', data);
            
            const messagesContainer = document.getElementById('messages');
            const messageInput = document.getElementById('messageInput');
            const sendButton = document.getElementById('sendButton');
            
            if (data.state === 'waiting_for_response') {
              // Store the request ID for sending response
              currentPendingRequestId = data.requestId;
              
              // Enable input controls for response
              if (messageInput && sendButton) {
                messageInput.disabled = false;
                sendButton.disabled = false;
                messageInput.focus();
              }
              
              // Add waiting indicator if not present
              if (messagesContainer) {
                const existingWaiting = messagesContainer.querySelector('.waiting-indicator');
                if (!existingWaiting) {
                  const waitingDiv = document.createElement('div');
                  waitingDiv.className = 'waiting-indicator';
                  waitingDiv.textContent = '⏳ Waiting for your response...';
                  messagesContainer.appendChild(waitingDiv);
                }
              }
              
              // Play notification
              playNotificationBeep();
              
              // Flash border
              document.body.classList.add('flashing');
              setTimeout(() => {
                document.body.classList.remove('flashing');
              }, 2000);
              
            } else if (data.state === 'completed') {
              // Clear pending request
              currentPendingRequestId = null;
              
              // Disable input controls
              if (messageInput && sendButton) {
                messageInput.disabled = true;
                sendButton.disabled = true;
              }
              
              // Remove waiting indicator
              if (messagesContainer) {
                const waitingIndicator = messagesContainer.querySelector('.waiting-indicator');
                if (waitingIndicator) {
                  waitingIndicator.remove();
                }
              }
            }
          }

          function handleIncomingChatMessage(data) {
            console.log('Handling incoming chat message:', data);
            
            const message = data.message;
            const messagesContainer = document.getElementById('messages');
            if (messagesContainer) {
              // Remove empty state if it exists
              const emptyState = messagesContainer.querySelector('.empty-state');
              if (emptyState) {
                emptyState.remove();
              }
              
              // Use unified addMessageToUI function
              addMessageToUI(message);
              
              // Play notification for assistant messages
              if (message.sender === 'agent') {
                playNotificationBeep();
              }
            }
          }

          function handleSessionNameChanged(data) {
            console.log('Handling session name change:', data);
            
            // Update the session name display in VS Code interface
            // The data contains: { sessionId, name }
            if (data.sessionId && data.name) {
              // Update window title or header display if needed
              // For VS Code webview, we can send a message to the extension
              vscode.postMessage({
                command: 'sessionNameUpdated',
                sessionId: data.sessionId,
                name: data.name
              });
            }
          }

          // handleWebUserMessage removed - no longer needed for auto-forwarding

          // Load conversation history from server
          async function loadConversationHistory() {
            try {
              const response = await fetch('http://127.0.0.1:3737/sessions/${this.workspaceSessionId}/messages');
              if (response.ok) {
                const data = await response.json();
                const messagesContainer = document.getElementById('messages');
                if (messagesContainer && data.messages) {
                  // Clear loading indicator
                  messagesContainer.innerHTML = '';
                  
                  // Add each message using the same logic as web interface
                  for (const msg of data.messages) {
                    addMessageToUI(msg);
                  }
                  
                  console.log(\`Loaded \${data.messages.length} messages from server\`);
                } else {
                  // Show empty state
                  messagesContainer.innerHTML = '<div class="empty-state">No messages yet. Start a conversation!</div>';
                }
              }
            } catch (error) {
              console.error('Failed to load conversation history:', error);
              document.getElementById('messages').innerHTML = '<div class="error-state">Failed to load conversation history</div>';
            }
          }
          
          // Add message to UI (similar to web interface)
          function addMessageToUI(message) {
            const messagesContainer = document.getElementById('messages');
            if (!messagesContainer) return;
            
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${message.sender === 'user' ? 'human-message' : 'ai-message'}\`;
            
            // Determine sender label based on sender and source
            let senderLabel = 'AI';
            if (message.sender === 'user') {
              if (message.source === 'vscode') {
                senderLabel = 'You (VS Code)';
              } else {
                senderLabel = 'You (Web)';
              }
            }
            
            const timestamp = new Date(message.timestamp).toLocaleTimeString();
            
            messageDiv.innerHTML = \`
              <div class="message-header">
                <span class="sender">\${senderLabel}</span>
                <span class="timestamp">\${timestamp}</span>
              </div>
              <div class="message-content">\${escapeHtml(message.content)}</div>
            \`;
            
            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
          }
          
          // Escape HTML helper function
          function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
          
          // Load conversation history on page load
          loadConversationHistory();
          
          // Initialize SSE connection
          setupSSEConnection();
          
          // Webview initialized - status can be requested manually via cog menu
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