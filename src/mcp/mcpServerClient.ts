import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { EventEmitter } from 'events';
import { HumanAgentSession, ChatMessage, McpTool } from './types';

export class McpServerClient extends EventEmitter {
  private serverProcess: cp.ChildProcess | null = null;
  private isConnected = false;
  private extensionPath: string;
  private pendingRequests = new Map<string, { resolve: Function; reject: Function }>();
  private requestId = 1;

  constructor(extensionPath: string) {
    super();
    this.extensionPath = extensionPath;
  }

  async start(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    try {
      const serverPath = path.join(this.extensionPath, 'dist', 'mcpStandalone.js');
      
      console.log('Starting MCP server client:', serverPath);
      
      this.serverProcess = cp.spawn('node', [serverPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        env: {
          ...process.env,
          NODE_ENV: 'production'
        }
      });

      this.serverProcess.on('spawn', () => {
        console.log('MCP server process spawned for client connection');
        this.isConnected = true;
        this.emit('connected');
      });

      this.serverProcess.on('error', (error) => {
        console.error('MCP server client process error:', error);
        this.isConnected = false;
        this.emit('error', error);
      });

      this.serverProcess.on('exit', (code, signal) => {
        console.log(`MCP server client process exited with code ${code}, signal ${signal}`);
        this.isConnected = false;
        this.emit('disconnected');
      });

      // Handle server responses
      if (this.serverProcess.stdout) {
        this.serverProcess.stdout.on('data', (data) => {
          this.handleServerResponse(data.toString());
        });
      }

      // Give the process a moment to start
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (error) {
      console.error('Failed to start MCP server client:', error);
      this.isConnected = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isConnected || !this.serverProcess) {
      return;
    }

    try {
      console.log('Stopping MCP server client...');
      
      // Try graceful shutdown first
      this.serverProcess.kill('SIGTERM');
      
      // Wait for graceful shutdown
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          // Force kill if graceful shutdown didn't work
          if (this.serverProcess && !this.serverProcess.killed) {
            console.log('Force killing MCP server client process...');
            this.serverProcess.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        if (this.serverProcess) {
          this.serverProcess.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });

      this.isConnected = false;
      this.serverProcess = null;
    } catch (error) {
      console.error('Failed to stop MCP server client:', error);
      throw error;
    }
  }

  private handleServerResponse(data: string): void {
    try {
      const lines = data.trim().split('\n');
      for (const line of lines) {
        if (line.trim()) {
          const response = JSON.parse(line);
          
          if (response.id && this.pendingRequests.has(response.id)) {
            const { resolve, reject } = this.pendingRequests.get(response.id)!;
            this.pendingRequests.delete(response.id);
            
            if (response.error) {
              reject(new Error(response.error.message || 'Server error'));
            } else {
              resolve(response.result);
            }
          } else {
            // Handle server events/notifications
            this.handleServerEvent(response);
          }
        }
      }
    } catch (error) {
      console.error('Failed to parse server response:', error);
    }
  }

  private handleServerEvent(event: any): void {
    // Handle server-sent events (like session updates, new messages, etc.)
    switch (event.method) {
      case 'session/created':
        this.emit('session-created', event.params);
        break;
      case 'message/received':
        this.emit('message-received', event.params);
        break;
      case 'message/sent':
        this.emit('message-sent', event.params);
        break;
      case 'human/awaiting-response':
        this.emit('awaiting-human-response', event.params);
        break;
      case 'server/started':
        console.log('MCP server started:', event.params);
        break;
      default:
        console.log('Unknown server event:', event);
    }
  }

  private async sendRequest(method: string, params?: any): Promise<any> {
    if (!this.isConnected || !this.serverProcess?.stdin) {
      throw new Error('MCP server client not connected');
    }

    const id = (this.requestId++).toString();
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params: params || {}
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      // Set timeout for request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, 10000);

      this.serverProcess!.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  // Public API methods using MCP protocol
  async getAllSessions(): Promise<HumanAgentSession[]> {
    const response = await this.sendRequest('chat/list-sessions', {});
    return response.sessions || [];
  }

  async createSession(name: string): Promise<HumanAgentSession> {
    const response = await this.sendRequest('chat/create-session', { name });
    return response.session;
  }

  async sendMessage(sessionId: string, content: string): Promise<ChatMessage> {
    const response = await this.sendRequest('chat/send', { sessionId, content });
    return response.message;
  }

  async sendToHuman(message: string, context?: string, sessionId?: string): Promise<string> {
    const response = await this.sendRequest('tools/call', {
      name: 'HumanAgent_Chat',
      arguments: { message, context, sessionId }
    });
    return response.result?.response || '';
  }

  async getAvailableTools(): Promise<McpTool[]> {
    const response = await this.sendRequest('tools/list', {});
    return response.tools || [];
  }

  async getPendingRequests(): Promise<any[]> {
    // This would need to be implemented in the server if needed
    return [];
  }

  isServerConnected(): boolean {
    return this.isConnected;
  }

  getServerPid(): number | undefined {
    return this.serverProcess?.pid;
  }
}