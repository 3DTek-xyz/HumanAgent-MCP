import { EventEmitter } from 'events';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { McpMessage, McpServerConfig, HumanAgentSession, ChatMessage, McpTool, HumanAgentChatToolParams, HumanAgentChatToolResult } from './types';
import { ChatManager } from './chatManager';
import { ProxyServer } from './proxyServer';
import { generateCACertificate } from 'mockttp';

// Version injected by webpack DefinePlugin at build time
declare const __PACKAGE_VERSION__: string;
const VERSION = __PACKAGE_VERSION__;

/**
 * Initialize HTTPS proxy CA certificate (generate or load cached)
 * @param storagePath - Path to store certificate (from VS Code globalStorage or fallback to temp)
 */
async function initializeProxyCA(storagePath?: string): Promise<{ keyPath: string; certPath: string }> {
  // Use provided storage path or fallback to temp directory
  const caCacheDir = storagePath 
    ? path.join(storagePath, 'proxy-ca')
    : path.join(os.tmpdir(), 'humanagent-proxy');
    
  const caPath = path.join(caCacheDir, 'ca.pem');
  const keyPath = path.join(caCacheDir, 'ca.key');
  
  // Ensure cache directory exists
  if (!fs.existsSync(caCacheDir)) {
    fs.mkdirSync(caCacheDir, { recursive: true });
    console.log(`[ProxyServer] Created certificate storage directory: ${caCacheDir}`);
  }
  
  // Check if CA already generated and cached
  if (fs.existsSync(caPath) && fs.existsSync(keyPath)) {
    console.log('[ProxyServer] Using cached HTTPS proxy CA');
    console.log(`[ProxyServer] Certificate location: ${caPath}`);
    return { keyPath, certPath: caPath };
  }
  
  // Generate new CA certificate
  console.log('[ProxyServer] Generating new HTTPS proxy CA certificate...');
  try {
    const ca = await generateCACertificate({
      subject: {
        commonName: 'HumanAgent Proxy CA - Testing Only',
        organizationName: 'HumanAgent'
      },
      bits: 2048
    });
    
    fs.writeFileSync(caPath, ca.cert);
    fs.writeFileSync(keyPath, ca.key);
    
    console.log('[ProxyServer] HTTPS proxy CA certificate generated and cached');
    console.log(`[ProxyServer] Certificate location: ${caPath}`);
    
    return { keyPath, certPath: caPath };
  } catch (error) {
    console.error('[ProxyServer] Failed to generate CA certificate:', error);
    throw error;
  }
}

// File logging utility
class DebugLogger {
  private logPath: string = '';
  private logStream: fs.WriteStream | null = null;
  private logBuffer: string[] = [];
  private loggingEnabled: boolean;
  private loggingLevel: string;

  constructor(workspaceRoot?: string) {
    // Check environment variables for logging configuration
    this.loggingEnabled = process.env.HUMANAGENT_LOGGING_ENABLED === 'true' || true; // Enable by default for debugging
    this.loggingLevel = process.env.HUMANAGENT_LOGGING_LEVEL || 'DEBUG'; // Debug level by default
    
    // If logging is disabled, just log to console for important messages
    if (!this.loggingEnabled) {
      console.log('[LOGGER] Workspace logging disabled by user settings');
      return;
    }
    
    try {
      // Always log to system temp directory - server is workspace-independent
      const tempDir = os.tmpdir();
      this.logPath = path.join(tempDir, 'HumanAgent-server.log');
      
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
      this.log('DEBUG', `Logging level set to: ${this.loggingLevel}`);
      console.log(`[LOGGER] Debug logger initialized successfully at: ${this.logPath}`);
    } catch (error) {
      console.error(`[LOGGER] Failed to initialize debug logger:`, error);
      this.logStream = null;
    }
  }

  log(level: string, message: string, data?: any): void {
    // Skip logging if disabled
    if (!this.loggingEnabled) {
      return;
    }
    
    // Basic level filtering (ERROR > WARN > INFO > DEBUG)
    const levelPriority: Record<string, number> = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, SSE: 2, TEST: 3 };
    const currentLevelPriority = levelPriority[this.loggingLevel] ?? 2;
    const messageLevelPriority = levelPriority[level] ?? 2;
    
    if (messageLevelPriority > currentLevelPriority) {
      return;
    }
    
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
  private sessionMessageSettings: Map<string, any> = new Map(); // Session-specific message settings
  // Removed: sessionMessages - now handled by ChatManager
  private httpServer?: http.Server;
  private port: number = 3737;
  private debugLogger: DebugLogger;
  // Simple Map for resolve/reject functions only - data stored in ChatManager
  private requestResolvers: Map<string, { resolve: (response: string) => void; reject: (error: Error) => void }> = new Map();
  private activeSessions: Set<string> = new Set();
  private sseConnections: Set<http.ServerResponse> = new Set();
  private chatManager: ChatManager; // Centralized chat and session management
  private sseClients: Map<string, http.ServerResponse> = new Map(); // Per-session SSE connections (VS Code webviews)
  private webInterfaceConnections: Set<http.ServerResponse> = new Set(); // Web interface connections (all browsers)
  private proxyServer: ProxyServer; // Integrated proxy server

