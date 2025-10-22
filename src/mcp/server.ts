import { EventEmitter } from 'events';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { McpMessage, McpServerConfig, HumanAgentSession, ChatMessage, McpTool, HumanAgentChatToolParams, HumanAgentChatToolResult } from './types';

// File logging utility
class DebugLogger {
  private logPath: string = '';
  private logStream: fs.WriteStream | null = null;
  private logBuffer: string[] = [];

  constructor(workspaceRoot: string = '/Users/benharper/Coding/HumanAgent-MCP') {
    try {
      this.logPath = path.join(workspaceRoot, 'mcp-debug.log');
      console.log(`[LOGGER] Attempting to create log file at: ${this.logPath}`);
      
      // Clear previous log file
      if (fs.existsSync(this.logPath)) {
        fs.unlinkSync(this.logPath);
        console.log(`[LOGGER] Cleared existing log file`);
      }
      
      // Ensure directory exists
      const logDir = path.dirname(this.logPath);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
      this.logStream.on('error', (error) => {
        console.error(`[LOGGER] File stream error:`, error);
      });
      
      this.log('DEBUG', `Debug logging started at ${new Date().toISOString()}`);
      this.log('DEBUG', `Current system time: ${new Date()}`);
      this.log('DEBUG', `Log file: ${this.logPath}`);
      this.log('DEBUG', `Working directory: ${process.cwd()}`);
      console.log(`[LOGGER] Debug logger initialized successfully`);
    } catch (error) {
      console.error(`[LOGGER] Failed to initialize debug logger:`, error);
      this.logStream = null;
    }
  }

