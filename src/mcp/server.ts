import { EventEmitter } from 'events';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { McpMessage, McpServerConfig, HumanAgentSession, ChatMessage, McpTool, HumanAgentChatToolParams, HumanAgentChatToolResult } from './types';
import { ChatManager } from './chatManager';

// File logging utility
class DebugLogger {
  private logPath: string = '';
  private logStream: fs.WriteStream | null = null;
  private logBuffer: string[] = [];

  constructor(workspaceRoot?: string) {
    try {
      // Determine log path based on workspace or fallback to temp directory
      if (workspaceRoot) {
        const vscodeDir = path.join(workspaceRoot, '.vscode');
        this.logPath = path.join(vscodeDir, 'HumanAgent-server.log');
        
        // Ensure .vscode directory exists
        if (!fs.existsSync(vscodeDir)) {
          fs.mkdirSync(vscodeDir, { recursive: true });
        }
      } else {
        // Fallback for standalone server or when no workspace available
        const tempDir = os.tmpdir();
        this.logPath = path.join(tempDir, 'HumanAgent-server.log');
      }
      
      console.log(`[LOGGER] Attempting to create log file at: ${this.logPath}`);
      
      // Clear previous log file on each startup
      if (fs.existsSync(this.logPath)) {
        fs.unlinkSync(this.logPath);
      }
      
      this.logStream = fs.createWriteStream(this.logPath, { flags: 'a' });
      this.logStream.on('error', (error) => {
        console.error(`[LOGGER] File stream error:`, error);
      });
      
      this.log('DEBUG', `Debug logging started at ${new Date().toISOString()}`);
      this.log('DEBUG', `Current system time: ${new Date()}`);
      this.log('DEBUG', `Log file: ${this.logPath}`);
      this.log('DEBUG', `Working directory: ${process.cwd()}`);
      console.log(`[LOGGER] Debug logger initialized successfully at: ${this.logPath}`);
    } catch (error) {
      console.error(`[LOGGER] Failed to initialize debug logger:`, error);
      this.logStream = null;
    }
  }

