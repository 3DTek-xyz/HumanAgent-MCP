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
  private mcpServer: McpServer;
  private mcpConfigManager?: McpConfigManager;
  private extensionPath: string;
  private messages: ChatMessage[] = [];
  private currentRequestId?: string;
  private notificationSettings = {
    enableSound: true,
    enableFlashing: true
  };

  constructor(
    private readonly _extensionUri: vscode.Uri,
    mcpServer: McpServer,
    mcpConfigManager?: McpConfigManager,
    private readonly workspaceSessionId?: string
  ) {
    this.mcpServer = mcpServer;
    this.mcpConfigManager = mcpConfigManager;
    this.extensionPath = _extensionUri.fsPath;
    this.loadNotificationSettings();
  }

  private loadNotificationSettings() {
    try {
      // Try to load settings from mcp.json
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (workspaceRoot) {
        const mcpConfigPath = `${workspaceRoot}/.vscode/mcp.json`;
        const fs = require('fs');
        if (fs.existsSync(mcpConfigPath)) {
          const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
          // Check if humanagent-mcp server has notifications settings
          if (mcpConfig.servers && mcpConfig.servers['humanagent-mcp'] && mcpConfig.servers['humanagent-mcp'].notifications) {
            const notifications = mcpConfig.servers['humanagent-mcp'].notifications;
            this.notificationSettings = {
              enableSound: notifications.enableSound ?? true,
              enableFlashing: notifications.enableFlashing ?? true
            };
          }
        }
      }
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
    
    this.messages.push(aiMessage);
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
          // Call the dedicated status command from extension.ts
          vscode.commands.executeCommand('humanagent-mcp.showStatus');
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
        const success = this.mcpServer.respondToHumanRequest(this.currentRequestId, content);
        if (success) {
          this.currentRequestId = undefined;
          this.updateWebview(); // Force UI update to clear "waiting" state
        } else {
          console.warn('ChatWebviewProvider: Failed to respond - request may have expired');
        }
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

  private updateServerStatus() {
    if (!this._view) {
      return;
    }

    const tools = this.mcpServer.getAvailableTools();
    const pendingRequests = this.mcpServer.getPendingRequests();
    const isRegisteredWorkspace = this.mcpConfigManager?.isMcpServerRegistered(false) ?? false;
    const isRegisteredGlobal = this.mcpConfigManager?.isMcpServerRegistered(true) ?? false;
    const configType = isRegisteredWorkspace ? 'workspace' : (isRegisteredGlobal ? 'global' : 'none');

    this._view.webview.postMessage({
      type: 'serverStatus',
      data: {
        running: this.mcpServer.isServerRunning(),
        tools: tools.length,
        pendingRequests: pendingRequests.length,
        registered: isRegisteredWorkspace || isRegisteredGlobal,
        configType: configType
      }
    });
  }



  private async reloadOverrideFile() {
    try {
      // Check if we have an active workspace
      if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace is currently open');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders[0];
      const overrideFilePath = path.join(workspaceFolder.uri.fsPath, '.vscode', 'HumanAgentOverride.json');

      // Check if override file exists
      if (!fs.existsSync(overrideFilePath)) {
        vscode.window.showWarningMessage('No HumanAgentOverride.json file found in .vscode directory');
        return;
      }

      // Restart the session to pick up new overrides (ensures fresh tool loading)
      if (this.workspaceSessionId) {
        await this.mcpServer.restartSession(this.workspaceSessionId);
        vscode.window.showInformationMessage('Override file reloaded - session restarted with fresh tools');
      } else {
        await this.mcpServer.reloadOverrides();
        vscode.window.showInformationMessage('Override file reloaded successfully');
      }
      
      // Refresh the webview to update the menu
      if (this._view) {
        this._view.webview.html = this._getHtmlForWebview(this._view.webview);
      }

      console.log('ChatWebviewProvider: Override file reloaded successfully');
      
    } catch (error) {
      console.error('ChatWebviewProvider: Error reloading override file:', error);
      vscode.window.showErrorMessage(`Failed to reload override file: ${error}`);
    }
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

      // Get default tool configuration
      const defaultTool = {
        name: 'HumanAgent_Chat',
        description: 'Initiate real-time interactive conversations with human agents through VS Code chat interface. Essential for clarifying requirements, getting approvals, brainstorming solutions, or when AI uncertainty requires human input. Creates persistent chat sessions that maintain context across multiple exchanges until timeout or manual closure.',
        inputSchema: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'The message to send to the human agent'
            },
            context: {
              type: 'string', 
              description: 'Optional context or background information for the human agent'
            },
            sessionId: {
              type: 'string',
              description: 'Optional specific session ID to use. If not provided, a new session will be created.'
            },
            priority: {
              type: 'string',
              enum: ['low', 'normal', 'high', 'urgent'],
              description: 'Priority level of the request',
              default: 'normal'
            },
            timeout: {
              type: 'number',
              description: 'Timeout in seconds to wait for human response (default: 300)',
              default: 300
            }
          },
          required: ['message']
        }
      };

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
        }
      };

      // Write the file
      fs.writeFileSync(overrideFilePath, JSON.stringify(overrideConfig, null, 2));
      
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
          await this.mcpServer.start();
          vscode.window.showInformationMessage('MCP Server started');
          break;
        case 'stop':
          await this.mcpServer.stop();
          vscode.window.showInformationMessage('MCP Server stopped');
          break;
        case 'restart':
          try {
            await this.mcpServer.stop();
            // Small delay to ensure complete cleanup before restart
            await new Promise(resolve => setTimeout(resolve, 500));
            await this.mcpServer.start();
            vscode.window.showInformationMessage('MCP Server restarted');
          } catch (error) {
            console.error('Error during MCP server restart:', error);
            vscode.window.showErrorMessage('Failed to restart MCP Server');
          }
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
        case 'testSound':
          // Test notification sound by triggering a fake notification
          await this.displayHumanAgentMessage('🔊 Audio test - this is a test notification sound!', 'Testing audio notifications', 'test-audio');
          break;
        case 'overridePrompt':
          await this.createPromptOverrideFile();
          break;
        case 'reloadOverride':
          await this.reloadOverrideFile();
          break;
      }
      
      // Update status after action
      this.updateServerStatus();
    } catch (error) {
      vscode.window.showErrorMessage(`MCP action failed: ${error instanceof Error ? error.message : String(error)}`);
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
          
          // Set global flag for override file existence
          window.overrideFileExists = ${overrideFileExists};
          
          // Audio context for notifications
          let audioContext = null;
          let preloadedAudio = null;
          
          // Initialize audio on first user interaction
          function initAudio() {
            if (!audioContext) {
              try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                // Resume in case it's in suspended state
                if (audioContext.state === 'suspended') {
                  audioContext.resume();
                }
              } catch (error) {
                console.error('Failed to create audio context:', error);
              }
            }
            
            // Pre-load and test audio
            if (!preloadedAudio) {
              try {
                preloadedAudio = new Audio();
                preloadedAudio.src = "data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmMaBSGI0PTVnhY=";
                preloadedAudio.volume = 0.3;
                preloadedAudio.preload = 'auto';
                // Play and immediately pause to establish permission
                preloadedAudio.play().then(() => {
                  preloadedAudio.pause();
                  preloadedAudio.currentTime = 0;
                  console.log('Audio initialized successfully');
                }).catch(e => {
                  console.log('Audio initialization failed:', e);
                  preloadedAudio = null;
                });
              } catch (error) {
                console.error('Failed to create audio element:', error);
              }
            }
          }
          
          // Play notification beep sound
          function playNotificationBeep() {
            try {
              if (preloadedAudio) {
                console.log('Playing preloaded audio');
                preloadedAudio.currentTime = 0;
                preloadedAudio.play().then(() => {
                  console.log('Audio played successfully');
                }).catch(e => {
                  console.log('Preloaded audio play failed:', e);
                  // Try to re-initialize if failed
                  initAudio();
                });
              } else {
                console.log('Audio not initialized - trying to initialize now');
                initAudio();
                // Try Web Audio API fallback
                try {
                  if (audioContext && audioContext.state === 'running') {
                    const oscillator = audioContext.createOscillator();
                    const gainNode = audioContext.createGain();
                    
                    oscillator.connect(gainNode);
                    gainNode.connect(audioContext.destination);
                    
                    oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
                    
                    gainNode.gain.setValueAtTime(0, audioContext.currentTime);
                    gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + 0.01);
                    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);
                    
                    oscillator.start(audioContext.currentTime);
                    oscillator.stop(audioContext.currentTime + 0.2);
                    console.log('Web Audio fallback played');
                  } else {
                    console.log('Web Audio context not available');
                  }
                } catch (e2) {
                  console.error('Fallback audio also failed:', e2);
                }
              }
            } catch (error) {
              console.error('Error playing notification sound:', error);
            }
          }
          
          // Initialize audio on any user interaction
          document.addEventListener('click', initAudio, { once: true });
          document.addEventListener('keypress', initAudio, { once: true });
          document.addEventListener('touchstart', initAudio, { once: true });

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
            const message = input.value.trim();
            
            if (message) {
              vscode.postMessage({
                type: 'sendMessage',
                content: message
              });
              input.value = '';
            }
          }

          // Global variable to store current server status
          let currentServerStatus = null;

          function getDynamicMenuOptions() {
            const options = [];
            
            if (!currentServerStatus) {
              // Default options when status unknown
              const defaultOptions = [
                { text: '📦 Install Globally', action: 'register' },
                { text: '📁 Install in Workspace', action: 'unregister' },
                { text: '📊 Show Status', action: 'requestServerStatus' },
                { text: '🛠️ Override Prompt', action: 'overridePrompt' }
              ];
              
              // Check for override file existence even when status unknown
              if (window.overrideFileExists) {
                defaultOptions.push({ text: '🔄 Reload Override File', action: 'reloadOverride' });
              }
              
              defaultOptions.push({ text: '⚙️ Configure MCP', action: 'configure' });
              return defaultOptions;
            }

            // Dynamic options based on current registration status
            if (currentServerStatus.configType === 'workspace') {
              options.push({ text: '🗑️ Uninstall from Workspace', action: 'unregister' });
              options.push({ text: '📦 Install Globally', action: 'register' });
            } else if (currentServerStatus.configType === 'global') {
              options.push({ text: '📁 Install in Workspace', action: 'register' }); 
              options.push({ text: '🗑️ Uninstall Globally', action: 'unregister' });
            } else {
              // Not installed anywhere
              options.push({ text: '📦 Install Globally', action: 'register' });
              options.push({ text: '📁 Install in Workspace', action: 'unregister' });
            }
            
            options.push({ text: '📊 Show Status', action: 'requestServerStatus' });
            options.push({ text: '🛠️ Override Prompt', action: 'overridePrompt' });
            
            // Check for HumanAgentOverride.json file existence (passed from extension)
            if (window.overrideFileExists) {
              options.push({ text: '🔄 Reload Override File', action: 'reloadOverride' });
            }
            
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
                if (message.data.configType === 'workspace') {
                  statusElement.textContent = 'HumanAgent MCP Server (Workspace)';
                } else if (message.data.configType === 'global') {
                  statusElement.textContent = 'HumanAgent MCP Server (Global)';
                } else {
                  statusElement.textContent = 'HumanAgent MCP Server (Not Configured)';
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
            }
          });
          
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