  log(level: string, message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [${level}] ${message}${data ? '\n' + JSON.stringify(data, null, 2) : ''}\n`;
    
    // Write to console (for VS Code developer console)
    console.log(`[${level}] ${message}`, data || '');
    
    // Write to file if stream is available
    if (this.logStream) {
      try {
        this.logStream.write(logLine);
      } catch (error) {
        console.error(`[LOGGER] Error writing to log file:`, error);
      }
    } else {
      // Buffer logs if stream not available
      this.logBuffer.push(logLine);
    }
  }

  close(): void {
    try {
      this.log('DEBUG', 'Closing debug logger');
      if (this.logStream) {
        this.logStream.end();
        this.logStream = null;
      }
    } catch (error) {
      console.error(`[LOGGER] Error closing debug logger:`, error);
    }
  }
}

export class McpServer extends EventEmitter {
  private config: McpServerConfig;
  private isRunning: boolean = false;
  private tools: Map<string, McpTool> = new Map();
  private httpServer?: http.Server;
  private port: number = 3737;
  private debugLogger: DebugLogger;
  private pendingHumanRequests: Map<string, {
    resolve: (value: string) => void;
    reject: (error: Error) => void;
    startTime: number;
    params: HumanAgentChatToolParams;
  }> = new Map();

  constructor() {
    super();
    this.debugLogger = new DebugLogger();
    
    this.config = {
      name: 'HumanAgent MCP Server',
      description: 'MCP server for chatting with human agents',
      version: '1.0.0',
      capabilities: {
        chat: true,
        tools: true,
        resources: false
      }
    };
    
    this.debugLogger.log('INFO', 'McpServer initialized');
    this.initializeTools();
  }

  private initializeTools(): void {
    // Define the HumanAgent_Chat tool
    const humanAgentChatTool: McpTool = {
      name: 'HumanAgent_Chat',
      description: 'Allows AI agents to initiate interactive conversations with human agents. The human will receive the message and can respond in real-time through the chat interface.',
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
    
    this.tools.set('HumanAgent_Chat', humanAgentChatTool);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    // Force clear log file on server start
    const logPath = '/Users/benharper/Coding/HumanAgent-MCP/mcp-debug.log';
    try {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
        console.log('[SERVER] Cleared log file on server start');
      }
    } catch (error) {
      console.log('[SERVER] Could not clear log file:', error);
    }

    this.debugLogger.log('INFO', '=== MCP SERVER STARTING ===');
    await this.startHttpServer();
    this.isRunning = true;
    this.emit('server-started', this.config);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      this.debugLogger.log('INFO', 'Stopping MCP server...');
      
      if (this.httpServer) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.debugLogger.log('WARN', 'HTTP server close timeout, forcing closure');
            resolve();
          }, 5000);
          
          this.httpServer!.close((error) => {
            clearTimeout(timeout);
            if (error) {
              this.debugLogger.log('WARN', 'HTTP server close error:', error);
            }
            resolve();
          });
        });
        this.httpServer = undefined;
      }

      // Clear pending requests with proper cancellation
      for (const [requestId, request] of this.pendingHumanRequests.entries()) {
        try {
          request.reject(new Error('Server shutting down'));
        } catch (error) {
          // Ignore rejection errors during shutdown
        }
      }
      this.pendingHumanRequests.clear();

      this.isRunning = false;
      this.debugLogger.close();
      this.emit('server-stopped');
      this.debugLogger.log('INFO', 'MCP server stopped successfully');
    } catch (error) {
      console.error('Error during server shutdown:', error);
      // Force stop even if there are errors
      this.isRunning = false;
      this.httpServer = undefined;
      this.pendingHumanRequests.clear();
      this.debugLogger.close();
    }
  }

  private async startHttpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.debugLogger.log('INFO', `Starting HTTP server on port ${this.port}...`);
        
        this.httpServer = http.createServer((req, res) => {
          this.handleHttpRequest(req, res).catch(error => {
            this.debugLogger.log('ERROR', 'HTTP request handling error:', error);
          });
        });

        this.httpServer.on('error', (error) => {
          this.debugLogger.log('ERROR', 'HTTP server error:', error);
          reject(error);
        });

        this.httpServer.on('close', () => {
          this.debugLogger.log('INFO', 'HTTP server closed');
        });

        this.httpServer.listen(this.port, '127.0.0.1', () => {
          this.debugLogger.log('INFO', `MCP HTTP server running on http://127.0.0.1:${this.port}/mcp`);
          resolve();
        });
      } catch (error) {
        this.debugLogger.log('ERROR', 'Failed to start HTTP server:', error);
        reject(error);
      }
    });
  }

  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.debugLogger.log('HTTP', `${req.method} ${req.url}`);
    this.debugLogger.log('HTTP', 'Request Headers:', req.headers);

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');

    // Handle preflight OPTIONS request
    if (req.method === 'OPTIONS') {
      this.debugLogger.log('HTTP', 'Handling OPTIONS preflight request');
      res.statusCode = 200;
      res.end();
      return;
    }

    // Only handle requests to /mcp endpoint
    if (req.url !== '/mcp') {
      this.debugLogger.log('HTTP', `404 - Invalid endpoint: ${req.url}`);
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    if (req.method === 'POST') {
      this.debugLogger.log('HTTP', 'Handling POST request to /mcp');
      await this.handleHttpPost(req, res);
    } else if (req.method === 'GET') {
      this.debugLogger.log('HTTP', 'Handling GET request to /mcp');
      await this.handleHttpGet(req, res);
    } else if (req.method === 'DELETE') {
      this.debugLogger.log('HTTP', 'Handling DELETE request to /mcp');
      await this.handleHttpDelete(req, res);
    } else {
      this.debugLogger.log('HTTP', `405 - Method not allowed: ${req.method}`);
      res.statusCode = 405;
      res.end('Method Not Allowed');
    }
  }

  private async handleHttpPost(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
        this.debugLogger.log('HTTP', `Received chunk: ${chunk.length} bytes`);
      });

      req.on('end', async () => {
        this.debugLogger.log('HTTP', `Complete request body received (${body.length} bytes)`);
        this.debugLogger.log('HTTP', 'Request Body:', body);
        
        try {
          const message = JSON.parse(body);
          this.debugLogger.log('HTTP', 'Parsed JSON message:', message);
          
          const response = await this.handleMessage(message);
          this.debugLogger.log('HTTP', 'Response from handleMessage:', response);

          if (response) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            const responseJson = JSON.stringify(response);
            this.debugLogger.log('HTTP', `Sending 200 response (${responseJson.length} bytes)`);
            res.end(responseJson);
          } else {
            this.debugLogger.log('HTTP', 'Sending 202 response (no content)');
            res.statusCode = 202;
            res.end();
          }
        } catch (error) {
          this.debugLogger.log('ERROR', 'Error parsing JSON or handling message:', error);
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32700,
              message: 'Parse error',
              data: error instanceof Error ? error.message : String(error)
            }
          }));
        }
      });
    } catch (error) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  }

  private async handleHttpGet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.debugLogger.log('HTTP', 'Setting up SSE stream for GET request');
    
    // Set up Server-Sent Events (SSE) stream
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Send initial connection acknowledgment
    res.write('data: {"type":"connection","status":"established"}\n\n');
    
    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      if (!res.destroyed) {
        res.write('data: {"type":"heartbeat","timestamp":"' + new Date().toISOString() + '"}\n\n');
      } else {
        clearInterval(heartbeat);
      }
    }, 30000); // Send heartbeat every 30 seconds
    
    // Handle client disconnect
    req.on('close', () => {
      this.debugLogger.log('HTTP', 'SSE connection closed');
      clearInterval(heartbeat);
    });
    
    req.on('end', () => {
      this.debugLogger.log('HTTP', 'SSE connection ended');
      clearInterval(heartbeat);
    });
  }

  private async handleHttpDelete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Session termination - could be implemented if needed
    res.statusCode = 405;
    res.end('Method Not Allowed');
  }

  async handleMessage(message: McpMessage): Promise<McpMessage | null> {
    this.debugLogger.log('MCP', 'Handling message:', message);
    
    try {
      switch (message.method) {
        case 'initialize':
          this.debugLogger.log('MCP', 'Processing initialize request');
          return this.handleInitialize(message);
        case 'tools/list':
          this.debugLogger.log('MCP', 'Processing tools/list request');
          return this.handleToolsList(message);
        case 'tools/call':
          this.debugLogger.log('MCP', `Processing tools/call request for tool: ${message.params?.name}`);
          return await this.handleToolCall(message);
        case 'notifications/initialized':
          this.debugLogger.log('MCP', 'Processing notifications/initialized (ignoring)');
          return null;
        default:
          this.debugLogger.log('MCP', `Unknown method: ${message.method}`);
          return {
            id: message.id,
            type: 'response',
            error: {
              code: -32601,
              message: `Method ${message.method} not found`
            }
          };
      }
    } catch (error) {
      return {
        id: message.id,
        type: 'response',
        error: {
          code: -32603,
          message: 'Internal error',
          data: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }

  private handleInitialize(message: McpMessage): McpMessage {
    return {
      id: message.id,
      type: 'response',
      result: {
        protocolVersion: '2024-11-05',
        capabilities: this.config.capabilities,
        serverInfo: {
          name: this.config.name,
          version: this.config.version
        }
      }
    };
  }

  private handleToolsList(message: McpMessage): McpMessage {
    const tools = Array.from(this.tools.values());
    return {
      id: message.id,
      type: 'response',
      result: { tools }
    };
  }

  private async handleToolCall(message: McpMessage): Promise<McpMessage> {
    const { name, arguments: args } = message.params;
    this.debugLogger.log('MCP', `Tool call - name: "${name}"`, { name, args });
    this.debugLogger.log('MCP', 'Available tools:', Array.from(this.tools.keys()));
    
    if (name === 'HumanAgent_Chat') {
      this.debugLogger.log('MCP', 'Executing HumanAgent_Chat tool');
      return await this.handleHumanAgentChatTool(message.id, args);
    }
    
    this.debugLogger.log('MCP', `Tool not found: ${name}`);
    return {
      id: message.id,
      type: 'response',
      error: {
        code: -32601,
        message: `Tool ${name} not found`
      }
    };
  }

  private async handleHumanAgentChatTool(messageId: string, params: HumanAgentChatToolParams): Promise<McpMessage> {
    this.debugLogger.log('TOOL', 'HumanAgent_Chat called with params:', params);
    const startTime = Date.now();
    const timeout = (params.timeout || 300) * 1000; // Convert to milliseconds
    this.debugLogger.log('TOOL', `Using timeout: ${timeout}ms (${timeout/1000}s)`);
    
    // Generate unique request ID for tracking this specific request
    const requestId = `${messageId}-${Date.now()}`;
    this.debugLogger.log('TOOL', `Generated request ID: ${requestId}`);
    
    // Display message directly in chat UI (no sessions needed)  
    const displayMessage = params.context ? `${params.context}\n\n${params.message}` : params.message;
    this.debugLogger.log('TOOL', 'Displaying message in chat UI:', displayMessage);
    
    // Emit event to show message in chat UI immediately
    this.emit('human-agent-request', {
      requestId,
      message: params.message,
      context: params.context,
      priority: params.priority || 'normal',
      timestamp: new Date().toISOString()
    });
    
    // Wait for human response
    return new Promise((resolve) => {
      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        this.pendingHumanRequests.delete(requestId);
        this.debugLogger.log('TOOL', `Request ${requestId} timed out after ${timeout/1000}s`);
        resolve({
          id: messageId,
          type: 'response',
          error: {
            code: -32603,
            message: `Human response timeout after ${params.timeout || 300} seconds`
          }
        });
      }, timeout);
      
      // Store the pending request
      this.pendingHumanRequests.set(requestId, {
        resolve: (response: string) => {
          clearTimeout(timeoutHandle);
          const responseTime = Date.now() - startTime;
          this.debugLogger.log('TOOL', `Request ${requestId} completed with response:`, response);
          
          const result: HumanAgentChatToolResult = {
            content: [{
              type: 'text',
              text: response
            }]
          };
          
          resolve({
            id: messageId,
            type: 'response',
            result
          });
        },
        reject: (error: Error) => {
          clearTimeout(timeoutHandle);
          this.debugLogger.log('TOOL', `Request ${requestId} rejected:`, error);
          resolve({
            id: messageId,
            type: 'response',
            error: {
              code: -32603,
              message: error.message
            }
          });
        },
        startTime,
        params
      });
      
      this.debugLogger.log('TOOL', `Request ${requestId} waiting for human response...`);
    });
  }

  // Method to handle human responses (called by webview)
  public respondToHumanRequest(requestId: string, response: string): boolean {
    this.debugLogger.log('SERVER', `Received human response for request ${requestId}:`, response);
    
    const pendingRequest = this.pendingHumanRequests.get(requestId);
    if (pendingRequest) {
      this.pendingHumanRequests.delete(requestId);
      pendingRequest.resolve(response);
      return true;
    }
    
    this.debugLogger.log('SERVER', `No pending request found for ID: ${requestId}`);
    return false;
  }

  // Simplified API - no sessions needed

  getAvailableTools(): McpTool[] {
    return Array.from(this.tools.values());
  }

  getPendingRequests(): Array<{id: string, params: HumanAgentChatToolParams, startTime: number}> {
    return Array.from(this.pendingHumanRequests.entries()).map(([id, req]) => ({
      id,
      params: req.params,
      startTime: req.startTime
    }));
  }

  // Method to manually resolve a pending request (for testing)
  resolvePendingRequest(requestId: string, response: string): boolean {
    const request = this.pendingHumanRequests.get(requestId);
    if (request) {
      this.pendingHumanRequests.delete(requestId);
      request.resolve(response);
      return true;
    }
    return false;
  }

  isServerRunning(): boolean {
    return this.isRunning;
  }

  getServerUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  getPort(): number {
    return this.port;
  }
}