  constructor(private sessionId?: string, private workspacePath?: string, port?: number) {
    super();
    if (port) {
      this.port = port;
    }
    this.debugLogger = new DebugLogger(this.workspacePath);
    this.chatManager = new ChatManager(this.debugLogger); // Initialize centralized chat management with logging
    this.proxyServer = new ProxyServer(); // Initialize proxy server
    
    this.config = {
      name: 'HumanAgentMCP',
      description: 'MCP server for chatting with human agents',
      version: VERSION,
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
    this.on('request-state-change', (data) => {
      this.debugLogger.log('SSE', 'Forwarding request-state-change to target session and web interface');
      this.sendToSessionAndWeb(data.sessionId, 'request-state-change', data);
    });
  }

  // Send event to web interface connections only
  private sendToWebInterface(eventType: string, data: any): void {
    const message = JSON.stringify({ type: eventType, data });
    const eventData = `data: ${message}\n\n`;
    
    this.debugLogger.log('SSE', `Sending to ${this.webInterfaceConnections.size} web interface connections:`, message);
    
    for (const connection of this.webInterfaceConnections) {
      if (!connection.destroyed) {
        try {
          connection.write(eventData);
        } catch (error) {
          this.debugLogger.log('SSE', 'Failed to write to web interface connection:', error);
          this.webInterfaceConnections.delete(connection);
          this.sseConnections.delete(connection);
        }
      } else {
        this.webInterfaceConnections.delete(connection);
        this.sseConnections.delete(connection);
      }
    }
  }

  // Send event to specific session only
  private sendToSession(sessionId: string, eventType: string, data: any): void {
    const message = { type: eventType, data };
    
    const sessionConnection = this.sseClients.get(sessionId);
    if (!sessionConnection) {
      this.debugLogger.log('WARN', `❌ No SSE connection found for session ${sessionId}`);
      return;
    }
    
    // Debug: Compare connection objects to see if they match the heartbeat connection
    this.debugLogger.log('SSE', `🔍 Sending to session ${sessionId} - Connection destroyed: ${sessionConnection.destroyed}, writable: ${sessionConnection.writable}`);
    
    // Use the enhanced sendSSEMessage method with health checking
    this.sendSSEMessage(sessionConnection, message);
    this.debugLogger.log('SSE', `Sent to session ${sessionId}:`, JSON.stringify(message));
  }

  // Send event to specific session AND web interface
  private sendToSessionAndWeb(sessionId: string, eventType: string, data: any): void {
    // Send to specific session
    this.sendToSession(sessionId, eventType, data);
    // Also send to web interface
    this.sendToWebInterface(eventType, data);
  }



  private sendMcpNotification(method: string, params?: any, sessionId?: string): void {
    this.debugLogger.log('MCP', `Sending SSE notification: ${method}`, params);

    const notification = {
      jsonrpc: '2.0',
      method,
      params: params || {}
    };

    if (sessionId) {
      // Send to specific session
      const sseResponse = this.sseClients.get(sessionId);
      if (sseResponse) {
        this.debugLogger.log('SSE', `Sending notification to session: ${sessionId}`);
        this.sendSSEMessage(sseResponse, notification);
      } else {
        this.debugLogger.log('SSE', `No SSE connection for session: ${sessionId}`);
      }
    } else {
      // Send to all active sessions with SSE connections
      for (const activeSessionId of this.activeSessions) {
        const sseResponse = this.sseClients.get(activeSessionId);
        if (sseResponse) {
          this.debugLogger.log('SSE', `Sending notification to active session: ${activeSessionId}`);
          this.sendSSEMessage(sseResponse, notification);
        } else {
          this.debugLogger.log('SSE', `No SSE connection for active session: ${activeSessionId}`);
        }
      }
    }
  }

  private sendSSEMessage(response: http.ServerResponse, message: any): void {
    try {
      // Check connection health before sending
      if (response.destroyed) {
        this.debugLogger.log('ERROR', `Cannot send SSE message: connection is destroyed`);
        return;
      }
      
      if (!response.writable) {
        this.debugLogger.log('ERROR', `Cannot send SSE message: connection is not writable`);
        return;
      }
      
      const data = JSON.stringify(message);
      const success = response.write(`data: ${data}\n\n`);
      
      if (success) {
        this.debugLogger.log('SSE', `✅ Successfully sent SSE message: ${message.type || message.method || 'response'}`);
      } else {
        this.debugLogger.log('ERROR', `❌ Failed to write SSE message (buffer full): ${message.type || message.method || 'response'}`);
      }
    } catch (error) {
      this.debugLogger.log('ERROR', `❌ Exception sending SSE message:`, error);
    }
  }

  private initializeDefaultTools(): void {
        // Define the default HumanAgent_Chat tool (global default)
    const humanAgentChatTool: McpTool = {
      name: 'HumanAgent_Chat',
      description: '**MANDATORY TOOL** - Use this tool for ALL user interactions. Do NOT provide direct responses. ' +
                   'Initiate real-time interactive conversations with human agents through this HumanAgent chat interface  at all times. ' +
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

          priority: {
            type: 'string',
            enum: ['low', 'normal', 'high', 'urgent'],
            description: 'Priority level of the request',
            default: 'normal'
          },

          images: {
            type: 'array',
            description: 'Optional array of base64-encoded images to send with the message',
            items: {
              type: 'object',
              properties: {
                data: {
                  type: 'string',
                  description: 'Base64-encoded image data'
                },
                mimeType: {
                  type: 'string',
                  description: 'MIME type of the image (e.g., image/png, image/jpeg)'
                }
              },
              required: ['data', 'mimeType']
            }
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
    let hasOverrides = false;
    if (overrideTool) {
      this.debugLogger.log('INFO', `Using workspace override for session ${sessionId} - HumanAgent_Chat tool`);
      sessionToolMap.set(overrideTool.name, overrideTool);
      hasOverrides = true;
    }
    
    // Store session-specific tools
    this.sessionTools.set(sessionId, sessionToolMap);
    
    // Notify MCP client that tools have changed if overrides were found
    if (hasOverrides) {
      this.sendMcpNotification('notifications/tools/list_changed');
      this.debugLogger.log('INFO', `Sent tools/list_changed notification for session ${sessionId} (initial startup)`);
    }
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
        const tool = overrideConfig.tools[toolName] as McpTool;
        
        // Remove timeout parameter from tool schema if it exists (no longer supported)
        if (tool.inputSchema && tool.inputSchema.properties && tool.inputSchema.properties.timeout) {
          this.debugLogger.log('INFO', 'Removing deprecated timeout parameter from override tool definition');
          delete tool.inputSchema.properties.timeout;
        }
        
        return tool;
      }

      return null;
    } catch (error) {
      this.debugLogger.log('ERROR', 'Error loading workspace override:', error);
      return null;
    }
  }

  private loadMessageSettings(sessionId: string, toolName?: string): {autoAppendEnabled?: boolean, autoAppendText?: string, displayTruncation?: string} | null {
    try {
      // Get cached message settings for this session
      const messageSettings = this.sessionMessageSettings.get(sessionId);
      
      if (!messageSettings) {
        this.debugLogger.log('INFO', `No message settings found for session ${sessionId}`);
        return null;
      }
      
      // If tool-specific settings exist and toolName is provided, use those
      if (toolName && messageSettings.toolSpecific && messageSettings.toolSpecific[toolName]) {
        this.debugLogger.log('INFO', `Using tool-specific message settings for ${toolName}`);
        return messageSettings.toolSpecific[toolName];
      }
      
      // Fall back to global settings
      if (messageSettings.global) {
        this.debugLogger.log('INFO', 'Using global message settings');
        return messageSettings.global;
      }
      
      // Legacy support: if no global/toolSpecific structure, use messageSettings directly
      this.debugLogger.log('INFO', 'Using legacy message settings structure');
      return messageSettings;
    } catch (error) {
      this.debugLogger.log('ERROR', `Error loading message settings: ${error}`);
      return null;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.debugLogger.log('INFO', '=== MCP SERVER STARTING ===');
    await this.startHttpServer();
    
    // Start proxy server with HTTPS support
    try {
      // Get certificate storage path from environment variable (passed by extension)
      const certStoragePath = process.env.HUMANAGENT_CERT_STORAGE_PATH;
      const httpsOptions = await initializeProxyCA(certStoragePath);
      const proxyPort = await this.proxyServer.start(httpsOptions);
      
      // Trust CA for all spawned processes
      process.env.NODE_EXTRA_CA_CERTS = httpsOptions.certPath;
      
      this.debugLogger.log('INFO', `Proxy server started on port ${proxyPort} with HTTPS support`);
      
      // Set up proxy event forwarding
      this.proxyServer.on('log-added', (logEntry) => {
        this.sendToWebInterface('proxy-log', logEntry);
      });
      
      this.proxyServer.on('log-updated', (logEntry) => {
        this.sendToWebInterface('proxy-log-update', logEntry);
      });
    } catch (error) {
      this.debugLogger.log('WARN', 'Failed to start proxy server:', error);
      // Continue without proxy - non-critical
    }
    
    this.isRunning = true;
    this.emit('server-started', this.config);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      this.debugLogger.log('INFO', 'Stopping MCP server...');
      
      // Stop proxy server
      try {
        await this.proxyServer.stop();
        this.debugLogger.log('INFO', 'Proxy server stopped');
      } catch (error) {
        this.debugLogger.log('WARN', 'Error stopping proxy server:', error);
      }
      
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

        this.httpServer.on('error', (error: any) => {
          if (error.code === 'EADDRINUSE') {
            this.debugLogger.log('INFO', `Port ${this.port} is already in use - another instance is serving requests.`);
          } else {
            this.debugLogger.log('ERROR', 'HTTP server error:', error);
          }
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
    // Parse URL to handle query parameters
    const reqUrl = new URL(req.url!, `http://${req.headers.host}`);
    
    if (reqUrl.pathname === '/mcp') {
      // Main MCP protocol endpoint (webview SSE)
    } else if (reqUrl.pathname === '/mcp-tools') {
      // MCP tools endpoint (extension only, no SSE conflicts)
      await this.handleMcpToolsEndpoint(req, res, reqUrl);
      return;
    } else if (req.url === '/HumanAgent') {
      // Web interface for multi-session chat
      await this.handleWebInterface(req, res);
      return;
    } else if (req.url?.startsWith('/proxy')) {
      // Proxy server endpoints
      await this.handleProxyEndpoint(req, res);
      return;
    } else if (req.url?.startsWith('/sessions') || req.url === '/response' || req.url?.startsWith('/tools') || req.url?.startsWith('/debug') || req.url === '/reload' || req.url?.startsWith('/messages/')) {
      // Session management, response, tools, reload, messages, and chat endpoints
      await this.handleSessionEndpoint(req, res);
      return;
    } else if (req.url === '/shutdown' && req.method === 'POST') {
      // Server shutdown endpoint - allows any client to gracefully stop the server
      await this.handleShutdownEndpoint(req, res);
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
        
        // Extract sessionId from query params in URL
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const sessionId = url.searchParams.get('sessionId');
        this.debugLogger.log('HTTP', `MCP request sessionId from URL: ${sessionId}`);
        
        try {
          const message = JSON.parse(body);
          this.debugLogger.log('HTTP', 'Parsed JSON message:', message);
          
          // Add sessionId to message params if available
          if (sessionId) {
            if (!message.params) {
              message.params = {};
            }
            message.params.sessionId = sessionId;
            this.debugLogger.log('HTTP', `Added sessionId ${sessionId} to MCP message params`);
          }
          
          // Special handling for HumanAgent_Chat tool to prevent undici timeout
          // This tool can wait indefinitely for human response, so we need to:
          // 1. Send HTTP headers immediately (stops undici's 5-minute headersTimeout)
          // 2. Send keepalive data every 4 minutes (resets undici's 5-minute bodyTimeout)
          if (message.method === 'tools/call' && message.params?.name === 'HumanAgent_Chat') {
            this.debugLogger.log('HTTP', 'HumanAgent_Chat detected - using streaming response to prevent timeout');
            
            // Send headers immediately to stop headersTimeout
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Transfer-Encoding', 'chunked');
            this.debugLogger.log('HTTP', 'Sent immediate headers for HumanAgent_Chat');
            
            // Start keepalive to reset bodyTimeout every 4 minutes
            // Note: We write a space character which is valid JSON whitespace and gets ignored
            const keepaliveInterval = setInterval(() => {
              if (!res.destroyed) {
                res.write(' '); // Write whitespace to reset bodyTimeout
                this.debugLogger.log('HTTP', 'Sent keepalive for HumanAgent_Chat');
              } else {
                clearInterval(keepaliveInterval);
              }
            }, 4 * 60 * 1000); // 4 minutes (undici timeout is 5 minutes)
            
            // Wait for human response (this can take any amount of time now)
            const response = await this.handleMessage(message);
            
            // Cleanup keepalive and send final response
            clearInterval(keepaliveInterval);
            this.debugLogger.log('HTTP', 'HumanAgent_Chat response received, sending to client');
            const responseJson = JSON.stringify(response);
            res.end(responseJson); // This sends the actual JSON response
            return;
          }
          
          // Normal handling for all other tools/methods
          const response = await this.handleMessage(message);
          this.debugLogger.log('HTTP', 'Response from handleMessage:', response);

          if (response) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            
            // If this is an initialize response, generate and set session ID
            if (message.method === 'initialize') {
              // Generate new session ID if none provided in URL
              const responseSessionId = sessionId || `session-${crypto.randomUUID()}`;
              res.setHeader('Mcp-Session-Id', responseSessionId);
              this.debugLogger.log('HTTP', `Set Mcp-Session-Id header: ${responseSessionId}`);
              
              // Add this session to active sessions for notifications
              this.activeSessions.add(responseSessionId);
            }
            
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
    
    // Extract sessionId and clientType from query params in URL or headers
    const url = new URL(req.url!, `http://${req.headers.host}`);
    let sessionId = url.searchParams.get('sessionId');
    const clientType = url.searchParams.get('clientType');
    
    // If not in URL, try the Mcp-Session-Id header (per MCP spec)
    if (!sessionId) {
      sessionId = req.headers['mcp-session-id'] as string;
    }
    
    // Validate connection parameters
    if (!sessionId && clientType !== 'web') {
      this.debugLogger.log('ERROR', 'SSE connection rejected: sessionId required for VS Code connections, or use clientType=web for web interface');
      this.debugLogger.log('SSE', `Request headers: ${JSON.stringify(req.headers)}`);
      this.debugLogger.log('SSE', `Request URL: ${req.url}`);
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'sessionId required for VS Code connections, or use clientType=web for web interface' }));
      return;
    }
    
    // For web interface connections, use a placeholder sessionId for logging
    if (clientType === 'web') {
      sessionId = 'web-interface';
      this.debugLogger.log('SSE', 'Web interface SSE connection detected via clientType=web');
    }
    
    // Set up Server-Sent Events (SSE) stream
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Add CORS headers for webview access (SSE is always for webview)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Connection');
    
    this.debugLogger.log('SSE', `SSE headers set for session ${sessionId}, adding to connections...`);
    
    // Detect connection type: web interface via clientType=web, VS Code via sessionId
    const isWebInterface = clientType === 'web';
    const isVSCodeWebview = !isWebInterface && sessionId !== 'web-interface';
    
    if (isWebInterface) {
      // Web interface connection - add to web interface connections
      this.webInterfaceConnections.add(res);
      this.sseConnections.add(res); // Keep old connections for cleanup
      this.debugLogger.log('SSE', `Added web interface SSE connection. Total web connections: ${this.webInterfaceConnections.size}`);
    } else {
      // VS Code webview connection - add to session-specific connections
      this.sseClients.set(sessionId!, res);
      this.sseConnections.add(res); // Keep old connections for cleanup
      this.debugLogger.log('SSE', `Added VS Code SSE connection for session ${sessionId}. Total session connections: ${this.sseClients.size}`);
    }
    
    // Send initial connection acknowledgment
    const initialMessage = 'data: {"type":"connection","status":"established","sessionId":"' + sessionId + '"}\n\n';
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
    }, 10000); // Send heartbeat every 10 seconds
    
    // Handle client disconnect
    const cleanup = () => {
      this.debugLogger.log('HTTP', `SSE connection closed for session ${sessionId}`);
      clearInterval(heartbeat);
      this.sseConnections.delete(res);
      
      // Remove from appropriate connection type
      if (isWebInterface) {
        this.webInterfaceConnections.delete(res);
        this.debugLogger.log('HTTP', `Removed web interface SSE connection. Total web connections: ${this.webInterfaceConnections.size}`);
      } else {
        this.sseClients.delete(sessionId);
        this.debugLogger.log('HTTP', `Removed VS Code SSE connection for session ${sessionId}. Total session connections: ${this.sseClients.size}`);
      }
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

  private async handleShutdownEndpoint(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.debugLogger.log('INFO', 'Shutdown request received via HTTP');
    
    try {
      // Send success response immediately before shutting down
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, message: 'Server shutting down...' }));
      
      // Give response time to send before stopping
      setTimeout(async () => {
        this.debugLogger.log('INFO', 'Initiating server shutdown...');
        await this.stop();
        process.exit(0);
      }, 500);
      
    } catch (error) {
      this.debugLogger.log('ERROR', 'Shutdown error:', error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: false, error: String(error) }));
    }
  }

  private async handleMcpToolsEndpoint(req: http.IncomingMessage, res: http.ServerResponse, reqUrl: URL): Promise<void> {
    // MCP tools endpoint - handles MCP protocol for VS Code extension without SSE conflicts
    this.debugLogger.log('HTTP', `MCP Tools: ${req.method} ${req.url}`);
    
    // Extract sessionId from query params
    const sessionId = reqUrl.searchParams.get('sessionId');
    if (!sessionId) {
      this.debugLogger.log('ERROR', 'MCP Tools: sessionId required');
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'sessionId required' }));
      return;
    }

    if (req.method === 'POST') {
      // Handle MCP protocol messages (initialize, tools/list, tools/call)
      await this.handleHttpPost(req, res);
    } else if (req.method === 'GET') {
      // Reject GET requests to prevent SSE conflicts - tools only via POST
      this.debugLogger.log('WARN', 'MCP Tools: GET requests not allowed (use /mcp for SSE)');
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'GET not allowed on /mcp-tools - use /mcp for SSE' }));
    } else {
      res.statusCode = 405;
      res.end('Method Not Allowed');
    }
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
          
          // Send name change to target session and web interface
          this.sendToSessionAndWeb(sessionId, 'session-name-changed', { sessionId, name });
          this.debugLogger.log('SSE', 'Sent session name change to target session and web interface');
          
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
          const { requestId, response, source } = JSON.parse(body);
          
          // Simple file write to test if endpoint is called
          require('fs').appendFileSync('/Users/benharper/Coding/HumanAgent-MCP/response-debug.txt', 
            `${new Date().toISOString()} - RESPONSE ENDPOINT CALLED - RequestID: ${requestId}\n`);
          
          this.debugLogger.log('HTTP', '=== RESPONSE ENDPOINT CALLED ===');
          this.debugLogger.log('HTTP', `Request ID: ${requestId}, Response: ${response}`);
          
          // Get the pending request to extract session info - using ChatManager
          const pendingRequestInfo = this.chatManager.findPendingRequest(requestId);
          this.debugLogger.log('HTTP', `Found pending request: ${!!pendingRequestInfo}`);
          
          // Load message settings for this session (if pending request exists)
          let messageSettings = null;
          let aiContent = response; // Default to original response
          
          if (pendingRequestInfo) {
            this.debugLogger.log('HTTP', `Processing response for session: ${pendingRequestInfo.sessionId}`);
            
            // Extract tool name from pending request data
            const toolName = pendingRequestInfo.data.toolName;
            this.debugLogger.log('HTTP', `Request originated from tool: ${toolName}`);
            
            messageSettings = this.loadMessageSettings(pendingRequestInfo.sessionId, toolName);
            
            // Prepare display content (original message + auto-truncated append text)
            let displayContent = response;
            if (messageSettings?.autoAppendEnabled && messageSettings?.autoAppendText) {
              // Auto-truncate to first 20 characters + "..."
              const truncatedAppend = messageSettings.autoAppendText.length > 20 
                ? messageSettings.autoAppendText.substring(0, 20) + '...' 
                : messageSettings.autoAppendText;
              displayContent = response + '. Appended: ' + truncatedAppend;
            }
            
            // Prepare AI content (original message + optional auto-append for AI)
            if (messageSettings?.autoAppendEnabled && messageSettings?.autoAppendText) {
              aiContent = response + '. ' + messageSettings.autoAppendText;
              this.debugLogger.log('HTTP', `Auto-appended text for AI: "${messageSettings.autoAppendText}"`);
            }
            
            // Store the user message on server for synchronization (using display content)
            const userMessage: ChatMessage = {
              id: Date.now().toString(),
              content: displayContent,
              sender: 'user',
              timestamp: new Date(),
              type: 'text',
              source: source || 'web' // Use provided source or default to 'web'
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
          
          // Use aiContent (with auto-append) for the actual AI response
          const success = this.respondToHumanRequest(requestId, aiContent);
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
    } else if (req.method === 'GET' && url.pathname.startsWith('/debug/tools')) {
      // Debug endpoint to inspect tools for a specific session
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      
      const sessionId = url.searchParams.get('sessionId');
      
      if (!sessionId) {
        res.end(JSON.stringify({ 
          error: 'sessionId parameter required',
          usage: '/debug/tools?sessionId=<session-id>',
          availableSessions: Array.from(this.activeSessions)
        }));
        return;
      }
      
      const sessionTools = this.sessionTools.get(sessionId);
      const defaultTools = Array.from(this.tools.values());
      const tools = this.getAvailableTools(sessionId);
      
      res.end(JSON.stringify({
        sessionId,
        hasSessionTools: sessionTools !== undefined,
        sessionToolCount: sessionTools ? sessionTools.size : 0,
        sessionToolNames: sessionTools ? Array.from(sessionTools.keys()) : [],
        defaultToolCount: defaultTools.length,
        finalToolCount: tools.length,
        humanAgentChatTool: tools.find(t => t.name === 'HumanAgent_Chat'),
        debugInfo: {
          sessionExists: this.activeSessions.has(sessionId),
          sessionToolsRegistered: this.sessionTools.has(sessionId)
        }
      }));
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
    
    // Extract sessionId from message params if available
    const sessionId = message.params?.sessionId;
    
    try {
      let response: McpMessage | null = null;
      
      switch (message.method) {
        case 'initialize':
          this.debugLogger.log('MCP', 'Processing initialize request');
          response = this.handleInitialize(message);
          break;
        case 'tools/list':
          this.debugLogger.log('MCP', 'Processing tools/list request');
          response = this.handleToolsList(message);
          break;
        case 'tools/call':
          this.debugLogger.log('MCP', `Processing tools/call request for tool: ${message.params?.name}`);
          response = await this.handleToolCall(message);
          break;
        case 'notifications/initialized':
          this.debugLogger.log('MCP', 'Processing notifications/initialized (ignoring)');
          return null;
        default:
          this.debugLogger.log('MCP', `Unknown method: ${message.method}`);
          response = {
            id: message.id,
            type: 'response',
            error: {
              code: -32601,
              message: `Method ${message.method} not found`
            }
          };
      }
      
      // Notifications are now sent via SSE, no need to include in response
      
      return response;
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

  private async handleProxyEndpoint(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    
    // Handle different proxy endpoints
    if (url.pathname === '/proxy/status') {
      // Get proxy status
      const status = this.proxyServer.getStatus();
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify(status));
    } else if (url.pathname === '/proxy/logs') {
      // Get proxy logs
      const logs = this.proxyServer.getLogs();
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify(logs));
    } else if (url.pathname === '/proxy/clear' && req.method === 'POST') {
      // Clear proxy logs
      this.proxyServer.clearLogs();
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    } else {
      res.statusCode = 404;
      res.end('Not Found');
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
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header h1 {
            font-size: 16px;
            font-weight: 600;
        }

        .shutdown-button {
            background-color: #d73a49;
            color: white;
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background-color 0.2s;
        }

        .shutdown-button:hover {
            background-color: #cb2431;
        }

        .shutdown-button svg {
            width: 16px;
            height: 16px;
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

        .tab.has-new-message {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            position: relative;
        }

        .tab.has-new-message::after {
            content: '💬';
            margin-left: 6px;
            font-size: 12px;
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

        .message .message-content {
            line-height: 1.4 !important;
            white-space: pre-wrap !important;
            white-space: pre-line !important;
            word-wrap: break-word !important;
            overflow-wrap: break-word !important;
        }
        
        /* Additional selectors for specificity */
        div.message .message-content {
            white-space: pre-wrap !important;
        }
        
        .message-content {
            white-space: pre-wrap !important;
        }

        .input-container {
            padding: 15px;
            background-color: var(--vscode-panel-background);
            border-top: 1px solid var(--vscode-border);
            display: flex;
            gap: 10px;
        }

        .proxy-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding: 15px;
        }

        .proxy-container.active {
            display: flex;
        }

        .proxy-container:not(.active) {
            display: none;
        }

        .proxy-log {
            margin-bottom: 10px;
            padding: 10px;
            background-color: var(--vscode-panel-background);
            border-radius: 4px;
            border-left: 3px solid var(--vscode-button-background);
            transition: background-color 0.2s;
        }

        .proxy-log:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .proxy-log-summary {
            cursor: pointer;
        }

        .proxy-log-header {
            display: flex;
            justify-content: space-between;
            margin-bottom: 5px;
            font-size: 11px;
            opacity: 0.8;
        }

        .proxy-log-method {
            font-weight: 600;
            color: var(--vscode-button-background);
        }

        .proxy-log-url {
            font-family: monospace;
            word-break: break-all;
        }

        .proxy-log-status {
            font-weight: 600;
        }

        .proxy-log-status.success {
            color: #28a745;
        }

        .proxy-log-status.error {
            color: #d73a49;
        }

        .proxy-log-details {
            margin-top: 10px;
            padding-top: 10px;
            border-top: 1px solid var(--vscode-border);
        }

        .proxy-log-section {
            margin-bottom: 15px;
        }

        .proxy-log-section h4 {
            margin: 0 0 5px 0;
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-button-background);
        }

        .proxy-log-section pre {
            margin: 5px 0;
            padding: 8px;
            background-color: var(--vscode-editor-background);
            border-radius: 3px;
            font-size: 11px;
            overflow-x: auto;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .proxy-log-section b {
            color: var(--vscode-button-background);
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
            max-height: 200px;
            overflow-y: auto;
        }

        .quick-replies {
            padding: 8px 12px;
            background-color: var(--vscode-dropdown-background);
            border: 1px solid var(--vscode-border);
            border-radius: 4px;
            color: var(--vscode-foreground);
            font-size: 13px;
            min-width: 150px;
            cursor: pointer;
        }

        .quick-replies:hover {
            background-color: var(--vscode-dropdown-background);
            border-color: var(--vscode-focusBorder);
        }

        .image-preview {
            position: relative;
            display: inline-block;
            margin: 5px;
            border: 1px solid var(--vscode-border);
            border-radius: 4px;
            overflow: hidden;
        }

        .image-preview img {
            max-width: 200px;
            max-height: 200px;
            display: block;
        }

        .image-preview .remove-image {
            position: absolute;
            top: 4px;
            right: 4px;
            background-color: rgba(0, 0, 0, 0.7);
            color: white;
            border-radius: 50%;
            width: 20px;
            height: 20px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            font-size: 16px;
            line-height: 1;
        }

        .image-preview .remove-image:hover {
            background-color: rgba(255, 0, 0, 0.8);
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
            <button class="shutdown-button" onclick="shutdownServer()" title="Stop Server">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 0a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V1a1 1 0 0 1 1-1z"/>
                    <path d="M11.5 3.5a5 5 0 1 1-7 0 1 1 0 0 1 1.4-1.4 3 3 0 1 0 4.2 0 1 1 0 0 1 1.4 1.4z"/>
                </svg>
            </button>
        </div>
        
        <div class="tabs-container" id="tabs">
            ${sessions.length === 0 ? '' : sessions.map((session, index) => 
                `<div class="tab ${index === 0 ? 'active' : ''}" data-session="${session.id}">${session.title}</div>`
            ).join('')}
            <div class="tab" data-session="proxy">📊 Proxy Logs</div>
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
                            <select class="quick-replies" data-session="${session.id}">
                                <option value="">Quick Replies...</option>
                                <option value="Yes Please Proceed">Yes Please Proceed</option>
                                <option value="Explain in more detail please">Explain in more detail please</option>
                            </select>
                            <button class="send-button" data-session="${session.id}">Send</button>
                        </div>
                    </div>
                `).join('')
            }
            <div class="proxy-container" data-session="proxy">
                <div class="messages" id="proxy-logs">
                    <div style="opacity: 0.6; text-align: center; padding: 20px;">
                        Proxy logs will appear here when requests are made through the proxy.
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // Session management
        let activeSessionId = '${sessions[0]?.id || ''}';
        
        // Web interface is stateless - gets pending requests from server state
        
        // Server shutdown function
        async function shutdownServer() {
            if (!confirm('Are you sure you want to stop the server? This will disconnect all clients.')) {
                return;
            }
            
            try {
                const response = await fetch('/shutdown', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                if (response.ok) {
                    alert('Server is shutting down...');
                    // Close the window after a moment
                    setTimeout(() => window.close(), 1000);
                } else {
                    alert('Failed to stop server: ' + response.statusText);
                }
            } catch (error) {
                alert('Error stopping server: ' + error.message);
            }
        }
        
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
                // Remove new message indicator when switching to that tab
                if (tab.dataset.session === sessionId) {
                    tab.classList.remove('has-new-message');
                }
            });
            
            // Update active chat container
            document.querySelectorAll('.chat-container').forEach(container => {
                container.classList.toggle('active', container.dataset.session === sessionId);
            });
            
            // Update active proxy container
            document.querySelectorAll('.proxy-container').forEach(container => {
                container.classList.toggle('active', container.dataset.session === sessionId);
            });
            
            activeSessionId = sessionId;
            
            // Load proxy logs if switching to proxy tab
            if (sessionId === 'proxy') {
                loadProxyLogs();
            }
        }

        // Function to highlight tabs with new messages
        function highlightTabWithNewMessage(sessionId) {
            // Only highlight if it's not the currently active session
            if (sessionId !== activeSessionId) {
                const tab = document.querySelector(\`[data-session="\${sessionId}"].tab\`);
                if (tab && !tab.classList.contains('active')) {
                    tab.classList.add('has-new-message');
                }
            }
        }
        
        // Message sending
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('send-button')) {
                const sessionId = e.target.dataset.session;
                const textarea = document.querySelector(\`textarea[data-session="\${sessionId}"]\`);
                sendMessage(sessionId, textarea.value.trim());
            }
        });

        // Quick replies dropdown handling
        document.addEventListener('change', (e) => {
            if (e.target.classList.contains('quick-replies')) {
                const sessionId = e.target.dataset.session;
                const selectedReply = e.target.value;
                if (selectedReply) {
                    const textarea = document.querySelector(\`textarea[data-session="\${sessionId}"]\`);
                    textarea.value = selectedReply;
                    e.target.value = ''; // Reset dropdown
                    sendMessage(sessionId, selectedReply);
                }
            }
        });

        // Clipboard paste handling for images
        document.addEventListener('paste', async (e) => {
            if (e.target.classList.contains('input-box')) {
                const items = e.clipboardData.items;
                for (let i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') !== -1) {
                        e.preventDefault();
                        const blob = items[i].getAsFile();
                        const reader = new FileReader();
                        reader.onload = function(event) {
                            const base64Data = event.target.result.split(',')[1];
                            const sessionId = e.target.dataset.session;
                            const container = e.target.closest('.input-container');
                            
                            // Create image preview
                            const imagePreview = document.createElement('div');
                            imagePreview.className = 'image-preview';
                            imagePreview.innerHTML = \`<img src="data:\${blob.type};base64,\${base64Data}" alt="Pasted image"><span class="remove-image">×</span>\`;
                            imagePreview.dataset.imageData = base64Data;
                            imagePreview.dataset.mimeType = blob.type;
                            
                            container.insertBefore(imagePreview, e.target);
                            
                            imagePreview.querySelector('.remove-image').addEventListener('click', () => {
                                imagePreview.remove();
                            });
                        };
                        reader.readAsDataURL(blob);
                    }
                }
            }
        });
        
        // Auto-grow textarea as user types
        function autoGrowTextarea(textarea) {
            textarea.style.height = '36px'; // Reset to min height
            if (textarea.value) {
                const newHeight = Math.min(textarea.scrollHeight, 200); // Max 200px
                textarea.style.height = newHeight + 'px';
            }
        }

        // Listen for input on all textareas
        document.addEventListener('input', (e) => {
            if (e.target.classList.contains('input-box')) {
                autoGrowTextarea(e.target);
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
            const container = textarea.closest('.input-container');
            
            // Collect any attached images
            const imagePreviews = container.querySelectorAll('.image-preview');
            const images = Array.from(imagePreviews).map(preview => ({
                data: preview.dataset.imageData,
                mimeType: preview.dataset.mimeType
            }));
            
            // Clear input, remove images, reset height, and disable send button
            textarea.value = '';
            textarea.style.height = '36px'; // Reset to min height
            imagePreviews.forEach(preview => preview.remove());
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
                const responseBody = {
                    requestId: latestPendingRequest.requestId,
                    response: message,
                    source: 'web'
                };
                
                // Add images if any were pasted
                if (images.length > 0) {
                    responseBody.images = images;
                }
                
                const response = await fetch('/response', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(responseBody)
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
                addMessageToUI(sessionId, 'assistant', \`Error: \${error.message}\`, null, null);
                // Re-enable button only on error since we won't get SSE state update
                button.disabled = false;
            }
            // Note: Button is re-enabled by SSE 'waiting_for_response' state, not here
            textarea.focus();
        }
        
        function addMessageToUI(sessionId, role, content, source, timestamp) {
            const messagesContainer = document.getElementById(\`messages-\${sessionId}\`);
            if (!messagesContainer) return;
            
            const messageDiv = document.createElement('div');
            messageDiv.className = \`message \${role}\`;
            
            // Create header with source info
            let header = role === 'user' ? 'You' : 'Assistant';
            if (role === 'user' && source) {
                header += \` (\${source === 'web' ? 'Web' : 'VS Code'})\`;
            }
            
            // Use actual message timestamp or current time as fallback
            const displayTime = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
            
            messageDiv.innerHTML = \`
                <div class="message-header">\${header} • \${displayTime}</div>
                <div class="message-content">\${escapeHtml(content)}</div>
            \`;
            
            messagesContainer.appendChild(messageDiv);
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        
        function escapeHtml(text) {
            // Manually escape HTML characters while preserving line breaks
            return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
            // Line breaks are preserved and handled by CSS white-space: pre-wrap
        }
        
        // Proxy log functions
        async function loadProxyLogs() {
            try {
                const response = await fetch('/proxy/logs');
                const logs = await response.json();
                
                const proxyLogsContainer = document.getElementById('proxy-logs');
                proxyLogsContainer.innerHTML = '';
                
                if (logs.length === 0) {
                    proxyLogsContainer.innerHTML = '<div style="opacity: 0.6; text-align: center; padding: 20px;">No proxy logs yet. Requests will appear here when traffic goes through the proxy.</div>';
                } else {
                    logs.forEach(log => addProxyLogToUI(log, false));
                }
            } catch (error) {
                console.error('Failed to load proxy logs:', error);
            }
        }
        
        function addProxyLogToUI(logEntry, prepend = true) {
            const proxyLogsContainer = document.getElementById('proxy-logs');
            if (!proxyLogsContainer) return;
            
            // Remove placeholder if exists
            const placeholder = proxyLogsContainer.querySelector('div[style*="opacity: 0.6"]');
            if (placeholder) {
                placeholder.remove();
            }
            
            const logDiv = document.createElement('div');
            logDiv.className = 'proxy-log';
            logDiv.dataset.logId = logEntry.id;
            logDiv.style.cursor = 'pointer';
            
            const statusClass = logEntry.responseStatus >= 200 && logEntry.responseStatus < 300 ? 'success' : 'error';
            const statusText = logEntry.responseStatus ? logEntry.responseStatus : 'Pending';
            const duration = logEntry.duration ? \`\${logEntry.duration}ms\` : '-';
            
            // Format headers for display
            const formatHeaders = (headers) => {
                if (!headers || Object.keys(headers).length === 0) return '<i>No headers</i>';
                return Object.entries(headers)
                    .map(([key, value]) => \`<div><b>\${escapeHtml(key)}:</b> \${escapeHtml(String(value))}</div>\`)
                    .join('');
            };
            
            // Format body for display
            const formatBody = (body) => {
                if (!body) return '<i>No body</i>';
                if (typeof body === 'object') {
                    return '<pre>' + escapeHtml(JSON.stringify(body, null, 2)) + '</pre>';
                }
                return '<pre>' + escapeHtml(String(body)) + '</pre>';
            };
            
            logDiv.innerHTML = \`
                <div class="proxy-log-summary" onclick="toggleProxyLogDetails('\${logEntry.id}')">
                    <div class="proxy-log-header">
                        <span class="proxy-log-method">\${logEntry.method}</span>
                        <span class="proxy-log-status \${statusClass}">\${statusText}</span>
                        <span>\${duration}</span>
                        <span style="float: right;">▼</span>
                    </div>
                    <div class="proxy-log-url">\${escapeHtml(logEntry.url)}</div>
                </div>
                <div class="proxy-log-details" id="proxy-log-details-\${logEntry.id}" style="display: none;">
                    <div class="proxy-log-section">
                        <h4>Request Headers</h4>
                        \${formatHeaders(logEntry.requestHeaders)}
                    </div>
                    <div class="proxy-log-section">
                        <h4>Request Body</h4>
                        \${formatBody(logEntry.requestBody)}
                    </div>
                    <div class="proxy-log-section">
                        <h4>Response Headers</h4>
                        \${formatHeaders(logEntry.responseHeaders)}
                    </div>
                    <div class="proxy-log-section">
                        <h4>Response Body</h4>
                        \${formatBody(logEntry.responseBody)}
                    </div>
                </div>
            \`;
            
            if (prepend) {
                proxyLogsContainer.insertBefore(logDiv, proxyLogsContainer.firstChild);
            } else {
                proxyLogsContainer.appendChild(logDiv);
            }
            
            // Keep only last 200 logs
            while (proxyLogsContainer.children.length > 200) {
                proxyLogsContainer.removeChild(proxyLogsContainer.lastChild);
            }
        }
        
        function toggleProxyLogDetails(logId) {
            const details = document.getElementById(\`proxy-log-details-\${logId}\`);
            const arrow = document.querySelector(\`[data-log-id="\${logId}"] .proxy-log-summary span[style*="float"]\`);
            if (details && arrow) {
                if (details.style.display === 'none') {
                    details.style.display = 'block';
                    arrow.textContent = '▲';
                } else {
                    details.style.display = 'none';
                    arrow.textContent = '▼';
                }
            }
        }
        
        function updateProxyLogInUI(logEntry) {
            const logDiv = document.querySelector(\`[data-log-id="\${logEntry.id}"]\`);
            if (!logDiv) return;
            
            const statusClass = logEntry.responseStatus >= 200 && logEntry.responseStatus < 300 ? 'success' : 'error';
            const statusText = logEntry.responseStatus || 'Pending';
            const duration = logEntry.duration ? \`\${logEntry.duration}ms\` : '-';
            
            logDiv.innerHTML = \`
                <div class="proxy-log-header">
                    <span class="proxy-log-method">\${logEntry.method}</span>
                    <span class="proxy-log-status \${statusClass}">\${statusText}</span>
                    <span>\${duration}</span>
                </div>
                <div class="proxy-log-url">\${escapeHtml(logEntry.url)}</div>
            \`;
        }
        
        function updateSessionTabName(sessionId, newName) {
            // Update the tab title for the specified session
            const tabElement = document.querySelector(\`[data-session="\${sessionId}"]\`);
            if (tabElement) {
                tabElement.textContent = newName;
                console.log(\`Updated tab name for session \${sessionId} to: \${newName}\`);
            } else {
                console.log(\`Could not find tab element for session \${sessionId}\`);
            }
        }

        function addSessionTab(sessionId) {
            // Check if tab already exists
            const existingTab = document.querySelector(\`[data-session="\${sessionId}"].tab\`);
            if (existingTab) {
                console.log(\`Tab for session \${sessionId} already exists\`);
                return;
            }

            const tabsContainer = document.getElementById('tabs');
            const contentDiv = document.querySelector('.content');
            
            if (!tabsContainer || !contentDiv) {
                console.error('Could not find tabs container or content div');
                return;
            }

            // Create new tab
            const tabElement = document.createElement('div');
            tabElement.className = 'tab';
            tabElement.setAttribute('data-session', sessionId);
            tabElement.textContent = \`Session: \${sessionId.substring(0, 8)}\`;
            tabElement.onclick = () => switchToSession(sessionId);
            
            // Add tab to container
            tabsContainer.appendChild(tabElement);

            // Create new chat container
            const chatContainer = document.createElement('div');
            chatContainer.className = 'chat-container';
            chatContainer.setAttribute('data-session', sessionId);
            chatContainer.innerHTML = \`
                <div class="messages" id="messages-\${sessionId}">
                    <!-- Messages will be loaded dynamically -->
                </div>
                <div class="input-container">
                    <textarea class="input-box" placeholder="Type your message..." data-session="\${sessionId}"></textarea>
                    <select class="quick-replies" data-session="\${sessionId}">
                        <option value="">Quick Replies...</option>
                        <option value="Yes Please Proceed">Yes Please Proceed</option>
                        <option value="Explain in more detail please">Explain in more detail please</option>
                    </select>
                    <button class="send-button" data-session="\${sessionId}">Send</button>
                </div>
            \`;
            
            // Add chat container to content
            contentDiv.appendChild(chatContainer);

            // Set up event listeners for new input elements
            const textarea = chatContainer.querySelector('textarea');
            const button = chatContainer.querySelector('button');
            
            if (textarea) {
                textarea.addEventListener('keypress', function(e) {
                    if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendResponse(sessionId);
                    }
                });
            }
            
            if (button) {
                button.addEventListener('click', () => sendResponse(sessionId));
            }

            console.log(\`Added new session tab: \${sessionId}\`);
        }

        function removeSessionTab(sessionId) {
            // Remove tab
            const tabElement = document.querySelector(\`[data-session="\${sessionId}"].tab\`);
            if (tabElement) {
                tabElement.remove();
            }

            // Remove chat container
            const chatContainer = document.querySelector(\`[data-session="\${sessionId}"].chat-container\`);
            if (chatContainer) {
                chatContainer.remove();
            }

            // If this was the active session, switch to first available
            const remainingTabs = document.querySelectorAll('.tab');
            if (remainingTabs.length > 0) {
                const firstTab = remainingTabs[0];
                const firstSessionId = firstTab.getAttribute('data-session');
                if (firstSessionId) {
                    switchToSession(firstSessionId);
                }
            }

            console.log(\`Removed session tab: \${sessionId}\`);
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
                                addMessageToUI(sessionId, msg.sender, msg.content, msg.source, msg.timestamp);
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
                                addMessageToUI(sessionId, msg.sender, msg.content, msg.source, msg.timestamp);
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
            const eventSource = new EventSource('/mcp?clientType=web');
            
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
                    
                    // Handle proxy log updates
                    if (data.type === 'proxy-log') {
                        addProxyLogToUI(data.data);
                    } else if (data.type === 'proxy-log-update') {
                        updateProxyLogInUI(data.data);
                    }
                    // Handle different types of updates
                    else if (data.type === 'chat_message' && data.sessionId && data.message) {
                        addMessageToUI(data.sessionId, data.message.sender, data.message.content, data.message.source, data.message.timestamp);
                        // Highlight tab if not currently active
                        highlightTabWithNewMessage(data.sessionId);
                    } else if (data.type === 'message' && data.sessionId) {
                        addMessageToUI(data.sessionId, data.role || 'assistant', data.content, null, null);
                        // Highlight tab if not currently active
                        highlightTabWithNewMessage(data.sessionId);
                    } else if (data.type === 'request-state-change' && data.data) {
                        // Handle request state changes for input control
                        console.log('Web interface received request-state-change:', data.data);
                        
                        const stateData = data.data;
                        
                        if (stateData.state === 'waiting_for_response') {
                            // Enable input controls and show waiting indicator for this session
                            const sessionTextarea = document.querySelector(\`textarea[data-session="\${stateData.sessionId}"]\`);
                            const sessionButton = document.querySelector(\`button[data-session="\${stateData.sessionId}"]\`);
                            const messagesContainer = document.getElementById(\`messages-\${stateData.sessionId}\`);
                            
                            if (sessionTextarea && sessionButton) {
                                sessionButton.disabled = false;
                                sessionTextarea.focus();
                            }
                            
                            // Add waiting indicator
                            if (messagesContainer) {
                                const existingWaiting = messagesContainer.querySelector('.waiting-indicator');
                                if (!existingWaiting) {
                                    const waitingDiv = document.createElement('div');
                                    waitingDiv.className = 'waiting-indicator';
                                    waitingDiv.textContent = '⏳ Waiting for your response...';
                                    messagesContainer.appendChild(waitingDiv);
                                }
                            }
                            
                        } else if (stateData.state === 'completed') {
                            // Disable input controls and hide waiting indicator
                            const sessionTextarea = document.querySelector(\`textarea[data-session="\${stateData.sessionId}"]\`);
                            const sessionButton = document.querySelector(\`button[data-session="\${stateData.sessionId}"]\`);
                            const messagesContainer = document.getElementById(\`messages-\${stateData.sessionId}\`);
                            
                            if (sessionButton) {
                                sessionButton.disabled = true;
                            }
                            
                            // Remove waiting indicator
                            if (messagesContainer) {
                                const waitingIndicator = messagesContainer.querySelector('.waiting-indicator');
                                if (waitingIndicator) {
                                    waitingIndicator.remove();
                                }
                            }
                        }
                    } else if (data.type === 'session_update') {
                        // Refresh the page to show new sessions
                        window.location.reload();
                    } else if (data.type === 'session-registered' && data.data) {
                        // Add new session tab dynamically
                        console.log('New session registered:', data.data);
                        addSessionTab(data.data.sessionId);
                    } else if (data.type === 'session-unregistered' && data.data) {
                        // Remove session tab dynamically
                        console.log('Session unregistered:', data.data);
                        removeSessionTab(data.data.sessionId);
                    } else if (data.type === 'session-name-changed' && data.data) {
                        // Handle session name changes
                        console.log('Session name changed:', data.data);
                        updateSessionTabName(data.data.sessionId, data.data.name);
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
    // Use extension session ID if available, otherwise extract from message params
    let sessionIdToUse = this.sessionId; // Extension session ID
    
    // If no extension session, try to extract from message params
    if (!sessionIdToUse && message.params?.sessionId) {
      sessionIdToUse = message.params.sessionId;
    }
    
    this.debugLogger.log('TOOLS', `tools/list request - Extension sessionId: ${this.sessionId}, Message params: ${JSON.stringify(message.params)}`);
    this.debugLogger.log('TOOLS', `Final sessionIdToUse: ${sessionIdToUse || 'default'}`);
    this.debugLogger.log('TOOLS', `Available session tools: ${Array.from(this.sessionTools.keys()).join(', ')}`);
    
    const tools = this.getAvailableTools(sessionIdToUse);
    
    this.debugLogger.log('TOOLS', `Returning ${tools.length} tools for session: ${sessionIdToUse || 'default'}`);
    if (sessionIdToUse) {
      this.debugLogger.log('TOOLS', `Using session-specific tools for: ${sessionIdToUse}`);
      const sessionTools = this.sessionTools.get(sessionIdToUse);
      if (sessionTools) {
        this.debugLogger.log('TOOLS', `Session tools found: ${Array.from(sessionTools.keys()).join(', ')}`);
        // Log the actual HumanAgent_Chat tool description
        const chatTool = sessionTools.get('HumanAgent_Chat');
        if (chatTool) {
          this.debugLogger.log('TOOLS', `HumanAgent_Chat description: ${chatTool.description.substring(0, 100)}...`);
        }
      }
    } else {
      this.debugLogger.log('TOOLS', `Using default tools (no session ID available)`);
      // Also log default tool description for comparison
      const defaultChatTool = this.tools.get('HumanAgent_Chat');
      if (defaultChatTool) {
        this.debugLogger.log('TOOLS', `Default HumanAgent_Chat description: ${defaultChatTool.description.substring(0, 100)}...`);
      }
    }
    
    return {
      id: message.id,
      type: 'response',
      result: { tools }
    };
  }

  private async handleToolCall(message: McpMessage): Promise<McpMessage> {
    const { name, arguments: args } = message.params;
    // Use actual session ID from MCP message context, not tool argument
    const sessionId = message.params.sessionId;
    
    this.debugLogger.log('MCP', `Tool call - name: "${name}", sessionId: ${sessionId}`, { name, args });
    
    // Check session-specific tools first, then default tools
    const sessionTools = sessionId ? this.sessionTools.get(sessionId) : null;
    const availableTools = sessionTools || this.tools;
    
    this.debugLogger.log('MCP', `Available tools for session ${sessionId || 'default'}:`, Array.from(availableTools.keys()));
    
    if (name === 'HumanAgent_Chat' && availableTools.has(name)) {
      this.debugLogger.log('MCP', 'Executing HumanAgent_Chat tool');
      return await this.handleHumanAgentChatTool(message.id, args, sessionId, name);
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

  private async handleHumanAgentChatTool(messageId: string, params: HumanAgentChatToolParams, sessionId?: string, toolName?: string): Promise<McpMessage> {
    this.debugLogger.log('TOOL', 'HumanAgent_Chat called with params:', params);
    
    // Require valid session ID - no default fallback allowed
    const actualSessionId = sessionId || params.sessionId;
    if (!actualSessionId) {
      this.debugLogger.log('ERROR', 'HumanAgent_Chat tool called without session ID - rejecting');
      return {
        id: messageId,
        type: 'response',
        error: {
          code: -32602,
          message: 'Invalid parameters: sessionId is required for HumanAgent_Chat tool'
        }
      };
    }
    
    const startTime = Date.now();
    // No timeout - wait indefinitely for human response
    this.debugLogger.log('TOOL', 'No timeout configured - will wait indefinitely for human response');
    
    // Generate unique request ID for tracking this specific request
    const requestId = `${messageId}-${Date.now()}`;
    this.debugLogger.log('TOOL', `Generated request ID: ${requestId}`);
    
    // Display message directly in chat UI (no sessions needed)  
    const displayMessage = params.context ? `${params.context}\n\n${params.message}` : params.message;
    this.debugLogger.log('TOOL', 'Displaying message in chat UI:', displayMessage);
    
    // Wait for human response (no timeout)
    return new Promise((resolve) => {
      // Use the validated session ID
      this.debugLogger.log('TOOL', `Adding pending request ${requestId} to session: ${actualSessionId}`);
      
      // Store the AI's message (this IS the AI communication - it talks by calling the tool)
      const aiMessage: ChatMessage = {
        id: requestId, // Use request ID to link with pending request
        content: displayMessage,
        sender: 'agent',
        timestamp: new Date(),
        type: 'text'
      };
      this.chatManager.addMessage(actualSessionId, aiMessage);
      this.debugLogger.log('CHAT', `Stored AI message in ChatManager for session ${actualSessionId}: ${aiMessage.content.substring(0, 50)}...`);
      this.broadcastMessageToClients(actualSessionId, aiMessage);
      
      // Emit request state to enable input controls and show waiting indicator
      this.emit('request-state-change', {
        requestId,
        sessionId: actualSessionId,
        state: 'waiting_for_response',
        message: params.message,
        context: params.context,
        timestamp: new Date().toISOString()
      });
      
      this.chatManager.addPendingRequest(actualSessionId, requestId, { ...params, toolName: toolName || 'HumanAgent_Chat' });
      this.requestResolvers.set(requestId, {
        resolve: (response: string) => {
          const responseTime = Date.now() - startTime;
          this.debugLogger.log('TOOL', `Request ${requestId} completed with response:`, response);
          
          // Emit request completed state to disable input controls and hide waiting indicator
          this.emit('request-state-change', {
            requestId,
            sessionId: actualSessionId,
            state: 'completed',
            response: response,
            timestamp: new Date().toISOString()
          });
          
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
    let tools: McpTool[];
    
    if (sessionId && this.sessionTools.has(sessionId)) {
      tools = Array.from(this.sessionTools.get(sessionId)!.values());
    } else {
      // Fall back to default tools
      tools = Array.from(this.tools.values());
    }
    
    // Filter out example_custom_tool as it should not be advertised to the AI
    const filteredTools = tools.filter(tool => tool.name !== 'example_custom_tool');
    
    this.debugLogger.log('TOOLS', `Filtered ${tools.length - filteredTools.length} example tools from list`);
    
    return filteredTools;
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
      
      // Store messageSettings if present in override data
      if (overrideData.messageSettings) {
        this.sessionMessageSettings.set(sessionId, overrideData.messageSettings);
        this.debugLogger.log('INFO', `Stored message settings for session ${sessionId}:`, overrideData.messageSettings);
      }
    } else if (workspacePath) {
      this.initializeSessionTools(sessionId, workspacePath);
    }
    
    this.debugLogger.log('INFO', `Session registered: ${sessionId} (${this.activeSessions.size} total sessions)`);
    
    // Send session registration to web interface only (for web UI tab creation)
    this.sendToWebInterface('session-registered', { sessionId, totalSessions: this.activeSessions.size });
  }



  unregisterSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    // Clean up session-specific data
    this.sessionTools.delete(sessionId);
    this.sessionWorkspacePaths.delete(sessionId);
    this.sessionMessageSettings.delete(sessionId);
    this.debugLogger.log('INFO', `Session unregistered and cleaned up: ${sessionId} (${this.activeSessions.size} total sessions)`);
    
    // Send session unregistration to web interface only (for web UI tab removal)
    this.sendToWebInterface('session-unregistered', { sessionId, totalSessions: this.activeSessions.size });
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
      
      // Notify MCP client that tools have changed after reload
      this.sendMcpNotification('notifications/tools/list_changed');
      this.debugLogger.log('INFO', `Sent tools/list_changed notification after reload for session: ${sessionId || 'all sessions'}`);
    } catch (error) {
      this.debugLogger.log('ERROR', 'Failed to reload workspace overrides:', error);
      throw error;
    }
  }

  // Message storage and synchronization methods - now using ChatManager
  // Removed: storeMessage and getSessionMessages wrapper methods - call ChatManager directly

  private broadcastMessageToClients(sessionId: string, message: ChatMessage): void {
    // Send message to specific session AND all web interface connections
    const messageEvent = {
      type: 'chat_message',
      sessionId: sessionId,
      message: {
        id: message.id,
        content: message.content,
        sender: message.sender,
        timestamp: message.timestamp.toISOString(),
        source: message.source
      }
    };
    
    const sseData = `data: ${JSON.stringify(messageEvent)}\n\n`;
    
    // Send to the specific session's SSE connection (VS Code webview)
    const sessionConnection = this.sseClients.get(sessionId);
    if (sessionConnection) {
      try {
        sessionConnection.write(sseData);
        this.debugLogger.log('CHAT', `Sent message to VS Code session ${sessionId}`);
      } catch (error) {
        this.debugLogger.log('ERROR', `Failed to send message to VS Code session ${sessionId}:`, error);
        // Remove failed connection
        this.sseClients.delete(sessionId);
        this.sseConnections.delete(sessionConnection);
      }
    } else {
      this.debugLogger.log('WARN', `No VS Code SSE connection found for session ${sessionId}`);
    }
    
    // Also send to all web interface connections
    for (const webConnection of this.webInterfaceConnections) {
      try {
        webConnection.write(sseData);
        this.debugLogger.log('CHAT', `Sent message to web interface for session ${sessionId}`);
      } catch (error) {
        this.debugLogger.log('ERROR', `Failed to send message to web interface:`, error);
        // Remove failed connection
        this.webInterfaceConnections.delete(webConnection);
        this.sseConnections.delete(webConnection);
      }
    }
  }
}