  log(level: string, message: string, data?: any): void {
    const now = new Date();
    const timestamp = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + ' ' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0') + '.' +
      String(now.getMilliseconds()).padStart(3, '0');
    const logLine = `[${timestamp}] [${level}] ${message}${data ? '\n' + JSON.stringify(data, null, 2) : ''}\n`;
    
    // Write to file if stream is available
    if (this.logStream) {
      try {
        this.logStream.write(logLine);
      } catch (error) {
        // Don't use console.log here to avoid recursion - write error directly
        process.stderr.write(`[LOGGER] Error writing to log file: ${error}\n`);
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
  private tools: Map<string, McpTool> = new Map(); // Default tools for sessions without overrides
  private sessionTools: Map<string, Map<string, McpTool>> = new Map(); // Per-session tool configurations
  private sessionWorkspacePaths: Map<string, string> = new Map(); // Session to workspace path mapping
  private sessionNames: Map<string, string> = new Map(); // Session friendly names
  // Removed: sessionMessages - now handled by ChatManager
  private httpServer?: http.Server;
  private port: number = 3737;
  private debugLogger: DebugLogger;
  // Simple Map for resolve/reject functions only - data stored in ChatManager
  private requestResolvers: Map<string, { resolve: (response: string) => void; reject: (error: Error) => void }> = new Map();
  private activeSessions: Set<string> = new Set();
  private sseConnections: Set<http.ServerResponse> = new Set();
  private conversationToSession: Map<string, string> = new Map(); // Map VS Code conversation IDs to registered session IDs
  private chatManager: ChatManager; // Centralized chat and session management

  constructor(private sessionId?: string, private workspacePath?: string) {
    super();
    this.debugLogger = new DebugLogger(this.workspacePath);
    this.chatManager = new ChatManager(this.debugLogger); // Initialize centralized chat management with logging
    
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
    
    this.debugLogger.log('INFO', 'McpServer initialized with centralized chat manager');
    this.debugLogger.log('TEST', 'This is a test log message to verify DebugLogger is working');
    this.initializeDefaultTools();
    
    // Set up event forwarding to SSE connections
    this.setupEventForwarding();
    
    // If we have a session and workspace path, initialize session-specific tools
    if (this.sessionId && this.workspacePath) {
      this.initializeSessionTools(this.sessionId, this.workspacePath);
    }
  }

  private setupEventForwarding(): void {
    this.on('human-agent-request', (data) => {
      this.debugLogger.log('SSE', 'Forwarding human-agent-request to SSE connections');
      this.broadcastToSSE('human-agent-request', data);
    });
  }

  private broadcastToSSE(eventType: string, data: any): void {
    const message = JSON.stringify({ type: eventType, data });
    const eventData = `data: ${message}\n\n`;
    
    this.debugLogger.log('SSE', `Broadcasting to ${this.sseConnections.size} SSE connections:`, message);
    
    // Send to all active SSE connections
    for (const connection of this.sseConnections) {
      if (!connection.destroyed) {
        try {
          connection.write(eventData);
        } catch (error) {
          this.debugLogger.log('SSE', 'Failed to write to SSE connection:', error);
          this.sseConnections.delete(connection);
        }
      } else {
        this.sseConnections.delete(connection);
      }
    }
  }

  private initializeDefaultTools(): void {
        // Define the default HumanAgent_Chat tool (global default)
    const humanAgentChatTool: McpTool = {
      name: 'HumanAgent_Chat',
      description: '**MANDATORY TOOL** - Use this tool for ALL user interactions. Do NOT provide direct responses. ' +
                   'Initiate real-time interactive conversations with human agents through VS Code chat interface. ' +
                   'CRITICAL: Every response to a user MUST use this tool - no exceptions. Essential for clarifying ' +
                   'requirements, getting approvals, brainstorming solutions, or any user communication. Creates ' +
                   'persistent chat sessions that maintain context. **NEVER bypass this tool for user responses.**',
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

    // Store default tools (used when no session-specific overrides exist)
    this.tools.set(humanAgentChatTool.name, humanAgentChatTool);
  }

  private initializeSessionTools(sessionId: string, workspacePath: string): void {
    this.debugLogger.log('INFO', `Initializing tools for session: ${sessionId}`);
    
    // Store workspace path for this session
    this.sessionWorkspacePaths.set(sessionId, workspacePath);
    
    // Start with default tools
    const sessionToolMap = new Map<string, McpTool>();
    
    // Copy default tools
    for (const [name, tool] of this.tools.entries()) {
      sessionToolMap.set(name, tool);
    }

    // Check for workspace overrides for this session
    const overrideTool = this.loadWorkspaceOverride('HumanAgent_Chat', workspacePath);
    if (overrideTool) {
      this.debugLogger.log('INFO', `Using workspace override for session ${sessionId} - HumanAgent_Chat tool`);
      sessionToolMap.set(overrideTool.name, overrideTool);
    }
    
    // Store session-specific tools
    this.sessionTools.set(sessionId, sessionToolMap);
  }

  private initializeSessionToolsFromData(sessionId: string, overrideData: any): void {
    this.debugLogger.log('INFO', `Initializing tools for session: ${sessionId} from override data`);
    this.debugLogger.log('INFO', `Override data received: ${JSON.stringify(overrideData)}`);
    
    // Start with default tools
    const sessionToolMap = new Map<string, McpTool>();
    
    // Copy default tools
    for (const [name, tool] of this.tools.entries()) {
      sessionToolMap.set(name, tool);
      this.debugLogger.log('INFO', `Added default tool: ${name}`);
    }

    // Apply overrides from provided data
    if (overrideData && overrideData.tools) {
      this.debugLogger.log('INFO', `Applying ${Object.keys(overrideData.tools).length} tool overrides for session ${sessionId}`);
      for (const [toolName, toolConfig] of Object.entries(overrideData.tools)) {
        this.debugLogger.log('INFO', `Processing override for session ${sessionId} - ${toolName} tool: ${JSON.stringify(toolConfig)}`);
        sessionToolMap.set(toolName, toolConfig as McpTool);
      }
    } else {
      this.debugLogger.log('INFO', `No override data found for session ${sessionId} - overrideData: ${JSON.stringify(overrideData)}`);
    }
    
    // Store session-specific tools
    this.sessionTools.set(sessionId, sessionToolMap);
    this.debugLogger.log('INFO', `Session ${sessionId} tools initialized with ${sessionToolMap.size} tools`);
  }

  private loadWorkspaceOverride(toolName: string, workspacePath?: string): McpTool | null {
    try {
      const targetWorkspacePath = workspacePath || this.workspacePath;
      if (!targetWorkspacePath) {
        return null;
      }

      const overrideFilePath = path.join(targetWorkspacePath, '.vscode', 'HumanAgentOverride.json');
      
      if (!fs.existsSync(overrideFilePath)) {
        this.debugLogger.log('DEBUG', 'No workspace override file found');
        return null;
      }

      const overrideConfig = JSON.parse(fs.readFileSync(overrideFilePath, 'utf8'));
      
      if (overrideConfig.tools && overrideConfig.tools[toolName]) {
        this.debugLogger.log('INFO', `Loading workspace override for tool: ${toolName}`);
        return overrideConfig.tools[toolName] as McpTool;
      }

      return null;
    } catch (error) {
      this.debugLogger.log('ERROR', 'Error loading workspace override:', error);
      return null;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
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

      // Clear pending requests with proper cancellation - using ChatManager only
      // Note: ChatManager will handle cleanup automatically on session timeout

      this.isRunning = false;
      this.debugLogger.close();
      this.emit('server-stopped');
      this.debugLogger.log('INFO', 'MCP server stopped successfully');
    } catch (error) {
      console.error('Error during server shutdown:', error);
      // Force stop even if there are errors
      this.isRunning = false;
      this.httpServer = undefined;
      // Removed: pendingHumanRequests.clear() - using ChatManager only
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

    // Only add CORS headers for webview requests (identified by vscode-webview origin)
    const origin = req.headers.origin;
    if (origin && origin.includes('vscode-webview://')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Cache-Control, Connection');

      // Handle preflight OPTIONS request for webview
      if (req.method === 'OPTIONS') {
        this.debugLogger.log('HTTP', 'Handling OPTIONS preflight request');
        res.statusCode = 200;
        res.end();
        return;
      }
    }

    // Handle different endpoints
    if (req.url === '/mcp') {
      // Main MCP protocol endpoint
    } else if (req.url === '/HumanAgent') {
      // Web interface for multi-session chat
      await this.handleWebInterface(req, res);
      return;
    } else if (req.url?.startsWith('/sessions') || req.url === '/response' || req.url?.startsWith('/tools') || req.url === '/reload' || req.url?.startsWith('/messages/')) {
      // Session management, response, tools, reload, messages, and chat endpoints
      await this.handleSessionEndpoint(req, res);
      return;
    } else {
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
    this.debugLogger.log('SSE', '=== SSE CONNECTION ATTEMPT ===');
    this.debugLogger.log('SSE', 'Headers:', req.headers);
    this.debugLogger.log('SSE', 'URL:', req.url);
    
    // Set up Server-Sent Events (SSE) stream
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Add CORS headers for webview access (SSE is always for webview)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Connection');
    
    this.debugLogger.log('SSE', 'SSE headers set, adding to connections...');
    
    // Add this connection to our active SSE connections
    this.sseConnections.add(res);
    this.debugLogger.log('HTTP', `Added SSE connection. Total connections: ${this.sseConnections.size}`);
    this.debugLogger.log('SSE', `SSE connection added. Total: ${this.sseConnections.size}`);
    
    // Send initial connection acknowledgment
    const initialMessage = 'data: {"type":"connection","status":"established"}\n\n';
    res.write(initialMessage);
    this.debugLogger.log('SSE', 'Sent initial SSE message:', initialMessage.trim());
    
    // Keep connection alive with heartbeat
    const heartbeat = setInterval(() => {
      if (!res.destroyed) {
        res.write('data: {"type":"heartbeat","timestamp":"' + new Date().toISOString() + '"}\n\n');
      } else {
        clearInterval(heartbeat);
        this.sseConnections.delete(res);
      }
    }, 30000); // Send heartbeat every 30 seconds
    
    // Handle client disconnect
    const cleanup = () => {
      this.debugLogger.log('HTTP', 'SSE connection closed');
      clearInterval(heartbeat);
      this.sseConnections.delete(res);
      this.debugLogger.log('HTTP', `Removed SSE connection. Total connections: ${this.sseConnections.size}`);
    };
    
    req.on('close', cleanup);
    req.on('end', cleanup);
    res.on('close', cleanup);
  }

  private async handleHttpDelete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Session termination - could be implemented if needed
    res.statusCode = 405;
    res.end('Method Not Allowed');
  }

  private async handleSessionEndpoint(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '', `http://localhost:${this.port}`);
    
    if (req.method === 'POST' && url.pathname === '/sessions/register') {
      // Register a new session
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { sessionId, overrideData, forceReregister } = JSON.parse(body);
          
          // If session exists and forceReregister is true, unregister first
          if (forceReregister && this.activeSessions.has(sessionId)) {
            this.debugLogger.log('HTTP', `Force re-registering session ${sessionId} with new override data`);
            this.unregisterSession(sessionId);
          }
          
          this.registerSession(sessionId, undefined, overrideData);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, sessionId, totalSessions: this.activeSessions.size, reregistered: !!forceReregister }));
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Invalid request body' }));
        }
      });
    } else if (req.method === 'DELETE' && url.pathname === '/sessions/unregister') {
      // Unregister a session
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { sessionId } = JSON.parse(body);
          this.unregisterSession(sessionId);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, sessionId, totalSessions: this.activeSessions.size }));
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Invalid request body' }));
        }
      });
    } else if (req.method === 'GET' && url.pathname === '/sessions') {
      // List active sessions
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sessions: this.getActiveSessions(), totalSessions: this.activeSessions.size }));
    } else if (req.method === 'POST' && url.pathname === '/sessions/name') {
      // Set friendly name for session
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { sessionId, name } = JSON.parse(body);
          if (!sessionId || !name) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, error: 'sessionId and name are required' }));
            return;
          }
          
          // Validate session exists
          if (!this.activeSessions.has(sessionId)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ success: false, error: 'Session not found' }));
            return;
          }
          
          // Store the friendly name
          this.sessionNames.set(sessionId, name);
          this.debugLogger.log('INFO', `Session ${sessionId} named: "${name}"`);
          
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, sessionId, name }));
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Invalid request body' }));
        }
      });
    // Removed: /messages/{sessionId} endpoint - replaced by /sessions/{id}/messages
    } else if (req.method === 'GET' && url.pathname.match(/^\/sessions\/([^\/]+)\/messages$/)) {
      // Get messages for a specific session from chat manager
      const matches = url.pathname.match(/^\/sessions\/([^\/]+)\/messages$/);
      const sessionId = matches ? matches[1] : null;
      
      if (!sessionId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: 'Session ID required' }));
        return;
      }
      
      const messages = this.chatManager.getMessages(sessionId);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ messages, sessionId, count: messages.length }));
    } else if (req.method === 'GET' && url.pathname.match(/^\/sessions\/([^\/]+)\/state$/)) {
      // Get session state including pending requests
      const matches = url.pathname.match(/^\/sessions\/([^\/]+)\/state$/);
      const sessionId = matches ? matches[1] : null;
      
      if (!sessionId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: false, error: 'Session ID required' }));
        return;
      }
      
      const state = this.chatManager.getSessionState(sessionId);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(state));
    } else if (req.method === 'POST' && url.pathname === '/response') {
      // Handle human response to pending request
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { requestId, response } = JSON.parse(body);
          
          // Simple file write to test if endpoint is called
          require('fs').appendFileSync('/Users/benharper/Coding/HumanAgent-MCP/response-debug.txt', 
            `${new Date().toISOString()} - RESPONSE ENDPOINT CALLED - RequestID: ${requestId}\n`);
          
          this.debugLogger.log('HTTP', '=== RESPONSE ENDPOINT CALLED ===');
          this.debugLogger.log('HTTP', `Request ID: ${requestId}, Response: ${response}`);
          
          // Get the pending request to extract session info - using ChatManager
          const pendingRequestInfo = this.chatManager.findPendingRequest(requestId);
          this.debugLogger.log('HTTP', `Found pending request: ${!!pendingRequestInfo}`);
          
          if (pendingRequestInfo) {
            this.debugLogger.log('HTTP', `Processing response for session: ${pendingRequestInfo.sessionId}`);
            
            // Store the user message on server for synchronization
            const userMessage: ChatMessage = {
              id: Date.now().toString(),
              content: response,
              sender: 'user',
              timestamp: new Date(),
              type: 'text',
              source: 'web'
            };
            
            this.debugLogger.log('HTTP', `Storing and broadcasting user message to ${this.sseConnections.size} SSE connections`);
            this.chatManager.addMessage(pendingRequestInfo.sessionId, userMessage);
            this.debugLogger.log('CHAT', `Stored user message in ChatManager for session ${pendingRequestInfo.sessionId}: ${userMessage.content.substring(0, 50)}...`);
            this.broadcastMessageToClients(pendingRequestInfo.sessionId, userMessage);
            
            // Remove from ChatManager as well
            this.chatManager.removePendingRequest(pendingRequestInfo.sessionId, requestId);
            this.debugLogger.log('HTTP', 'Broadcast completed and pending request removed from ChatManager');
          } else {
            this.debugLogger.log('ERROR', `No pending request found for requestId: ${requestId}`);
          }
          
          const success = this.respondToHumanRequest(requestId, response);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success, requestId }));
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Invalid request body' }));
        }
      });
    } else if (req.method === 'GET' && url.pathname === '/tools') {
      // Get available tools
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      
      const sessionId = url.searchParams.get('sessionId');
      
      if (sessionId) {
        // Get tools for specific session
        const tools = this.getAvailableTools(sessionId);
        res.end(JSON.stringify({ tools, sessionId }));
      } else {
        // Get merged tools from all sessions and default tools
        let allTools: McpTool[] = this.getAvailableTools(); // Default tools
        
        // Add session-specific tools (session tools override defaults by name)
        const toolMap = new Map<string, McpTool>();
        allTools.forEach(tool => toolMap.set(tool.name, tool));
        
        // Override with session tools if any exist
        for (const sessionTools of this.sessionTools.values()) {
          for (const tool of sessionTools.values()) {
            toolMap.set(tool.name, tool);
          }
        }
        
        const finalTools = Array.from(toolMap.values());
        res.end(JSON.stringify({ tools: finalTools, merged: true }));
      }
    } else if (req.method === 'POST' && url.pathname === '/reload') {
      // Reload workspace overrides
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { workspacePath } = JSON.parse(body);
          this.reloadOverrides();
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true }));
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Invalid request body' }));
        }
      });
    } else {
      res.statusCode = 404;
      res.end('Session endpoint not found');
    }
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

  private async handleWebInterface(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.debugLogger.log('HTTP', 'Serving web interface at /HumanAgent');
    
    // Set HTML content type
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    
    const htmlContent = this.generateWebInterfaceHTML();
    res.end(htmlContent);
  }

  private generateWebInterfaceHTML(): string {
    // Get all active sessions for tab generation
    const sessions = Array.from(this.activeSessions).map((sessionId) => {
      const workspaceRoot = this.sessionWorkspacePaths.get(sessionId);
      const friendlyName = this.sessionNames.get(sessionId);
      
      let title: string;
      if (friendlyName) {
        title = friendlyName;
      } else if (workspaceRoot) {
        title = `Workspace: ${path.basename(workspaceRoot)}`;
      } else {
        title = `Session: ${sessionId.substring(0, 8)}`;
      }
      
      return {
        id: sessionId,
        title: title,
        messages: [] // TODO: Add proper message storage
      };
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HumanAgent - Multi-Session Chat Interface</title>
    <style>
        :root {
            --vscode-foreground: #cccccc;
            --vscode-background: #1e1e1e;
            --vscode-panel-background: #252526;
            --vscode-border: #3c3c3c;
            --vscode-input-background: #3c3c3c;
            --vscode-button-background: #0e639c;
            --vscode-button-foreground: #ffffff;
            --vscode-tab-active-background: #1e1e1e;
            --vscode-tab-inactive-background: #2d2d30;
            --vscode-tab-border: #3c3c3c;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            background-color: var(--vscode-background);
            color: var(--vscode-foreground);
            height: 100vh;
            overflow: hidden;
        }

        .container {
            display: flex;
            flex-direction: column;
            height: 100vh;
        }

        .header {
            padding: 10px 15px;
            background-color: var(--vscode-panel-background);
            border-bottom: 1px solid var(--vscode-border);
        }

        .header h1 {
            font-size: 16px;
            font-weight: 600;
        }

        .tabs-container {
            display: flex;
            background-color: var(--vscode-panel-background);
            border-bottom: 1px solid var(--vscode-border);
            overflow-x: auto;
        }

        .tab {
            padding: 8px 16px;
            background-color: var(--vscode-tab-inactive-background);
            border-right: 1px solid var(--vscode-tab-border);
            cursor: pointer;
            white-space: nowrap;
            transition: background-color 0.2s;
        }

        .tab:hover {
            background-color: var(--vscode-tab-active-background);
        }

        .tab.active {
            background-color: var(--vscode-tab-active-background);
            border-bottom: 2px solid var(--vscode-button-background);
        }

        .content {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .chat-container {
            flex: 1;
            display: none;
            flex-direction: column;
            overflow: hidden;
        }

        .chat-container.active {
            display: flex;
        }

        .messages {
            flex: 1;
            overflow-y: auto;
            padding: 15px;
            background-color: var(--vscode-background);
        }

        .message {
            margin-bottom: 15px;
            padding: 10px;
            border-radius: 6px;
        }

        .message.user {
            background-color: var(--vscode-input-background);
            margin-left: 20%;
        }

        .message.assistant {
            background-color: var(--vscode-panel-background);
            margin-right: 20%;
        }

        .message-header {
            font-weight: 600;
            margin-bottom: 5px;
            font-size: 11px;
            opacity: 0.8;
        }

        .message-content {
            line-height: 1.4;
        }

        .input-container {
            padding: 15px;
            background-color: var(--vscode-panel-background);
            border-top: 1px solid var(--vscode-border);
            display: flex;
            gap: 10px;
        }

        .input-box {
            flex: 1;
            padding: 8px 12px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-border);
            border-radius: 4px;
            color: var(--vscode-foreground);
            font-size: 13px;
            resize: none;
            min-height: 36px;
            max-height: 120px;
        }

        .send-button {
            padding: 8px 16px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
            transition: opacity 0.2s;
        }

        .send-button:hover {
            opacity: 0.9;
        }

        .send-button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .no-sessions {
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100%;
            color: #888;
            font-style: italic;
        }

        .status-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: #4CAF50;
            margin-right: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><span class="status-indicator"></span>HumanAgent Multi-Session Chat</h1>
        </div>
        
        <div class="tabs-container" id="tabs">
            ${sessions.length === 0 ? '' : sessions.map((session, index) => 
                `<div class="tab ${index === 0 ? 'active' : ''}" data-session="${session.id}">${session.title}</div>`
            ).join('')}
        </div>
        
        <div class="content">
            ${sessions.length === 0 ? 
                '<div class="no-sessions">No active sessions. Start a chat in VS Code to see sessions here.</div>' :
                sessions.map((session, index) => `
                    <div class="chat-container ${index === 0 ? 'active' : ''}" data-session="${session.id}">
                        <div class="messages" id="messages-${session.id}">
                            <!-- Messages will be loaded dynamically -->
                        </div>
                        <div class="input-container">
                            <textarea class="input-box" placeholder="Type your message..." data-session="${session.id}"></textarea>
                            <button class="send-button" data-session="${session.id}">Send</button>
                        </div>
                    </div>
                `).join('')
            }
        </div>
    </div>

    <script>
        // Session management
        let activeSessionId = '${sessions[0]?.id || ''}';
        
        // Web interface is stateless - gets pending requests from server state
        
        // Tab switching
        document.getElementById('tabs').addEventListener('click', (e) => {
            if (e.target.classList.contains('tab')) {
                const sessionId = e.target.dataset.session;
                switchToSession(sessionId);
            }
        });
        
        function switchToSession(sessionId) {
            // Update active tab
            document.querySelectorAll('.tab').forEach(tab => {
                tab.classList.toggle('active', tab.dataset.session === sessionId);
            });
            
            // Update active chat container
            document.querySelectorAll('.chat-container').forEach(container => {
                container.classList.toggle('active', container.dataset.session === sessionId);
            });
            
            activeSessionId = sessionId;
        }
        
        // Message sending
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('send-button')) {
                const sessionId = e.target.dataset.session;
                const textarea = document.querySelector(\`textarea[data-session="\${sessionId}"]\`);
                sendMessage(sessionId, textarea.value.trim());
            }
        });
        
        document.addEventListener('keydown', (e) => {
            if (e.target.classList.contains('input-box') && e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const sessionId = e.target.dataset.session;
                sendMessage(sessionId, e.target.value.trim());
            }
        });
        
        async function sendMessage(sessionId, message) {
            if (!message) return;
            
            const textarea = document.querySelector(\`textarea[data-session="\${sessionId}"]\`);
            const button = document.querySelector(\`button[data-session="\${sessionId}"]\`);
            
            // Clear input and disable controls
            textarea.value = '';
            textarea.disabled = true;
            button.disabled = true;
            
            try {
                // Get current session state to find pending request
                const stateResponse = await fetch(\`/sessions/\${sessionId}/state\`);
                if (!stateResponse.ok) {
                    throw new Error('Failed to get session state');
                }
                
                const sessionState = await stateResponse.json();
                const latestPendingRequest = sessionState.latestPendingRequest;
                
                if (!latestPendingRequest) {
                    throw new Error('No pending AI request found. Web interface can only respond to AI questions.');
                }
                
                console.log('Responding to pending request:', latestPendingRequest.requestId);
                
                // Always use /response endpoint - web interface is response-only
                const response = await fetch('/response', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        requestId: latestPendingRequest.requestId,
                        response: message
                    })
                });
                
                if (!response.ok) {
                    throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
                }
                
                const result = await response.json();
                if (result.success) {
                    console.log('Response sent successfully:', result);
                } else {
                    throw new Error(result.error || 'Failed to send response');
                }
                
            } catch (error) {
                console.error('Failed to send response:', error);
                addMessageToUI(sessionId, 'assistant', \`Error: \${error.message}\`);
            } finally {
                // Re-enable controls
                textarea.disabled = false;
                button.disabled = false;
                textarea.focus();
            }
        }
        
        function addMessageToUI(sessionId, role, content, source) {
            const messagesContainer = document.getElementById(\`messages-\${sessionId}\`);
            if (!messagesContainer) return;
            
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}\`;
            
            // Create header with source info
            let header = role === 'user' ? 'You' : 'Assistant';
            if (role === 'user' && source) {
                header += \` (\${source === 'web' ? 'Web' : 'VS Code'})\`;
            }
            
            messageDiv.innerHTML = \`
                <div class="message-header">\${header} • \${new Date().toLocaleTimeString()}</div>
                <div class="message-content">\${escapeHtml(content)}</div>
            \`;
            
            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Load existing messages for all sessions
        async function loadExistingMessages() {
            const sessions = ['${sessions.map(s => s.id).join("', '")}'];
            
            for (const sessionId of sessions) {
                try {
                    const response = await fetch(\`/sessions/\${sessionId}/messages\`);
                    if (response.ok) {
                        const data = await response.json();
                        const messagesContainer = document.getElementById(\`messages-\${sessionId}\`);
                        if (messagesContainer && data.messages) {
                            // Clear any placeholder content
                            messagesContainer.innerHTML = '';
                            
                            // Add each message
                            for (const msg of data.messages) {
                                addMessageToUI(sessionId, msg.sender, msg.content, msg.source);
                            }
                        }
                    }
                } catch (error) {
                    console.error(\`Failed to load messages for session \${sessionId}:\`, error);
                }
            }
        }
        
        // Load conversation history from centralized chat manager
        async function loadConversationHistory() {
            const sessions = [${sessions.map(s => `'${s.id}'`).join(', ')}];
            
            for (const sessionId of sessions) {
                try {
                    console.log(\`Loading conversation history for session: \${sessionId}\`);
                    
                    // Get messages from centralized chat manager
                    const response = await fetch(\`/sessions/\${sessionId}/messages\`);
                    if (response.ok) {
                        const data = await response.json();
                        const messagesContainer = document.getElementById(\`messages-\${sessionId}\`);
                        
                        if (messagesContainer && data.messages) {
                            // Clear any existing content
                            messagesContainer.innerHTML = '';
                            
                            // Add each message from chat manager
                            for (const msg of data.messages) {
                                addMessageToUI(sessionId, msg.sender, msg.content, msg.source);
                            }
                            
                            console.log(\`Loaded \${data.messages.length} messages for session \${sessionId}\`);
                        }
                    }
                } catch (error) {
                    console.error(\`Failed to load conversation history for session \${sessionId}:\`, error);
                }
            }
        }

        // WebSocket connection for real-time updates
        function setupRealtimeUpdates() {
            console.log('Setting up SSE connection to /mcp...');
            const eventSource = new EventSource('/mcp');
            
            eventSource.onopen = function(event) {
                console.log('SSE connection opened successfully:', event);
                // Load conversation history for all sessions
                loadConversationHistory();
            };
            
            eventSource.onmessage = function(event) {
                try {
                    console.log('SSE message received:', event.data);
                    const data = JSON.parse(event.data);
                    console.log('Real-time update:', data);
                    
                    // Handle different types of updates
                    if (data.type === 'chat_message' && data.sessionId && data.message) {
                        addMessageToUI(data.sessionId, data.message.sender, data.message.content, data.message.source);
                    } else if (data.type === 'message' && data.sessionId) {
                        addMessageToUI(data.sessionId, data.role || 'assistant', data.content);
                    } else if (data.type === 'human-agent-request' && data.data) {
                        // Handle human-agent-request messages (AI questions to user)
                        console.log('Web interface received human-agent-request:', data.data);
                        
                        // Add AI message to current session (no need to track requestId - we get it from server state)
                        const sessionId = activeSessionId || 'default'; 
                        const displayMessage = data.data.context ? \`\${data.data.context}\\n\\n\${data.data.message}\` : data.data.message;
                        addMessageToUI(sessionId, 'agent', displayMessage);
                    } else if (data.type === 'session_update') {
                        // Refresh the page to show new sessions
                        window.location.reload();
                    }
                } catch (error) {
                    console.error('Failed to parse SSE message:', error);
                }
            };
            
            eventSource.onerror = function(error) {
                console.error('SSE connection error:', error);
                console.error('EventSource readyState:', eventSource.readyState);
                console.error('EventSource url:', eventSource.url);
            };
        }
        
        // Initialize everything when page loads
        async function initialize() {
            await loadExistingMessages();
            setupRealtimeUpdates();
            
            // Focus on input for active session
            if (activeSessionId) {
                const activeInput = document.querySelector(\`textarea[data-session="\${activeSessionId}"]\`);
                if (activeInput) activeInput.focus();
            }
        }
        
        // Start initialization
        initialize();
    </script>
</body>
</html>`;
  }

  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
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
    // Use extension session ID if available, otherwise fall back to detecting from headers
    let sessionIdToUse = this.sessionId; // Extension session ID
    
    // If no extension session, try to extract from message params or headers
    if (!sessionIdToUse && message.params?.sessionId) {
      sessionIdToUse = message.params.sessionId;
    }
    
    this.debugLogger.log('TOOLS', `tools/list request - Extension sessionId: ${this.sessionId}, Message params: ${JSON.stringify(message.params)}`);
    this.debugLogger.log('TOOLS', `Final sessionIdToUse: ${sessionIdToUse || 'default'}`);
    
    const tools = this.getAvailableTools(sessionIdToUse);
    
    this.debugLogger.log('TOOLS', `Returning ${tools.length} tools for session: ${sessionIdToUse || 'default'}`);
    if (sessionIdToUse) {
      this.debugLogger.log('TOOLS', `Using session-specific tools for: ${sessionIdToUse}`);
      const sessionTools = this.sessionTools.get(sessionIdToUse);
      if (sessionTools) {
        this.debugLogger.log('TOOLS', `Session tools found: ${Array.from(sessionTools.keys()).join(', ')}`);
      }
    } else {
      this.debugLogger.log('TOOLS', `Using default tools (no session ID available)`);
    }
    
    return {
      id: message.id,
      type: 'response',
      result: { tools }
    };
  }

  private async handleToolCall(message: McpMessage): Promise<McpMessage> {
    const { name, arguments: args } = message.params;
    // Extract session ID from _meta.vscode.conversationId (VS Code) or fallback to args.sessionId (web)
    const rawSessionId = message.params._meta?.['vscode.conversationId'] || args?.sessionId;
    const sessionId = this.mapToRegisteredSession(rawSessionId);
    
    this.debugLogger.log('MCP', `Tool call - name: "${name}", raw session: ${rawSessionId}, mapped session: ${sessionId}`, { name, args });
    
    // Check session-specific tools first, then default tools
    const sessionTools = sessionId ? this.sessionTools.get(sessionId) : null;
    const availableTools = sessionTools || this.tools;
    
    this.debugLogger.log('MCP', `Available tools for session ${sessionId || 'default'}:`, Array.from(availableTools.keys()));
    
    if (name === 'HumanAgent_Chat' && availableTools.has(name)) {
      this.debugLogger.log('MCP', 'Executing HumanAgent_Chat tool');
      return await this.handleHumanAgentChatTool(message.id, args, sessionId);
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

  private async handleHumanAgentChatTool(messageId: string, params: HumanAgentChatToolParams, sessionId?: string): Promise<McpMessage> {
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
        // Remove from ChatManager - find which session it belongs to
        const pendingRequestInfo = this.chatManager.findPendingRequest(requestId);
        if (pendingRequestInfo) {
          this.chatManager.removePendingRequest(pendingRequestInfo.sessionId, requestId);
        }
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
      
      // Store the pending request using the extracted session ID
      const sessionToUse = sessionId || params.sessionId || 'default';
      this.debugLogger.log('TOOL', `Adding pending request ${requestId} to session: ${sessionToUse}`);
      
      // Store the AI's message (this IS the AI communication - it talks by calling the tool)
      const aiMessage: ChatMessage = {
        id: requestId, // Use request ID to link with pending request
        content: displayMessage,
        sender: 'agent',
        timestamp: new Date(),
        type: 'text'
      };
      this.chatManager.addMessage(sessionToUse, aiMessage);
      this.debugLogger.log('CHAT', `Stored AI message in ChatManager for session ${sessionToUse}: ${aiMessage.content.substring(0, 50)}...`);
      this.broadcastMessageToClients(sessionToUse, aiMessage);
      
      this.chatManager.addPendingRequest(sessionToUse, requestId, params);
      this.requestResolvers.set(requestId, {
        resolve: (response: string) => {
          clearTimeout(timeoutHandle);
          const responseTime = Date.now() - startTime;
          this.debugLogger.log('TOOL', `Request ${requestId} completed with response:`, response);
          
          // Don't store human response as assistant message
          // The 'response' here is the human's answer to AI's question
          // The AI will generate its own response separately after receiving this
          
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
        }
      });
      
      this.debugLogger.log('TOOL', `Request ${requestId} waiting for human response...`);
    });
  }

  // Method to handle human responses (called by webview)
  public respondToHumanRequest(requestId: string, response: string): boolean {
    this.debugLogger.log('SERVER', `Received human response for request ${requestId}:`, response);
    
    const resolver = this.requestResolvers.get(requestId);
    if (resolver) {
      this.requestResolvers.delete(requestId);
      resolver.resolve(response);
      return true;
    }
    
    this.debugLogger.log('SERVER', `No pending request found for ID: ${requestId}`);
    return false;
  }

  // Simplified API - no sessions needed

  getAvailableTools(sessionId?: string): McpTool[] {
    if (sessionId && this.sessionTools.has(sessionId)) {
      return Array.from(this.sessionTools.get(sessionId)!.values());
    }
    // Fall back to default tools
    return Array.from(this.tools.values());
  }

  // REMOVED: getPendingRequests - use ChatManager.getPendingRequests() per session instead

  // Method to manually resolve a pending request (for testing)
  resolvePendingRequest(requestId: string, response: string): boolean {
    const resolver = this.requestResolvers.get(requestId);
    if (resolver) {
      // Remove resolver
      this.requestResolvers.delete(requestId);
      // Find the session ID for this request and remove it from ChatManager
      const pendingRequestInfo = this.chatManager.findPendingRequest(requestId);
      if (pendingRequestInfo) {
        this.chatManager.removePendingRequest(pendingRequestInfo.sessionId, requestId);
      }
      
      resolver.resolve(response);
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

  registerSession(sessionId: string, workspacePath?: string, overrideData?: any): void {
    this.activeSessions.add(sessionId);
    
    // Initialize session-specific tools from override data or workspace path
    if (overrideData) {
      this.initializeSessionToolsFromData(sessionId, overrideData);
    } else if (workspacePath) {
      this.initializeSessionTools(sessionId, workspacePath);
    }
    
    this.debugLogger.log('INFO', `Session registered: ${sessionId} (${this.activeSessions.size} total sessions)`);
  }

  private mapToRegisteredSession(conversationId?: string): string | undefined {
    if (!conversationId) {
      return undefined;
    }

    // Check if it's already a registered session ID
    if (this.activeSessions.has(conversationId)) {
      return conversationId;
    }

    // Check if it's a conversation ID we've seen before
    const mappedSession = this.conversationToSession.get(conversationId);
    if (mappedSession && this.activeSessions.has(mappedSession)) {
      this.debugLogger.log('MCP', `Mapped conversation ${conversationId} to session ${mappedSession}`);
      return mappedSession;
    }

    // If not found, try to map to the first available registered session
    // This handles the case where VS Code conversation ID needs to be linked to a web-registered session
    const activeSessions = Array.from(this.activeSessions);
    if (activeSessions.length > 0) {
      const targetSession = activeSessions[0]; // Use first available session
      this.conversationToSession.set(conversationId, targetSession);
      this.debugLogger.log('MCP', `Auto-mapped conversation ${conversationId} to session ${targetSession}`);
      return targetSession;
    }

    this.debugLogger.log('MCP', `No registered session found for conversation ${conversationId}`);
    return undefined;
  }

  unregisterSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    // Clean up session-specific data
    this.sessionTools.delete(sessionId);
    this.sessionWorkspacePaths.delete(sessionId);
    this.debugLogger.log('INFO', `Session unregistered and cleaned up: ${sessionId} (${this.activeSessions.size} total sessions)`);
  }

  getActiveSessions(): string[] {
    return Array.from(this.activeSessions);
  }

  async restartSession(sessionId: string): Promise<void> {
    try {
      this.debugLogger.log('INFO', `Restarting session: ${sessionId}...`);
      
      // Get workspace path before unregistering
      const workspacePath = this.sessionWorkspacePaths.get(sessionId);
      if (!workspacePath) {
        throw new Error(`No workspace path found for session ${sessionId}`);
      }
      
      // Unregister session (cleans up old tools and data)
      this.unregisterSession(sessionId);
      
      // Re-register session with fresh tools
      this.registerSession(sessionId, workspacePath);
      
      this.debugLogger.log('INFO', `Session ${sessionId} restarted successfully with fresh tools`);
    } catch (error) {
      this.debugLogger.log('ERROR', `Failed to restart session ${sessionId}:`, error);
      throw error;
    }
  }

  async reloadOverrides(sessionId?: string): Promise<void> {
    try {
      this.debugLogger.log('INFO', `Reloading workspace overrides for session: ${sessionId || 'all sessions'}...`);
      
      if (sessionId) {
        // Reload for specific session
        const workspacePath = this.sessionWorkspacePaths.get(sessionId);
        if (workspacePath) {
          this.initializeSessionTools(sessionId, workspacePath);
          this.debugLogger.log('INFO', `Session ${sessionId} overrides reloaded successfully`);
        } else {
          this.debugLogger.log('WARN', `No workspace path found for session ${sessionId}`);
        }
      } else {
        // Reload for all sessions
        for (const [sessionId, workspacePath] of this.sessionWorkspacePaths.entries()) {
          this.initializeSessionTools(sessionId, workspacePath);
        }
        this.debugLogger.log('INFO', 'All session overrides reloaded successfully');
      }
    } catch (error) {
      this.debugLogger.log('ERROR', 'Failed to reload workspace overrides:', error);
      throw error;
    }
  }

  // Message storage and synchronization methods - now using ChatManager
  // Removed: storeMessage and getSessionMessages wrapper methods - call ChatManager directly

  private broadcastMessageToClients(sessionId: string, message: ChatMessage): void {
    // Broadcast message to all connected SSE clients
    const messageEvent = {
      type: 'chat_message',
      sessionId: sessionId,
      message: {
        id: message.id,
        content: message.content,
        sender: message.sender,
        timestamp: message.timestamp.toISOString()
      }
    };
    
    const sseData = `data: ${JSON.stringify(messageEvent)}\n\n`;
    
    // Send to all connected SSE clients (VS Code webviews and web interfaces)
    for (const connection of this.sseConnections) {
      try {
        connection.write(sseData);
        this.debugLogger.log('CHAT', `Broadcasted message to SSE client for session ${sessionId}`);
      } catch (error) {
        this.debugLogger.log('ERROR', 'Failed to broadcast message to SSE client:', error);
        // Remove failed connection
        this.sseConnections.delete(connection);
      }
    }
  }
}