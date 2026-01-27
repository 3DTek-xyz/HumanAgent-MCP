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

// JSONata for advanced JSON transformations
let jsonata: any = null;
try {
    jsonata = require('jsonata');
} catch (error) {
    console.log('[MCP Server] JSONata not installed - JSON transformations will use JSONPath only');
}

// Minimal interface for VS Code Memento (globalStorage)
interface Memento {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: any): Thenable<void>;
}

/**
 * Simple file-based storage that mimics VS Code Memento interface
 * Used by standalone server when VS Code Memento is not available
 */
class FileBasedStorage implements Memento {
  private storageFile: string;
  private data: Record<string, any> = {};

  constructor(storagePath: string) {
    this.storageFile = path.join(storagePath, 'mcp-global-storage.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storageFile)) {
        const content = fs.readFileSync(this.storageFile, 'utf8');
        this.data = JSON.parse(content);
      }
    } catch (error) {
      console.error('[FileBasedStorage] Failed to load storage:', error);
      this.data = {};
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.storageFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.storageFile, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      console.error('[FileBasedStorage] Failed to save storage:', error);
    }
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const value = this.data[key];
    return value !== undefined ? value : defaultValue;
  }

  update(key: string, value: any): Promise<void> {
    this.data[key] = value;
    this.save();
    return Promise.resolve();
  }
}

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
  private vscodeSessionMapping: Map<string, { sessionId: string, workspacePath?: string }> = new Map(); // VS Code session ID → {MCP session ID, workspace path}
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
  private globalStorage?: Memento; // VS Code globalStorage for persisting global settings like proxy rules

  // Helper method for ProxyServer to lookup MCP session ID and workspace path from VS Code session ID
  private getSessionContextFromVSCodeSession(vscodeSessionId: string): { sessionId: string, workspacePath?: string } | undefined {
    return this.vscodeSessionMapping.get(vscodeSessionId);
  }

  constructor(private sessionId?: string, private workspacePath?: string, port?: number) {
    super();
    if (port) {
      this.port = port;
    }
    this.debugLogger = new DebugLogger(this.workspacePath);
    this.chatManager = new ChatManager(this.debugLogger); // Initialize centralized chat management with logging
    
    // Initialize proxy server with session context lookup callback
    this.proxyServer = new ProxyServer((vscodeSessionId: string) => {
      return this.vscodeSessionMapping.get(vscodeSessionId);
    });
    
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

  /**
   * Set the global storage (VS Code Memento) for persisting global settings
   * Must be called by extension after creating McpServer instance
   */
  setGlobalStorage(storage: Memento): void {
    this.globalStorage = storage;
    this.debugLogger.log('INFO', 'GlobalStorage configured for McpServer');
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
    
    // Update proxy server context for rule filtering
    // Note: We're using the FIRST registered session as the "active" one for proxy rules
    // This means workspace/session-scoped rules will apply to the first workspace that registered
    this.proxyServer.setSessionContext(sessionId);
    this.proxyServer.setWorkspaceContext(workspacePath);
    this.debugLogger.log('INFO', `Set proxy context - Session: ${sessionId}, Workspace: ${workspacePath}`);
    
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
    
    // Initialize file-based storage if globalStorage not set (standalone server)
    if (!this.globalStorage) {
      const certStoragePath = process.env.HUMANAGENT_CERT_STORAGE_PATH;
      if (certStoragePath) {
        this.globalStorage = new FileBasedStorage(certStoragePath);
        this.debugLogger.log('INFO', `Initialized file-based storage at: ${certStoragePath}`);
      } else {
        this.debugLogger.log('WARN', 'No globalStorage or cert storage path configured - proxy rules will not persist');
      }
    }
    
    await this.startHttpServer();
    
    // Start proxy server with HTTPS support
    try {
      // Get certificate storage path from environment variable (passed by extension)
      const certStoragePath = process.env.HUMANAGENT_CERT_STORAGE_PATH;
      const httpsOptions = await initializeProxyCA(certStoragePath);
      
      // Load and set proxy rules before starting
      const rules = await this.getProxyRules();
      
      // Initialize default example rules if this is a fresh setup
      await this.initializeDefaultRules();
      
      // Get rules again after potential default rule initialization
      const finalRules = await this.getProxyRules();
      this.proxyServer.setRules(finalRules);
      this.debugLogger.log('INFO', `Loaded ${finalRules.length} proxy rules for proxy server`);
      
      const proxyPort = await this.proxyServer.start(httpsOptions);
      
      // Restore session context for active sessions
      const activeSessions = this.getActiveSessions();
      if (activeSessions.length > 0) {
        // Set context to the first active session (primary session)
        const primarySessionId = activeSessions[0];
        const primaryWorkspace = this.sessionWorkspacePaths.get(primarySessionId);
        this.proxyServer.setSessionContext(primarySessionId);
        this.proxyServer.setWorkspaceContext(primaryWorkspace);
        this.debugLogger.log('INFO', `Restored proxy context - Session: ${primarySessionId}, Workspace: ${primaryWorkspace || 'none'}`);
      }
      
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
    } else if (req.url === '/jsonata-rule-builder.html') {
      // Visual rule builder interface
      await this.handleRuleBuilderInterface(req, res);
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
          const { sessionId, vscodeSessionId, workspacePath, overrideData, forceReregister } = JSON.parse(body);
          
          this.debugLogger.log('HTTP', `Registering session ${sessionId} with VS Code session ID: ${vscodeSessionId || 'none'}, workspace: ${workspacePath || 'none'}`);
          
          // Store VS Code session ID mapping if provided (with workspace path)
          if (vscodeSessionId) {
            this.vscodeSessionMapping.set(vscodeSessionId, { sessionId, workspacePath });
            this.debugLogger.log('INFO', `Stored session mapping: ${vscodeSessionId} → {sessionId: ${sessionId}, workspacePath: ${workspacePath || 'none'}}`);
          }
          
          // Store workspace path for this session (always store it, even with overrideData)
          if (workspacePath) {
            this.sessionWorkspacePaths.set(sessionId, workspacePath);
            this.debugLogger.log('INFO', `Stored workspace path for session ${sessionId}: ${workspacePath}`);
          }
          
          // If session exists and forceReregister is true, unregister first
          if (forceReregister && this.activeSessions.has(sessionId)) {
            this.debugLogger.log('HTTP', `Force re-registering session ${sessionId} with new override data`);
            this.unregisterSession(sessionId);
          }
          
          this.registerSession(sessionId, workspacePath, overrideData);
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
      // List active sessions with their names
      const sessions = this.getActiveSessions().map(sessionId => ({
        id: sessionId,
        name: this.sessionNames.get(sessionId) || 'Unnamed Session',
        workspacePath: this.sessionWorkspacePaths.get(sessionId)
      }));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ sessions, totalSessions: this.activeSessions.size }));
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
        let parsed: any;
        try {
          parsed = JSON.parse(body);
        } catch (error) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON body' }));
          return;
        }

        const { requestId, response, source } = parsed || {};
        if (!requestId || typeof requestId !== 'string' || typeof response !== 'string') {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'requestId (string) and response (string) are required' }));
          return;
        }

        try {
          this.debugLogger.log('HTTP', '=== RESPONSE ENDPOINT CALLED ===');
          this.debugLogger.log('HTTP', `Request ID: ${requestId}, Response length: ${response.length}`);
          
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
              this.debugLogger.log('HTTP', `Auto-appended text for AI (len=${messageSettings.autoAppendText.length})`);
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
          this.debugLogger.log('ERROR', 'Unhandled error processing /response:', error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: false, error: 'Internal error handling response' }));
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
    } else if (req.method === 'GET' && url.pathname === '/debug/proxy-logs') {
      // Serve standalone proxy logs page with debug logs
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      
      const htmlContent = this.generateProxyLogsOnlyHTML();
      res.end(htmlContent);
    } else if (req.method === 'GET' && url.pathname.startsWith('/debug/proxy')) {
      // Debug endpoint to inspect proxy server state and logs
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      
      try {
        if (!this.proxyServer) {
          res.end(JSON.stringify({ 
            error: 'Proxy server not initialized',
            available: false
          }));
          return;
        }
        
        const proxyStatus = this.proxyServer.getStatus();
        const proxyRules = this.proxyServer.getRules();
        
        // Try to capture recent console logs from proxy server
        // Note: This is a simplified version - real console capturing would need more setup
        const debugInfo = {
          timestamp: new Date().toISOString(),
          proxyStatus: proxyStatus,
          rulesCount: proxyRules.length,
          enabledRules: proxyRules.filter(r => r.enabled).length,
          rules: proxyRules.map(r => ({
            id: r.id,
            name: r.name,
            pattern: r.pattern,
            enabled: r.enabled,
            hasJsonata: !!r.jsonata,
            dropRequest: !!r.dropRequest
          })),
          karenRule: proxyRules.find(r => r.name && r.name.toLowerCase().includes('karen')),
          message: 'Proxy debug info captured - check VS Code Output panel or system console for detailed [ProxyServer] logs'
        };
        
        res.end(JSON.stringify(debugInfo, null, 2));
      } catch (error) {
        res.end(JSON.stringify({ 
          error: 'Failed to get proxy debug info',
          details: error instanceof Error ? error.message : 'Unknown error'
        }));
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

  private generateProxyLogsOnlyHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Proxy Debug Logs</title>
    <style>
        body { 
            font-family: Monaco, "Courier New", monospace; 
            background: #000; 
            color: #00ff00; 
            margin: 0; 
            padding: 10px; 
            font-size: 12px;
            line-height: 1.2;
        }
        .header {
            color: #ffffff;
            padding: 10px 0;
            border-bottom: 1px solid #333;
            margin-bottom: 10px;
        }
        .log-entry {
            margin-bottom: 2px;
            padding: 2px 0;
            word-wrap: break-word;
        }
        .timestamp { color: #888; }
        .karen { color: #ff69b4; font-weight: bold; }
        .master { color: #ffff00; }
        .error { color: #ff4444; }
        .success { color: #44ff44; }
        .clear-btn {
            background: #ff4444;
            color: white;
            border: none;
            padding: 5px 10px;
            cursor: pointer;
            font-family: inherit;
        }
    </style>
</head>
<body>
    <div class="header">
        PROXY DEBUG LOG - REAL TIME
        <button class="clear-btn" onclick="clearAll()">CLEAR ALL</button>
    </div>
    
    <div id="logs"></div>

    <script>
        const logsContainer = document.getElementById('logs');
        let lastTimestamp = null; // Track last log timestamp instead of count

        function addLogEntry(timestamp, message) {
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            entry.dataset.timestamp = timestamp; // Store timestamp for tracking
            
            let className = '';
            if (message.includes('KAREN')) className = 'karen';
            else if (message.includes('MASTER HANDLER')) className = 'master';
            else if (message.includes('ERROR')) className = 'error';
            else if (message.includes('SUCCESS')) className = 'success';
            
            entry.innerHTML = \`<span class="timestamp">\${timestamp}</span> <span class="\${className}">\${message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>\`;
            logsContainer.appendChild(entry);
            
            // Keep only last 500 entries in DOM
            while (logsContainer.children.length > 500) {
                logsContainer.removeChild(logsContainer.firstChild);
            }
            
            // Auto-scroll to bottom
            window.scrollTo(0, document.body.scrollHeight);
        }

        async function fetchNewLogs() {
            try {
                const response = await fetch('/proxy/logs');
                const data = await response.json();
                const debugLogs = data.debugLogs || [];
                
                if (debugLogs.length === 0) {
                    return; // No logs yet
                }
                
                // On first load or after clear, add all logs
                if (lastTimestamp === null) {
                    debugLogs.forEach(log => {
                        addLogEntry(log.timestamp, log.message);
                    });
                    if (debugLogs.length > 0) {
                        lastTimestamp = debugLogs[debugLogs.length - 1].timestamp;
                    }
                } else {
                    // Only add logs newer than our last timestamp
                    const newLogs = debugLogs.filter(log => log.timestamp > lastTimestamp);
                    newLogs.forEach(log => {
                        addLogEntry(log.timestamp, log.message);
                    });
                    if (newLogs.length > 0) {
                        lastTimestamp = newLogs[newLogs.length - 1].timestamp;
                    }
                }
            } catch (error) {
                addLogEntry(new Date().toISOString(), 'ERROR: Failed to fetch logs - ' + error.message);
            }
        }

        async function clearAll() {
            try {
                await fetch('/proxy/clear-logs', { method: 'POST' });
                logsContainer.innerHTML = '';
                lastTimestamp = null;
                addLogEntry(new Date().toISOString(), 'LOGS CLEARED');
            } catch (error) {
                addLogEntry(new Date().toISOString(), 'ERROR: Failed to clear logs - ' + error.message);
            }
        }

        // Fetch new logs every 200ms for more real-time feel
        setInterval(fetchNewLogs, 200);
        
        // Initial load
        fetchNewLogs();
    </script>
</body>
</html>`;
  }

  private generateRuleBuilderHTML(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>JSONata Query Tester - Build and Test JSON Transformations</title>
    <script src="https://cdn.jsdelivr.net/npm/jsonata@2.0.3/jsonata.min.js"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            margin: 0;
            padding: 0;
            background: #f5f5f5;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            background: #007acc;
            color: white;
            padding: 15px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .header h1 {
            margin: 0;
            font-size: 18px;
        }
        .header .actions {
            display: flex;
            gap: 10px;
        }
        .btn {
            background: rgba(255,255,255,0.2);
            color: white;
            border: 1px solid rgba(255,255,255,0.3);
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .btn:hover {
            background: rgba(255,255,255,0.3);
        }
        .btn-primary {
            background: #28a745;
            border-color: #28a745;
        }
        .btn-primary:hover {
            background: #218838;
        }
        .main-container {
            flex: 1;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            padding: 10px;
            height: calc(100vh - 70px);
            overflow: hidden;
        }
        .pane {
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .pane-header {
            background: #f8f9fa;
            padding: 12px 16px;
            border-bottom: 1px solid #e9ecef;
            font-weight: 600;
            color: #495057;
        }
        .pane-content {
            flex: 1;
            padding: 0;
            overflow: auto;
        }
        .json-editor {
            width: 100%;
            height: 100%;
            border: none;
            font-family: 'Monaco', 'Consolas', 'Courier New', monospace;
            font-size: 12px;
            padding: 16px;
            resize: none;
            background: #2d3748;
            color: #e2e8f0;
            box-sizing: border-box;
        }
        .query-editor {
            width: 100%;
            height: 120px;
            border: none;
            font-family: 'Monaco', 'Consolas', 'Courier New', monospace;
            font-size: 12px;
            padding: 16px;
            resize: none;
            border-bottom: 1px solid #e9ecef;
            box-sizing: border-box;
        }
        .result-display {
            flex: 1;
            padding: 16px;
            font-family: 'Monaco', 'Consolas', 'Courier New', monospace;
            font-size: 12px;
            background: #f8f9fa;
            white-space: pre-wrap;
            overflow: auto;
        }
        .query-help {
            padding: 16px;
            font-size: 11px;
            color: #6c757d;
            border-bottom: 1px solid #e9ecef;
            background: #f8f9fa;
        }
        .error {
            color: #dc3545;
            background: #f8d7da;
            padding: 8px 16px;
            margin: 8px 16px;
            border-radius: 4px;
            font-size: 11px;
        }
        .success {
            color: #155724;
            background: #d4edda;
            padding: 8px 16px;
            margin: 8px 16px;
            border-radius: 4px;
            font-size: 11px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔍 JSONata Query Tester</h1>
        <div class="actions">
            <button class="btn" onclick="copyQuery()">📋 Copy Query</button>
            <button class="btn btn-primary" onclick="createProxyRule()">✅ Create Proxy Rule</button>
        </div>
    </div>

    <div class="main-container">
        <!-- Left Pane: JSON Data -->
        <div class="pane">
            <div class="pane-header">📄 Source JSON Data</div>
            <div class="pane-content">
                <textarea id="json-data" class="json-editor" placeholder="Paste JSON data here or load from proxy logs..."></textarea>
            </div>
        </div>

        <!-- Right Pane: JSONata Transformation -->
        <div class="pane">
            <div class="pane-header">🔧 JSONata Transformation</div>
            <div class="pane-content">
                <div style="padding: 10px; font-size: 11px; color: #666; border-bottom: 1px solid #e9ecef; background: #f8f9fa;">
                    <strong>💡 Examples:</strong><br>
                    <code>$</code> - Return entire object<br>
                    <code>$.name</code> - Get name field<br>  
                    <code>$replace(name, /old/, "new")</code> - Replace text<br>
                    <code>{"newName": name, "modified": true}</code> - Create new object<br>
                    <br>📖 <a href="https://jsonata.org/" target="_blank" style="color: #ff8c00; text-decoration: underline;">Full JSONata Documentation</a>
                </div>
                <textarea id="transformation-query" class="query-editor" placeholder="Enter JSONata transformation...
}" oninput="executeTransformation()"></textarea>
                <div class="result-display" id="transformation-result">
                    <em style="color: #6c757d;">Full transformation results will appear here...</em>
                </div>
            </div>
        </div>
    </div>

    <script>
        let currentJsonData = null;
        
        // HTML escape function
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }



        // Execute full JSONata transformation
        async function executeTransformation() {
            const query = document.getElementById('transformation-query').value.trim();
            const resultDiv = document.getElementById('transformation-result');
            
            if (!query) {
                resultDiv.innerHTML = '<em style="color: #6c757d;">Enter a JSONata transformation above...</em>';
                return;
            }
            
            if (!currentJsonData) {
                resultDiv.innerHTML = '<div class="error">No JSON data available. Check the left pane.</div>';
                return;
            }
            
            try {
                // Execute real JSONata transformation
                console.log('JSONata Debug - Library type:', typeof jsonata);
                console.log('JSONata Debug - Library exists:', typeof jsonata !== 'undefined');
                
                if (typeof jsonata === 'undefined') {
                    resultDiv.innerHTML = '<div class="error">JSONata library not loaded. Please refresh the page.</div>';
                    return;
                }
                
                // Debug: show data structure info
                console.log('JSONata Debug - Data type:', typeof currentJsonData);
                console.log('JSONata Debug - Is Array:', Array.isArray(currentJsonData));
                console.log('JSONata Debug - Data sample:', currentJsonData);
                console.log('JSONata Debug - Query:', query);
                
                const expression = jsonata(query);
                console.log('JSONata Debug - Expression created:', !!expression);
                
                const result = await expression.evaluate(currentJsonData);
                console.log('JSONata Debug - Result:', result);
                console.log('JSONata Debug - Result type:', typeof result);
                
                // Display the actual result with helpful info
                let debugInfo = '';
                if (Array.isArray(currentJsonData)) {
                    debugInfo = '<div style="background: #fff3cd; padding: 8px; border-radius: 4px; margin-bottom: 8px; font-size: 11px;">' +
                               '💡 <strong>Your data is an array</strong> - try <code>$[0].name</code> or <code>$.*</code> to access elements</div>';
                }
                
                resultDiv.innerHTML = debugInfo + 
                    '<div class="success">✅ <strong>JSONata Result:</strong></div>' +
                    '<pre style="background: #f8f9fa; padding: 10px; border-radius: 4px; font-size: 11px; max-height: 400px; overflow: auto;">' +
                    escapeHtml(JSON.stringify(result, null, 2)) + '</pre>';
                    
            } catch (e) {
                resultDiv.innerHTML = '<div class="error">JSONata Error: ' + e.message + 
                    '<br><small>Check your JSONata syntax. Examples: <code>$.name</code>, <code>$replace(name, /old/, "new")</code></small></div>';
            }
        }

        // Copy current query to clipboard
        function copyQuery() {
            const query = document.getElementById('transformation-query').value;
            if (query) {
                navigator.clipboard.writeText(query);
                showMessage('✅ Query copied to clipboard!');
            } else {
                showMessage('❌ No query to copy');
            }
        }

        // Create proxy rule from current transformation
        function createProxyRule() {
            const transformationQuery = document.getElementById('transformation-query').value.trim();
            if (!transformationQuery) {
                showMessage('❌ Please enter a transformation query first');
                return;
            }
            
            // Prompt for rule name
            const ruleName = prompt('Enter a name for this rule (e.g., "Karen Personality", "Add Session ID")', 'JSONata Rule');
            if (!ruleName || !ruleName.trim()) {
                showMessage('❌ Rule creation cancelled - name is required');
                return;
            }
            
            // Create rule object
            const rule = {
                name: ruleName.trim(),
                pattern: 'https://api.individual.githubcopilot.com/chat/completions',
                type: 'jsonata',
                expression: transformationQuery,
                description: 'Rule created from JSONata Query Tester'
            };
            
            // Send to parent window
            if (window.opener && !window.opener.closed) {
                window.opener.postMessage({
                    type: 'ADD_PROXY_RULE',
                    rule: rule
                }, '*');
                showMessage('✅ Rule sent to proxy server!');
            } else {
                // Fallback - copy the rule configuration
                const ruleConfig = JSON.stringify(rule, null, 2);
                navigator.clipboard.writeText(ruleConfig);
                showMessage('✅ Rule configuration copied to clipboard!');
            }
        }

        // Show temporary message
        function showMessage(message) {
            const messageDiv = document.createElement('div');
            messageDiv.className = message.includes('✅') ? 'success' : 'error';
            messageDiv.textContent = message;
            document.querySelector('.header').appendChild(messageDiv);
            setTimeout(() => messageDiv.remove(), 3000);
        }

        // Handle incoming data from parent window
        window.addEventListener('message', function(event) {
            if (event.data && event.data.type === 'POPULATE_BUILDER') {
                const { logId, jsonData, url } = event.data;
                
                // Store the JSON data
                currentJsonData = jsonData;
                
                // Display the formatted JSON in the left pane
                document.getElementById('json-data').value = JSON.stringify(jsonData, null, 2);
                

                
                // Update the header to show source info
                document.querySelector('.header h1').innerHTML = 
                    '🔍 JSONata Query Tester - Log #' + logId + ' <small style="opacity: 0.7;">(' + url + ')</small>';
            }
        });

        // Initialize
        document.addEventListener('DOMContentLoaded', function() {
            // Test JSONata library
            setTimeout(() => {
                if (typeof jsonata !== 'undefined') {
                    try {
                        const testExpr = jsonata('$');
                        const testResult = testExpr.evaluate({test: 'value'});
                        console.log('JSONata Library Test - Success:', testResult);
                    } catch (e) {
                        console.log('JSONata Library Test - Error:', e.message);
                    }
                } else {
                    console.log('JSONata Library Test - Library not loaded');
                }
            }, 1000);
            
            // Update currentJsonData when user manually edits the JSON field
            document.getElementById('json-data').addEventListener('input', function() {
                try {
                    const jsonText = this.value.trim();
                    if (jsonText) {
                        currentJsonData = JSON.parse(jsonText);
                    }
                } catch (e) {
                    // Invalid JSON - don't update currentJsonData but don't show error yet
                    console.log('JSON parse error (will retry):', e.message);
                }
            });
        });
    </script>
</body>
</html>`;
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
      // Get proxy logs and debug logs
      const logs = this.proxyServer.getLogs();
      const debugLogs = this.proxyServer.getDebugLogs();
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ logs, debugLogs }));
    } else if (url.pathname === '/proxy/clear' && req.method === 'POST') {
      // Clear proxy logs
      this.proxyServer.clearLogs();
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    } else if (url.pathname === '/proxy/clear-logs' && req.method === 'POST') {
      // Clear both proxy logs and debug logs
      this.proxyServer.clearLogs();
      this.proxyServer.clearDebugLogs();
      res.statusCode = 200;
      res.end(JSON.stringify({ success: true }));
    } else if (url.pathname === '/proxy/rules') {
      // Proxy rules CRUD operations
      await this.handleProxyRulesEndpoint(req, res);
    } else if (url.pathname.startsWith('/proxy/rules/')) {
      // Individual proxy rule operations
      await this.handleProxyRulesEndpoint(req, res);
    } else {
      res.statusCode = 404;
      res.end('Not Found');
    }
  }

  private async handleProxyRulesEndpoint(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    res.setHeader('Content-Type', 'application/json');
    
    try {
      if (url.pathname === '/proxy/rules' && req.method === 'GET') {
        // Get all proxy rules
        const rules = await this.getProxyRules();
        res.statusCode = 200;
        res.end(JSON.stringify(rules));
      } else if (url.pathname === '/proxy/rules' && req.method === 'POST') {
        // Add new proxy rule
        const body = await this.readRequestBody(req);
        const { name, pattern, redirect, jsonata, enabled, dropRequest, dropStatusCode, scope, sessionId, sessionName, workspaceFolder, debug } = JSON.parse(body);
        
        if (!name) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Rule name is required' }));
          return;
        }
        
        if (!pattern) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Pattern is required' }));
          return;
        }
        
        // Improved validation logic for different rule types
        const hasRedirect = redirect && redirect.trim() !== '';
        const hasJsonataTransform = jsonata && jsonata.trim() !== '';
        const hasDropRequest = dropRequest === true;
        
        if (!hasRedirect && !hasJsonataTransform && !hasDropRequest) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: 'Rule must have at least one action: redirect URL, JSONata transformation, or drop request' }));
          return;
        }
        
        // Validate regex pattern
        try {
          new RegExp(pattern);
        } catch (error: any) {
          res.statusCode = 400;
          res.end(JSON.stringify({ success: false, error: `Invalid regex pattern: ${error.message}` }));
          return;
        }
        
        const ruleId = await this.addProxyRule(name, pattern, redirect, jsonata, enabled !== false, dropRequest, dropStatusCode, scope, sessionId, sessionName, workspaceFolder, debug);
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, ruleId }));
      } else if (url.pathname.startsWith('/proxy/rules/') && req.method === 'PUT') {
        // Update proxy rule
        const ruleId = url.pathname.split('/').pop();
        const body = await this.readRequestBody(req);
        const updates = JSON.parse(body);
        
        const success = await this.updateProxyRule(ruleId!, updates);
        res.statusCode = 200;
        res.end(JSON.stringify({ success }));
      } else if (url.pathname.startsWith('/proxy/rules/') && req.method === 'DELETE') {
        // Delete proxy rule
        const ruleId = url.pathname.split('/').pop();
        const success = await this.deleteProxyRule(ruleId!);
        res.statusCode = 200;
        res.end(JSON.stringify({ success }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ success: false, error: 'Not Found' }));
      }
    } catch (error: any) {
      this.debugLogger.log('ERROR', 'Proxy rules endpoint error:', error);
      res.statusCode = 500;
      res.end(JSON.stringify({ success: false, error: error.message }));
    }
  }

  private async readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => {
        body += chunk.toString();
      });
      req.on('end', () => {
        resolve(body);
      });
      req.on('error', reject);
    });
  }

  // Proxy Rules Management Methods - use globalStorage for global scope
  private async getProxyRules(): Promise<any[]> {
    try {
      if (!this.globalStorage) {
        this.debugLogger.log('WARN', 'GlobalStorage not configured - cannot load proxy rules');
        return [];
      }
      const rules = this.globalStorage.get('proxyRules', []);
      this.debugLogger.log('INFO', `Loaded ${rules.length} proxy rules from globalStorage`);
      return rules;
    } catch (error) {
      this.debugLogger.log('ERROR', 'Failed to load proxy rules:', error);
      return [];
    }
  }

  private async addProxyRule(
    name: string, 
    pattern: string, 
    redirect?: string, 
    jsonata?: string, 
    enabled: boolean = true, 
    dropRequest?: boolean, 
    dropStatusCode?: number,
    scope?: 'global' | 'session' | 'workspace',
    sessionId?: string,
    sessionName?: string,
    workspaceFolder?: string,
    debug?: boolean
  ): Promise<string> {
    try {
      if (!this.globalStorage) {
        throw new Error('GlobalStorage not configured');
      }
      const rules = await this.getProxyRules();
      const ruleId = `rule-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const newRule: any = {
        id: ruleId,
        name,
        pattern,
        enabled,
        createdAt: new Date().toISOString(),
        scope: scope || 'global', // Default to global scope
        debug: debug || false // Default to false
      };
      
      // Add optional fields
      if (redirect) {
        newRule.redirect = redirect;
      }
      if (jsonata) {
        newRule.jsonata = jsonata;
      }
      if (dropRequest) {
        newRule.dropRequest = dropRequest;
        newRule.dropStatusCode = dropStatusCode || 204;
      }
      
      // Add scope-specific fields
      if (scope === 'session' && sessionId) {
        newRule.sessionId = sessionId;
        if (sessionName) {
          newRule.sessionName = sessionName;
        }
      }
      if (scope === 'workspace' && workspaceFolder) {
        newRule.workspaceFolder = workspaceFolder;
      }
      
      rules.push(newRule);
      await this.globalStorage.update('proxyRules', rules);
      this.debugLogger.log('INFO', `Added proxy rule: ${ruleId} (${pattern}) with scope: ${scope || 'global'}${debug ? ' [DEBUG ENABLED]' : ''}`);
      
      // Update proxy server rules and reload
      this.proxyServer.setRules(rules);
      await this.proxyServer.reloadRules();
      
      return ruleId;
    } catch (error) {
      this.debugLogger.log('ERROR', 'Failed to add proxy rule:', error);
      throw error;
    }
  }

  private async updateProxyRule(ruleId: string, updates: any): Promise<boolean> {
    try {
      if (!this.globalStorage) {
        throw new Error('GlobalStorage not configured');
      }
      const rules = await this.getProxyRules();
      const ruleIndex = rules.findIndex(r => r.id === ruleId);
      
      if (ruleIndex === -1) {
        this.debugLogger.log('WARN', `Proxy rule not found: ${ruleId}`);
        return false;
      }
      
      rules[ruleIndex] = { ...rules[ruleIndex], ...updates };
      await this.globalStorage.update('proxyRules', rules);
      this.debugLogger.log('INFO', `Updated proxy rule: ${ruleId}`);
      
      // Update proxy server rules and reload
      this.proxyServer.setRules(rules);
      await this.proxyServer.reloadRules();
      
      return true;
    } catch (error) {
      this.debugLogger.log('ERROR', 'Failed to update proxy rule:', error);
      throw error;
    }
  }

  private async deleteProxyRule(ruleId: string): Promise<boolean> {
    try {
      if (!this.globalStorage) {
        throw new Error('GlobalStorage not configured');
      }
      const rules = await this.getProxyRules();
      const filteredRules = rules.filter(r => r.id !== ruleId);
      
      if (filteredRules.length === rules.length) {
        this.debugLogger.log('WARN', `Proxy rule not found: ${ruleId}`);
        return false;
      }
      
      await this.globalStorage.update('proxyRules', filteredRules);
      this.debugLogger.log('INFO', `Deleted proxy rule: ${ruleId}`);
      
      // Update proxy server rules and reload
      this.proxyServer.setRules(filteredRules);
      await this.proxyServer.reloadRules();
      
      return true;
    } catch (error) {
      this.debugLogger.log('ERROR', 'Failed to delete proxy rule:', error);
      throw error;
    }
  }

  private async initializeDefaultRules(): Promise<void> {
    try {
      if (!this.globalStorage) {
        this.debugLogger.log('WARN', 'Cannot initialize default rules - no storage configured');
        return;
      }
      
      const existingRules = await this.getProxyRules();
      
      // Only create default rules if no rules exist (fresh setup)
      if (existingRules.length === 0) {
        this.debugLogger.log('INFO', 'Creating default example rules...');
        
        // Example 1: Karen Personality (JSONata transformation)
        await this.addProxyRule(
          'Karen Personality',
          '^https://api\\.individual\\.githubcopilot\\.com/chat/completions/?$',
          undefined,
          '$merge([$, {"messages": $.messages.(  role = "system" ?   $merge([$, {"content": "Your Name is Karen - behave like one - not too rude racist or sexist - just a bit of a bitch"}]) :   $)}])',
          false, // disabled by default
          false,
          undefined,
          'global', // global scope
          undefined,
          undefined,
          undefined,
          false // debug disabled
        );
        
        // Example 2: Block Telemetry (drop request)
        await this.addProxyRule(
          'Block GitHub Copilot Telemetry',
          '^https://telemetry\\.individual\\.githubcopilot\\.com/.*$',
          undefined,
          undefined,
          false, // disabled by default  
          true, // drop request
          204, // status code
          'global', // global scope
          undefined,
          undefined,
          undefined,
          false // debug disabled
        );
        
        this.debugLogger.log('INFO', 'Created 2 default example rules (disabled)');
      }
    } catch (error) {
      this.debugLogger.log('ERROR', 'Failed to initialize default rules:', error);
      // Don't throw - this is non-critical
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

  private async handleRuleBuilderInterface(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.debugLogger.log('HTTP', 'Serving visual rule builder at /jsonata-rule-builder.html');
    
    // Set HTML content type
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    
    const htmlContent = this.generateRuleBuilderHTML();
    res.end(htmlContent);
  }

  private generateWebInterfaceHTML(): string {
    // Get all active sessions for tab generation
    const sessions = Array.from(this.activeSessions).map((sessionId) => {
      const workspaceRoot = this.sessionWorkspacePaths.get(sessionId);
      const friendlyName = this.sessionNames.get(sessionId);
      const messageSettings = this.sessionMessageSettings.get(sessionId);
      
      // Get quick reply options from message settings or use defaults
      let quickReplyOptions = [
        "Yes Please Proceed",
        "Explain in more detail please"
      ];
      
      // Try to get from message settings first
      if (messageSettings && messageSettings.quickReplies && messageSettings.quickReplies.options && Array.isArray(messageSettings.quickReplies.options)) {
        quickReplyOptions = messageSettings.quickReplies.options;
      } else if (workspaceRoot) {
        // Fallback: Try to read from workspace override file
        try {
          const overrideFilePath = path.join(workspaceRoot, '.vscode', 'HumanAgentOverride.json');
          if (fs.existsSync(overrideFilePath)) {
            const overrideContent = fs.readFileSync(overrideFilePath, 'utf8');
            const overrideData = JSON.parse(overrideContent);
            if (overrideData.quickReplies && overrideData.quickReplies.options && Array.isArray(overrideData.quickReplies.options)) {
              quickReplyOptions = overrideData.quickReplies.options;
            }
          }
        } catch (error) {
          // Ignore errors, use defaults
        }
      }
      
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
        messages: [], // TODO: Add proper message storage
        quickReplyOptions: quickReplyOptions
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
            justify-content: space-between;
            background-color: var(--vscode-panel-background);
            border-bottom: 1px solid var(--vscode-border);
            overflow-x: auto;
        }

        .tabs-left {
            display: flex;
            overflow-x: auto;
        }

        .tabs-right {
            display: flex;
            flex-shrink: 0;
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

        .proxy-rules-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding: 15px;
        }

        .proxy-rules-container.active {
            display: flex;
        }

        .proxy-rules-container:not(.active) {
            display: none;
        }
        
        .proxy-debug-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding: 15px;
        }

        .proxy-debug-container.active {
            display: flex;
        }

        .proxy-debug-container:not(.active) {
            display: none;
        }
        
        .debug-logs {
            flex: 1;
            overflow: auto;
            font-family: Monaco, "Courier New", monospace;
            font-size: 12px;
            line-height: 1.2;
            background: #000000;
            color: #00ff00;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 10px;
        }
        
        .debug-log-entry {
            margin-bottom: 2px;
            padding: 2px 0;
            display: flex;
            color: #00ff00;
        }
        
        .debug-log-entry .timestamp {
            color: #888888;
            flex-shrink: 0;
            margin-right: 5px;
        }
        
        .debug-log-entry .message {
            word-wrap: break-word;
            overflow-wrap: break-word;
            flex: 1;
        }
        
        .debug-log-entry.karen,
        .debug-log-entry.karen .message {
            color: #ff69b4;
            font-weight: bold;
        }
        
        .debug-log-entry.master,
        .debug-log-entry.master .message {
            color: #ffff00;
        }
        
        .debug-log-entry.error,
        .debug-log-entry.error .message {
            color: #ff4444;
        }
        
        .debug-log-entry.success,
        .debug-log-entry.success .message {
            color: #44ff44;
        }

        .proxy-rules-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-border);
        }
        .proxy-rules-header h2 {
            font-size: 16px;
            font-weight: 600;
        }

        .add-rule-button {
            padding: 6px 12px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: opacity 0.2s;
        }

        .add-rule-button:hover {
            opacity: 0.9;
        }

        .proxy-logs-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 10px;
            border-bottom: 1px solid var(--vscode-border);
        }

        .proxy-logs-header h2 {
            font-size: 16px;
            font-weight: 600;
        }

        .proxy-logs-controls {
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .toggle-label {
            display: flex;
            align-items: center;
            cursor: pointer;
            font-size: 12px;
            gap: 8px;
        }

        .toggle-label input[type="checkbox"] {
            margin: 0;
        }

        .toggle-text {
            user-select: none;
        }

        .clear-logs-button {
            padding: 6px 12px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: 1px solid var(--vscode-button-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            transition: opacity 0.2s;
        }

        .clear-logs-button:hover {
            opacity: 0.9;
        }

        .proxy-rules-list {
            flex: 1;
            overflow-y: auto;
        }

        .proxy-rule {
            margin-bottom: 10px;
            padding: 12px;
            background-color: var(--vscode-panel-background);
            border-radius: 4px;
            border-left: 3px solid var(--vscode-button-background);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .proxy-rule.disabled {
            opacity: 0.5;
            border-left-color: #666;
        }

        .proxy-rule-info {
            flex: 1;
        }

        .proxy-rule-pattern {
            font-weight: 600;
            font-family: monospace;
            margin-bottom: 4px;
        }

        .proxy-rule-target {
            font-size: 12px;
            opacity: 0.8;
            font-family: monospace;
        }

        .proxy-rule-actions {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .toggle-switch {
            position: relative;
            width: 36px;
            height: 20px;
            cursor: pointer;
        }

        .toggle-switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .toggle-slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: #666;
            transition: 0.3s;
            border-radius: 20px;
        }

        .toggle-slider:before {
            position: absolute;
            content: "";
            height: 14px;
            width: 14px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: 0.3s;
            border-radius: 50%;
        }

        input:checked + .toggle-slider {
            background-color: var(--vscode-button-background);
        }

        input:checked + .toggle-slider:before {
            transform: translateX(16px);
        }

        .edit-rule-button {
            padding: 4px 8px;
            background-color: #0366d6;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            margin-right: 8px;
            transition: background-color 0.2s;
        }

        .edit-rule-button:hover {
            background-color: #0256cc;
        }

        .delete-rule-button {
            padding: 4px 8px;
            background-color: #d73a49;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 11px;
            transition: background-color 0.2s;
        }

        .delete-rule-button:hover {
            background-color: #cb2431;
        }

        .add-rule-form {
            display: none;
            padding: 15px;
            background-color: var(--vscode-panel-background);
            border-radius: 4px;
            margin-bottom: 15px;
            border: 1px solid var(--vscode-border);
        }

        .add-rule-form.active {
            display: block;
        }

        .form-group {
            margin-bottom: 12px;
        }

        .form-group label {
            display: block;
            margin-bottom: 4px;
            font-size: 12px;
            font-weight: 600;
        }

        .form-group input {
            width: 100%;
            padding: 8px;
            background-color: var(--vscode-input-background);
            border: 1px solid var(--vscode-border);
            border-radius: 4px;
            color: var(--vscode-foreground);
            font-size: 13px;
            font-family: monospace;
        }

        .form-group input:focus {
            outline: none;
            border-color: var(--vscode-button-background);
        }

        .form-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        }

        .cancel-button {
            padding: 6px 12px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-foreground);
            border: 1px solid var(--vscode-border);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }

        .btn-small {
            padding: 4px 8px;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            margin-right: 6px;
            transition: background-color 0.2s;
        }

        .btn-small:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .proxy-log-actions {
            margin-bottom: 15px;
            padding: 10px;
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .cancel-button:hover {
            background-color: var(--vscode-panel-background);
        }

        .proxy-log {
            margin-bottom: 10px;
            padding: 10px;
            background-color: var(--vscode-panel-background);
            border-radius: 4px;
            border-left: 3px solid var(--vscode-button-background);
            transition: background-color 0.2s;
        }

        .proxy-log.rule-applied {
            border-left-color: #ff8c00; /* Orange border for rules */
        }

        .proxy-log-rule-badge {
            display: inline-block;
            background-color: #ff8c00;
            color: white;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 600;
            margin-left: 8px;
        }

        .proxy-log-modifications {
            font-size: 11px;
            opacity: 0.8;
            margin-top: 8px;
            padding-top: 8px;
            border-top: 1px solid var(--vscode-border);
        }

        .proxy-log-modifications div {
            margin: 2px 0;
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
            <div class="tabs-left" id="tabs-left">
                ${sessions.length === 0 ? '' : sessions.map((session, index) => 
                    `<div class="tab ${index === 0 ? 'active' : ''}" data-session="${session.id}">${session.title}</div>`
                ).join('')}
            </div>
            <div class="tabs-right" id="tabs-right">
                <div class="tab ${sessions.length === 0 ? 'active' : ''}" data-session="proxy">📊 Proxy Logs</div>
                <div class="tab" data-session="proxy-rules">⚙️ Proxy Rules</div>
                <div class="tab" data-session="proxy-debug">🔍 Proxy Debug</div>
            </div>
        </div>
        
        <div class="content">
            ${sessions.length === 0 ? 
                '<div class="no-sessions" data-session="no-sessions" style="display: none;">No active sessions. Start a chat in VS Code to see sessions here.</div>' :
                sessions.map((session, index) => `
                    <div class="chat-container ${index === 0 ? 'active' : ''}" data-session="${session.id}">
                        <div class="messages" id="messages-${session.id}">
                            <!-- Messages will be loaded dynamically -->
                        </div>
                        <div class="input-container">
                            <textarea class="input-box" placeholder="Type your message..." data-session="${session.id}"></textarea>
                            <select class="quick-replies" data-session="${session.id}">
                                <option value="">Quick Replies...</option>
                                ${session.quickReplyOptions.map((option: string) => 
                                  `<option value="${this.escapeHtml(option)}">${this.escapeHtml(option)}</option>`
                                ).join('\n                                ')}
                            </select>
                            <button class="send-button" data-session="${session.id}">Send</button>
                        </div>
                    </div>
                `).join('')
            }
            <div class="proxy-container ${sessions.length === 0 ? 'active' : ''}" data-session="proxy">
                <div class="proxy-logs-header">
                    <h2>Proxy Logs</h2>
                    <div class="proxy-logs-controls">
                        <label class="toggle-label">
                            <input type="checkbox" id="filter-modified-only" onchange="toggleFilterModifiedOnly()">
                            <span class="toggle-text">Show only modified requests</span>
                        </label>
                        <button class="clear-logs-button" onclick="clearProxyLogs()">Clear Logs</button>
                    </div>
                </div>
                <div class="messages" id="proxy-logs">
                    <div style="opacity: 0.6; text-align: center; padding: 20px;">
                        Proxy logs will appear here when requests are made through the proxy.
                    </div>
                </div>
            </div>
            <div class="proxy-rules-container" data-session="proxy-rules">
                <div class="proxy-rules-header">
                    <h2>Proxy Rules</h2>
                    <button class="add-rule-button" onclick="showAddRuleForm()">+ Add Rule</button>
                </div>
                
                <div class="add-rule-form" id="add-rule-form">
                    <div class="form-group">
                        <label for="rule-name">Rule Name</label>
                        <input type="text" id="rule-name" placeholder="e.g., Karen Personality, Block Telemetry" />
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">Friendly name to identify this rule</div>
                    </div>
                    <div class="form-group">
                        <label for="rule-pattern">URL Pattern (regex)</label>
                        <input type="text" id="rule-pattern" placeholder="e.g., ^https://api\\.example\\.com/.*" />
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">Regex pattern to match request URLs</div>
                    </div>
                    <div class="form-group">
                        <label for="rule-redirect">Redirect To (optional)</label>
                        <input type="text" id="rule-redirect" placeholder="e.g., https://localhost:8080 (leave blank to keep original destination)" />
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">Redirect matching requests to this URL. Leave empty to only transform payload.</div>
                    </div>
                    <div class="form-group">
                        <label for="rule-jsonata">JSONata Transformation (optional)</label>
                        <textarea id="rule-jsonata" rows="4" placeholder="e.g., \$merge([\$, {&quot;messages&quot;: \$.messages.(\$ | role = &quot;system&quot; ? {&quot;content&quot;: &quot;New system message&quot;} : \$)}])" style="width: 100%; font-family: Monaco, monospace; font-size: 12px;"></textarea>
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">
                            JSONata expression to transform request body. Examples:<br/>
                            • <code>\$merge([\$, {"api_key": "new-key"}])</code> - Replace API key<br/>
                            • <code>\$merge([\$, {"messages": \$.messages.(role = "system" ? \$merge([\$, {"content": "new text"}]) : \$)}])</code> - Replace system message content<br/>
                            • <code>\$</code> - Pass through unchanged (identity transform)<br/>
                            📖 <a href="https://jsonata.org/" target="_blank" style="color: #ff8c00; text-decoration: underline;">JSONata Documentation</a>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>
                            <input type="checkbox" id="rule-drop-request" onchange="handleDropRequestChange()" style="margin-right: 8px;" />
                            Drop Request (block request entirely)
                        </label>
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">If checked, matching requests will be blocked instead of forwarded</div>
                    </div>
                    <div class="form-group" id="rule-drop-status-group" style="display: none;">
                        <label for="rule-drop-status">Drop Status Code (if dropping)</label>
                        <input type="number" id="rule-drop-status" placeholder="204" value="204" min="200" max="599" />
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">HTTP status code to return for dropped requests (default: 204 No Content)</div>
                    </div>
                    
                    <div class="form-group">
                        <label for="rule-scope">Rule Scope</label>
                        <select id="rule-scope" onchange="handleScopeChange()" style="width: 100%; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;">
                            <option value="global">Global (applies to all workspaces)</option>
                            <option value="session">Session (applies to specific session)</option>
                            <option value="workspace">Workspace (applies to specific workspace folder)</option>
                        </select>
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">Control where this rule applies</div>
                    </div>
                    
                    <div class="form-group" id="rule-session-id-group" style="display: none;">
                        <label for="rule-session-id">Session</label>
                        <select id="rule-session-id" style="width: 100%; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;">
                            <option value="">Select a session...</option>
                        </select>
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">The session this rule applies to</div>
                    </div>
                    
                    <div class="form-group" id="rule-workspace-folder-group" style="display: none;">
                        <label for="rule-workspace-folder">Workspace Folder Path</label>
                        <input type="text" id="rule-workspace-folder" placeholder="e.g., /Users/username/projects/myapp" />
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">The absolute path to the workspace folder</div>
                    </div>
                    
                    <div class="form-group">
                        <label>
                            <input type="checkbox" id="rule-debug" style="margin-right: 8px;" />
                            Enable Enhanced Debug Logging
                        </label>
                        <div style="font-size: 11px; opacity: 0.7; margin-top: 4px;">Show detailed debug information when this rule is evaluated (helps with troubleshooting)</div>
                    </div>
                    <div class="form-actions">
                        <button class="cancel-button" onclick="hideAddRuleForm()">Cancel</button>
                        <button class="add-rule-button" onclick="saveNewRule()">Save Rule</button>
                    </div>
                </div>
                
                <div class="proxy-rules-list" id="proxy-rules-list">
                    <div style="opacity: 0.6; text-align: center; padding: 20px;">
                        No proxy rules configured. Click "Add Rule" to create one.
                    </div>
                </div>
            </div>
            
            <div class="proxy-debug-container" data-session="proxy-debug">
                <div class="proxy-logs-header">
                    <h2>Proxy Debug</h2>
                    <div style="display: flex; gap: 10px; align-items: center;">
                        <select id="debug-log-filter" onchange="filterDebugLogs()" style="padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px;">
                            <option value="all">Show All</option>
                            <option value="chat-completions">Show Only AI Chat Completions</option>
                            <option value="matched-rules">Show Only Matched Rules</option>
                        </select>
                        <button class="clear-logs-button" onclick="clearDebugLogs()">Clear Logs</button>
                    </div>
                </div>
                <div class="debug-logs" id="debug-logs">
                    <div style="opacity: 0.6; text-align: center; padding: 20px;">
                        Proxy debug logs will appear here when requests are intercepted and modified.
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        // Session management
        let activeSessionId = '${sessions[0]?.id || 'proxy'}';
        
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
            
            // Update active proxy rules container
            document.querySelectorAll('.proxy-rules-container').forEach(container => {
                container.classList.toggle('active', container.dataset.session === sessionId);
            });
            
            // Update active proxy debug container
            document.querySelectorAll('.proxy-debug-container').forEach(container => {
                container.classList.toggle('active', container.dataset.session === sessionId);
            });
            
            activeSessionId = sessionId;
            
            // Load proxy logs if switching to proxy tab
            if (sessionId === 'proxy') {
                loadProxyLogs();
            }
            
            // Load proxy rules if switching to proxy rules tab
            if (sessionId === 'proxy-rules') {
                loadProxyRules();
                stopDebugLogsPolling();
            }
            
            // Load proxy debug logs if switching to proxy debug tab
            if (sessionId === 'proxy-debug') {
                loadDebugLogs();
                startDebugLogsPolling();
            } else {
                stopDebugLogsPolling();
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
                const data = await response.json();
                const logs = data.logs || data; // Handle both new format and legacy
                
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
        
        function addProxyLogToUI(logEntry, prepend = false) {
            // Cache the log data for rule creation (same as updateProxyLogInUI)
            if (typeof window.proxyLogsDataCache === 'undefined') {
                window.proxyLogsDataCache = new Map();
            }
            window.proxyLogsDataCache.set(logEntry.id, logEntry);
            
            const proxyLogsContainer = document.getElementById('proxy-logs');
            if (!proxyLogsContainer) return;
            
            // Remove placeholder if exists
            const placeholder = proxyLogsContainer.querySelector('div[style*="opacity: 0.6"]');
            if (placeholder) {
                placeholder.remove();
            }
            
            const logDiv = document.createElement('div');
            logDiv.className = logEntry.ruleApplied ? 'proxy-log-entry proxy-log rule-applied' : 'proxy-log-entry proxy-log';
            logDiv.dataset.logId = logEntry.id;
            logDiv.style.cursor = 'pointer';
            
            const statusClass = logEntry.responseStatus >= 200 && logEntry.responseStatus < 300 ? 'success' : 'error';
            const statusText = logEntry.responseStatus ? logEntry.responseStatus : 'Pending';
            const duration = logEntry.duration ? \`\${logEntry.duration}ms\` : '-';
            
            // Build rule badge if rule was applied
            let ruleBadge = '';
            if (logEntry.ruleApplied) {
                const hoverText = logEntry.ruleApplied.hoverInfo 
                    ? \`Original: \${logEntry.ruleApplied.hoverInfo.originalText}\\nReplacement: \${logEntry.ruleApplied.hoverInfo.replacementText}\`
                    : logEntry.ruleApplied.modifications ? logEntry.ruleApplied.modifications.join('\\n') : 'Rule applied';
                
                ruleBadge = \`<span class="proxy-log-rule-badge" title="\${escapeHtml(hoverText)}">⚙️ Rule #\${logEntry.ruleApplied.ruleIndex}</span>\`;
            }
            
            // Build modifications display
            let modificationsHtml = '';
            if (logEntry.ruleApplied && logEntry.ruleApplied.modifications) {
                modificationsHtml = \`
                    <div class="proxy-log-modifications">
                        <strong>Modifications:</strong>
                        \${logEntry.ruleApplied.modifications.map(mod => \`<div>• \${escapeHtml(mod)}</div>\`).join('')}
                    </div>
                \`;
            }
            
            // Format headers for display
            const formatHeaders = (headers) => {
                if (!headers || Object.keys(headers).length === 0) return '<i>No headers</i>';
                return Object.entries(headers)
                    .map(([key, value]) => \`<div><b>\${escapeHtml(key)}:</b> \${escapeHtml(String(value))}</div>\`)
                    .join('');
            };
            
            // Format body for display with before/after comparison for rule-modified requests
            const formatBeforeAfterBody = (logEntry) => {
                const currentBody = logEntry.requestBody;
                
                // Try to reconstruct original body from rule modifications
                let originalBody = currentBody;
                if (logEntry.ruleApplied && logEntry.ruleApplied.modifications) {
                    const modifications = logEntry.ruleApplied.modifications;
                    
                    // Look for JSON modifications to reverse-engineer original
                    const jsonMods = modifications.filter(mod => mod.startsWith('JSON:'));
                    if (jsonMods.length > 0 && currentBody) {
                        try {
                            let reconstructedOriginal = JSON.parse(currentBody);
                            
                            // Parse modifications to find what was changed
                            jsonMods.forEach(mod => {
                                // Match pattern: JSON: path = "oldValue" → "newValue"
                                const match = mod.match(/JSON: (.*?) = "(.*?)" → "(.*?)"/);
                                if (match && match.length >= 4) {
                                    const path = match[1];
                                    const oldValue = match[2];
                                    const newValue = match[3];
                                    
                                    // Try to set the original value back
                                    try {
                                        const pathParts = path.split('.');
                                        let obj = reconstructedOriginal;
                                        for (let i = 0; i < pathParts.length - 1; i++) {
                                            if (obj[pathParts[i]]) {
                                                obj = obj[pathParts[i]];
                                            }
                                        }
                                        const lastKey = pathParts[pathParts.length - 1];
                                        if (obj[lastKey] === newValue) {
                                            obj[lastKey] = oldValue;
                                        }
                                    } catch (e) {
                                        // If path reconstruction fails, continue
                                    }
                                }
                            });
                            
                            originalBody = JSON.stringify(reconstructedOriginal, null, 2);
                        } catch (e) {
                            // If parsing fails, use current body as fallback
                        }
                    }
                }
                
                if (originalBody === currentBody) {
                    // No reconstruction possible, show current with rule info
                    return '<div style="background: #fff3cd; padding: 10px; border-radius: 4px; margin-bottom: 10px;">' +
                           '<strong>⚙️ Rule Applied - Request Modified</strong><br>' +
                           '<small>Rule #' + logEntry.ruleApplied.ruleIndex + ' was applied to this request</small></div>' +
                           formatBody(currentBody);
                } else {
                    // Show before and after comparison
                    return '<div style="background: #fff3cd; padding: 10px; border-radius: 4px; margin-bottom: 10px;">' +
                           '<strong>⚙️ Rule Applied - Before & After Comparison</strong></div>' +
                           '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">' +
                           '<div><h5 style="color: #dc3545; margin: 5px 0;">📄 Original Request</h5>' +
                           '<pre style="background: #f8d7da; padding: 10px; border-radius: 4px; font-size: 11px; max-height: 300px; overflow: auto;">' +
                           escapeHtml(originalBody) + '</pre></div>' +
                           '<div><h5 style="color: #28a745; margin: 5px 0;">✏️ Modified Request</h5>' +
                           '<pre style="background: #d4edda; padding: 10px; border-radius: 4px; font-size: 11px; max-height: 300px; overflow: auto;">' +
                           escapeHtml(currentBody) + '</pre></div></div>';
                }
            };

            // Format body for display
            const formatBody = (body) => {
                if (!body) return '<i>No body</i>';
                if (typeof body === 'object') {
                    return '<pre>' + escapeHtml(JSON.stringify(body, null, 2)) + '</pre>';
                }
                return '<pre>' + escapeHtml(String(body)) + '</pre>';
            };
            
            const timestamp = new Date(logEntry.timestamp).toLocaleTimeString();
            
            logDiv.innerHTML = \`
                <div class="proxy-log-summary" onclick="toggleProxyLogDetails('\${logEntry.id}')">
                    <div class="proxy-log-header">
                        <span class="proxy-log-method">\${logEntry.method}</span>
                        \${ruleBadge}
                        <span class="proxy-log-status \${statusClass}">\${statusText}</span>
                        <span>\${duration}</span>
                        <span>\${timestamp}</span>
                        <span style="float: right;">▼</span>
                    </div>
                    <div class="proxy-log-url">\${escapeHtml(logEntry.url)}</div>
                    \${modificationsHtml}
                </div>
                <div class="proxy-log-details" id="proxy-log-details-\${logEntry.id}" style="display: none;">
                    <div class="proxy-log-actions">
                        <button class="btn-small" onclick="createRuleFromMessage('\${logEntry.id}')" 
                                title="Create a proxy rule based on this request">
                            🎯 Create Rule
                        </button>
                        <button class="btn-small" onclick="copyLogAsJSON('\${logEntry.id}')" 
                                title="Copy request data as JSON for testing">
                            📋 Copy JSON
                        </button>
                    </div>
                    <div class="proxy-log-section">
                        <h4>Request Headers</h4>
                        \${formatHeaders(logEntry.requestHeaders)}
                    </div>
                    <div class="proxy-log-section">
                        <h4>Request Body</h4>
                        \${logEntry.ruleApplied ? formatBeforeAfterBody(logEntry) : formatBody(logEntry.requestBody)}
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
            
            // Apply filter if enabled
            const filterCheckbox = document.getElementById('filter-modified-only');
            if (filterCheckbox && filterCheckbox.checked) {
                const isModified = logEntry.ruleApplied || 
                                 (logDiv.querySelector('.proxy-log-modifications') && 
                                  logDiv.querySelector('.proxy-log-modifications').children.length > 0);
                logDiv.style.display = isModified ? '' : 'none';
            }
            
            // Keep only last 200 logs
            while (proxyLogsContainer.children.length > 200) {
                proxyLogsContainer.removeChild(proxyLogsContainer.firstChild);
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
            console.log('updateProxyLogInUI called for:', logEntry.id, 'hasResponseHeaders:', !!logEntry.responseHeaders, 'hasResponseBody:', !!logEntry.responseBody);
            
            // Cache the log data for rule creation
            if (typeof window.proxyLogsDataCache === 'undefined') {
                window.proxyLogsDataCache = new Map();
            }
            window.proxyLogsDataCache.set(logEntry.id, logEntry);
            
            const logDiv = document.querySelector(\`[data-log-id="\${logEntry.id}"]\`);
            if (!logDiv) {
                console.log('updateProxyLogInUI: Could not find log div for', logEntry.id);
                return;
            }
            
            const statusClass = logEntry.responseStatus >= 200 && logEntry.responseStatus < 300 ? 'success' : 'error';
            const statusText = logEntry.responseStatus || 'Pending';
            const duration = logEntry.duration ? \`\${logEntry.duration}ms\` : '-';
            const timestamp = new Date(logEntry.timestamp).toLocaleTimeString();
            
            // Build rule badge if rule was applied
            let ruleBadge = '';
            if (logEntry.ruleApplied) {
                const hoverText = logEntry.ruleApplied.hoverInfo 
                    ? \`Original: \${logEntry.ruleApplied.hoverInfo.originalText}\\nReplacement: \${logEntry.ruleApplied.hoverInfo.replacementText}\`
                    : logEntry.ruleApplied.modifications ? logEntry.ruleApplied.modifications.join('\\n') : 'Rule applied';
                
                ruleBadge = \`<span class="proxy-log-rule-badge" title="\${escapeHtml(hoverText)}">⚙️ Rule #\${logEntry.ruleApplied.ruleIndex}</span>\`;
            }
            
            // Build modifications display
            let modificationsHtml = '';
            if (logEntry.ruleApplied && logEntry.ruleApplied.modifications) {
                modificationsHtml = \`
                    <div class="proxy-log-modifications">
                        <strong>Modifications:</strong>
                        \${logEntry.ruleApplied.modifications.map(mod => \`<div>• \${escapeHtml(mod)}</div>\`).join('')}
                    </div>
                \`;
            }
            
            // Update only the summary section, preserve the existing details
            const summaryDiv = logDiv.querySelector('.proxy-log-summary');
            if (summaryDiv) {
                summaryDiv.innerHTML = \`
                    <div class="proxy-log-header">
                        <span class="proxy-log-method">\${logEntry.method}</span>
                        \${ruleBadge}
                        <span class="proxy-log-status \${statusClass}">\${statusText}</span>
                        <span>\${duration}</span>
                        <span>\${timestamp}</span>
                        <span style="float: right;">▼</span>
                    </div>
                    <div class="proxy-log-url">\${escapeHtml(logEntry.url)}</div>
                    \${modificationsHtml}
                \`;
            }
            
            // Always update the details section with the latest response data
            const detailsDiv = document.getElementById(\`proxy-log-details-\${logEntry.id}\`);
            if (detailsDiv) {
                console.log('Updating details div for', logEntry.id, 'with response data');
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
                
                // Format body for display with before/after comparison for rule-modified requests
                const formatBeforeAfterBody = (logEntry) => {
                    const currentBody = logEntry.requestBody;
                    
                    // Try to reconstruct original body from rule modifications
                    let originalBody = currentBody;
                    if (logEntry.ruleApplied && logEntry.ruleApplied.modifications) {
                        const modifications = logEntry.ruleApplied.modifications;
                        
                        // Look for JSON modifications to reverse-engineer original
                        const jsonMods = modifications.filter(mod => mod.startsWith('JSON:'));
                        if (jsonMods.length > 0 && currentBody) {
                            try {
                                let reconstructedOriginal = JSON.parse(currentBody);
                                
                                // Parse modifications to find what was changed
                                jsonMods.forEach(mod => {
                                    // Match pattern: JSON: path = "oldValue" → "newValue"
                                    const match = mod.match(/JSON: (.*?) = "(.*?)" → "(.*?)"/);
                                    if (match && match.length >= 4) {
                                        const path = match[1];
                                        const oldValue = match[2];
                                        const newValue = match[3];
                                        
                                        // Try to set the original value back
                                        try {
                                            const pathParts = path.split('.');
                                            let obj = reconstructedOriginal;
                                            for (let i = 0; i < pathParts.length - 1; i++) {
                                                if (obj[pathParts[i]]) {
                                                    obj = obj[pathParts[i]];
                                                }
                                            }
                                            const lastKey = pathParts[pathParts.length - 1];
                                            if (obj[lastKey] === newValue) {
                                                obj[lastKey] = oldValue;
                                            }
                                        } catch (e) {
                                            // If path reconstruction fails, continue
                                        }
                                    }
                                });
                                
                                originalBody = JSON.stringify(reconstructedOriginal, null, 2);
                            } catch (e) {
                                // If parsing fails, use current body as fallback
                            }
                        }
                    }
                    
                    if (originalBody === currentBody) {
                        // No reconstruction possible, show current with rule info
                        return '<div style="background: #fff3cd; padding: 10px; border-radius: 4px; margin-bottom: 10px;">' +
                               '<strong>⚙️ Rule Applied - Request Modified</strong><br>' +
                               '<small>Rule #' + logEntry.ruleApplied.ruleIndex + ' was applied to this request</small></div>' +
                               formatBody(currentBody);
                    } else {
                        // Show before and after comparison
                        return '<div style="background: #fff3cd; padding: 10px; border-radius: 4px; margin-bottom: 10px;">' +
                               '<strong>⚙️ Rule Applied - Before & After Comparison</strong></div>' +
                               '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">' +
                               '<div><h5 style="color: #dc3545; margin: 5px 0;">📄 Original Request</h5>' +
                               '<pre style="background: #f8d7da; padding: 10px; border-radius: 4px; font-size: 11px; max-height: 300px; overflow: auto;">' +
                               escapeHtml(originalBody) + '</pre></div>' +
                               '<div><h5 style="color: #28a745; margin: 5px 0;">✏️ Modified Request</h5>' +
                               '<pre style="background: #d4edda; padding: 10px; border-radius: 4px; font-size: 11px; max-height: 300px; overflow: auto;">' +
                               escapeHtml(currentBody) + '</pre></div></div>';
                    }
                };
                
                detailsDiv.innerHTML = \`
                    <div class="proxy-log-actions">
                        <button class="btn-small" onclick="createRuleFromMessage('\${logEntry.id}')" 
                                title="Create a proxy rule based on this request">
                            🎯 Create Rule
                        </button>
                        <button class="btn-small" onclick="copyLogAsJSON('\${logEntry.id}')" 
                                title="Copy request data as JSON for testing">
                            📋 Copy JSON
                        </button>
                    </div>
                    <div class="proxy-log-section">
                        <h4>Request Headers</h4>
                        \${formatHeaders(logEntry.requestHeaders)}
                    </div>
                    <div class="proxy-log-section">
                        <h4>Request Body</h4>
                        \${logEntry.ruleApplied ? formatBeforeAfterBody(logEntry) : formatBody(logEntry.requestBody)}
                    </div>
                    <div class="proxy-log-section">
                        <h4>Response Headers</h4>
                        \${formatHeaders(logEntry.responseHeaders)}
                    </div>
                    <div class="proxy-log-section">
                        <h4>Response Body</h4>
                        \${formatBody(logEntry.responseBody)}
                    </div>
                \`;
            }
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

        function addSessionTab(sessionId, quickReplyOptions) {
            // Use default options if not provided
            if (!quickReplyOptions || !Array.isArray(quickReplyOptions)) {
                quickReplyOptions = ["Yes Please Proceed", "Explain in more detail please"];
            }
            
            // Check if tab already exists
            const existingTab = document.querySelector(\`[data-session="\${sessionId}"].tab\`);
            if (existingTab) {
                console.log(\`Tab for session \${sessionId} already exists\`);
                return;
            }

            const tabsLeftContainer = document.getElementById('tabs-left');
            const contentDiv = document.querySelector('.content');
            
            if (!tabsLeftContainer || !contentDiv) {
                console.error('Could not find tabs-left container or content div');
                return;
            }

            // Create new tab
            const tabElement = document.createElement('div');
            tabElement.className = 'tab';
            tabElement.setAttribute('data-session', sessionId);
            tabElement.textContent = \`Session: \${sessionId.substring(0, 8)}\`;
            tabElement.onclick = () => switchToSession(sessionId);
            
            // Add tab to left container (chat tabs)
            tabsLeftContainer.appendChild(tabElement);

            // Generate quick reply options HTML
            const quickReplyOptionsHtml = quickReplyOptions.map(option => 
                \`<option value="\${escapeHtml(option)}">\${escapeHtml(option)}</option>\`
            ).join('\\n                        ');

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
                        \${quickReplyOptionsHtml}
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
                        addProxyLogToUI(data.data); // Will append at bottom by default
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
                        addSessionTab(data.data.sessionId, data.data.quickReplyOptions);
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
        
        // Create rule from proxy log message\n        function createRuleFromMessage(logId) {
            // Get the log data from cache
            if (typeof window.proxyLogsDataCache === 'undefined' || !window.proxyLogsDataCache.has(logId)) {
                alert('❌ Log data not found. Please refresh the proxy logs.');
                return;
            }
            
            const logEntry = window.proxyLogsDataCache.get(logId);
            let jsonData;
            
            // Parse the requestBody string to JSON object (handle JSONL format)
            try {
                if (typeof logEntry.requestBody === 'string') {
                    // Handle JSONL format - multiple JSON objects on separate lines
                    const lines = logEntry.requestBody.trim().split('\\n').filter(line => line.trim());
                    if (lines.length === 1) {
                        // Single JSON object
                        jsonData = JSON.parse(lines[0]);
                    } else if (lines.length > 1) {
                        // Multiple JSON objects - parse all and put in array for JSONata testing
                        jsonData = lines.map(line => JSON.parse(line.trim()));
                        // For rule creation, we'll use the array format
                    } else {
                        throw new Error('Empty request body');
                    }
                } else if (typeof logEntry.requestBody === 'object') {
                    jsonData = logEntry.requestBody;
                } else {
                    throw new Error('No request body data available');
                }
            } catch (e) {
                alert('❌ Could not parse request body as JSON: ' + e.message + '\\n\\nRequest body preview: ' + 
                      (typeof logEntry.requestBody === 'string' ? logEntry.requestBody.substring(0, 200) + '...' : 'Not a string'));
                return;
            }
            
            if (!jsonData || typeof jsonData !== 'object') {
                alert('❌ No valid request body JSON data found for this log');
                return;
            }
            
            openRuleBuilder(logId, jsonData);
        }
        
        function openRuleBuilder(logId, jsonData) {
            if (!jsonData || typeof jsonData !== 'object') {
                alert('❌ No valid JSON data available for this request');
                return;
            }
            
            // Open visual builder in new window with data
            const builderUrl = window.location.origin + '/jsonata-rule-builder.html';
            const builderWindow = window.open(builderUrl, 'JSONataBuilder', 
                'width=1200,height=800,scrollbars=yes,resizable=yes');
            
            // When builder loads, populate it with our data
            builderWindow.onload = () => {
                try {
                    // Pass the JSON data to the builder
                    builderWindow.postMessage({
                        type: 'POPULATE_BUILDER',
                        logId: logId,
                        jsonData: jsonData,
                        url: 'https://api.individual.githubcopilot.com/chat/completions'
                    }, '*');
                } catch (e) {
                    console.error('Error populating builder:', e);
                }
            };
            
            // Visual rule builder will open in new window
        }
        
        function copyLogAsJSON(logId) {
            // Find the log data by ID
            const logElement = document.querySelector('[data-log-id="' + logId + '"]');
            if (!logElement) {
                alert('❌ Could not find log data for ID: ' + logId);
                return;
            }
            
            // Extract JSON from the log details
            const detailsElement = document.getElementById('proxy-log-details-' + logId);
            if (!detailsElement) {
                alert('❌ Could not find log details. Please expand the log first.');
                return;
            }
            
            try {
                // Look for JSON in the request body section specifically
                const sections = detailsElement.querySelectorAll('.proxy-log-section');
                let requestBodySection = null;
                
                for (const section of sections) {
                    const heading = section.querySelector('h4');
                    if (heading && heading.textContent.trim() === 'Request Body') {
                        requestBodySection = section;
                        break;
                    }
                }
                
                if (requestBodySection) {
                    const preElement = requestBodySection.querySelector('pre');
                    if (preElement) {
                        const jsonText = preElement.textContent || preElement.innerText;
                        const jsonData = JSON.parse(jsonText);
                        
                        // Copy to clipboard
                        navigator.clipboard.writeText(JSON.stringify(jsonData, null, 2));
                        alert('✅ Request JSON copied to clipboard!\\n\\nYou can now paste it into the visual rule builder.');
                    } else {
                        alert('❌ No JSON body found in request section.');
                    }
                } else {
                    alert('❌ Could not find Request Body section. Please expand the log first.');
                }
            } catch (e) {
                console.warn('Could not parse JSON from request body:', e);
                // Silently fail - not all requests have JSON bodies
            }
        }
        
        // Handle messages from visual rule builder
        window.addEventListener('message', function(event) {
            if (event.data && event.data.type === 'ADD_PROXY_RULE') {
                const rule = event.data.rule;
                
                // Auto-populate the rule form
                document.getElementById('rule-pattern').value = rule.pattern;
                
                if (rule.type === 'jsonata') {
                    // For JSONata rules, populate the JSONata field
                    document.getElementById('rule-jsonata').value = rule.expression;
                } else {
                    // For legacy rules, just clear the JSONata field
                    document.getElementById('rule-jsonata').value = '';
                }
                
                // Show and highlight the form
                showAddRuleForm();
                setTimeout(() => {
                    const form = document.getElementById('add-rule-form');
                    if (form) {
                        form.scrollIntoView({ behavior: 'smooth' });
                        form.style.border = '3px solid #007acc';
                        form.style.boxShadow = '0 0 20px rgba(0, 122, 204, 0.5)';
                        setTimeout(() => {
                            form.style.border = '';
                            form.style.boxShadow = '';
                        }, 4000);
                    }
                }, 200);
                
                alert('✅ Rule received from Visual Builder!\\n\\nCheck the form below and click Save to apply.');
            }
        });

        // Proxy Debug Logs Functions
        let lastDebugTimestamp = null;
        let debugLogsFetchInterval = null;
        
        async function loadDebugLogs() {
            try {
                const response = await fetch('/proxy/logs');
                const data = await response.json();
                const debugLogs = data.debugLogs || [];
                
                const debugLogsContainer = document.getElementById('debug-logs');
                
                if (debugLogs.length === 0) {
                    if (!lastDebugTimestamp) {
                        debugLogsContainer.innerHTML = '<div style="opacity: 0.6; text-align: center; padding: 20px;">No debug logs yet. Enhanced debug output will appear here.</div>';
                    }
                    return;
                }
                
                // On first load, add all logs
                if (lastDebugTimestamp === null) {
                    debugLogsContainer.innerHTML = '';
                    debugLogs.forEach(log => {
                        addDebugLogEntry(log.timestamp, log.message);
                    });
                    if (debugLogs.length > 0) {
                        lastDebugTimestamp = debugLogs[debugLogs.length - 1].timestamp;
                    }
                } else {
                    // Only add logs newer than our last timestamp
                    const newLogs = debugLogs.filter(log => log.timestamp > lastDebugTimestamp);
                    newLogs.forEach(log => {
                        addDebugLogEntry(log.timestamp, log.message);
                    });
                    if (newLogs.length > 0) {
                        lastDebugTimestamp = newLogs[newLogs.length - 1].timestamp;
                    }
                }
            } catch (error) {
                console.error('Failed to load debug logs:', error);
            }
        }
        
        function addDebugLogEntry(timestamp, message) {
            const debugLogsContainer = document.getElementById('debug-logs');
            if (!debugLogsContainer) return;
            
            // Remove placeholder if exists
            const placeholder = debugLogsContainer.querySelector('div[style*="opacity: 0.6"]');
            if (placeholder) {
                placeholder.remove();
            }
            
            const entry = document.createElement('div');
            entry.className = 'debug-log-entry';
            entry.dataset.timestamp = timestamp;
            
            // Determine styling based on message content - match standalone page exactly
            let messageClass = '';
            if (message.includes('KAREN')) {
                entry.classList.add('karen');
                messageClass = 'karen';
            } else if (message.includes('MASTER HANDLER')) {
                entry.classList.add('master');
                messageClass = 'master';
            } else if (message.includes('ERROR')) {
                entry.classList.add('error');
                messageClass = 'error';
            } else if (message.includes('SUCCESS')) {
                entry.classList.add('success');
                messageClass = 'success';
            }
            
            // Use the timestamp exactly as provided by the server (ISO format)
            entry.innerHTML = \`<span class="timestamp">\${escapeHtml(timestamp)}</span> <span class="message \${messageClass}">\${escapeHtml(message)}</span>\`;
            
            // Check if user is at bottom BEFORE any DOM manipulation
            const wasAtBottom = debugLogsContainer.scrollHeight - debugLogsContainer.scrollTop <= debugLogsContainer.clientHeight + 50; // 50px threshold
            
            debugLogsContainer.appendChild(entry);
            
            // Keep only last 500 entries
            while (debugLogsContainer.children.length > 500) {
                debugLogsContainer.removeChild(debugLogsContainer.firstChild);
            }
            
            // Apply current filter to new entry
            filterDebugLogs();
            
            // Only auto-scroll if user was already at the bottom
            if (wasAtBottom) {
                debugLogsContainer.scrollTop = debugLogsContainer.scrollHeight;
            }
        }
        
        // Start auto-refresh when on debug tab
        function startDebugLogsPolling() {
            if (debugLogsFetchInterval) return; // Already polling
            debugLogsFetchInterval = setInterval(() => {
                if (activeSessionId === 'proxy-debug') {
                    loadDebugLogs();
                }
            }, 1000); // Poll every second
        }
        
        function stopDebugLogsPolling() {
            if (debugLogsFetchInterval) {
                clearInterval(debugLogsFetchInterval);
                debugLogsFetchInterval = null;
            }
        }
        
        // Start polling when page loads if we're on debug tab
        if (activeSessionId === 'proxy-debug') {
            startDebugLogsPolling();
        }

        // Proxy Rules Functions
        let editingRuleId = null; // Track which rule is being edited
        
        function showAddRuleForm() {
            editingRuleId = null;
            document.getElementById('add-rule-form').classList.add('active');
            document.querySelector('.add-rule-form .add-rule-button').textContent = 'Save Rule';
        }

        function toggleFilterModifiedOnly() {
            const checkbox = document.getElementById('filter-modified-only');
            const proxyLogsContainer = document.getElementById('proxy-logs');
            const logEntries = proxyLogsContainer.querySelectorAll('.proxy-log-entry');
            
            logEntries.forEach(entry => {
                const isModified = entry.querySelector('.proxy-log-modifications') && 
                                 entry.querySelector('.proxy-log-modifications').children.length > 0;
                
                if (checkbox.checked) {
                    // Show only modified entries
                    entry.style.display = isModified ? '' : 'none';
                } else {
                    // Show all entries
                    entry.style.display = '';
                }
            });
        }

        async function clearProxyLogs() {
            try {
                await fetch('/proxy/clear-logs', { method: 'POST' });
                const proxyLogsContainer = document.getElementById('proxy-logs');
                proxyLogsContainer.innerHTML = '<div style="opacity: 0.6; text-align: center; padding: 20px;">Proxy logs will appear here when requests are made through the proxy.</div>';
                
                // Reset the filter checkbox
                document.getElementById('filter-modified-only').checked = false;
            } catch (error) {
                console.error('Failed to clear proxy logs:', error);
            }
        }
        
        async function clearDebugLogs() {
            try {
                await fetch('/proxy/clear-logs', { method: 'POST' });
                const debugLogsContainer = document.getElementById('debug-logs');
                debugLogsContainer.innerHTML = '<div style="opacity: 0.6; text-align: center; padding: 20px;">Proxy debug logs will appear here when requests are intercepted and modified.</div>';
                lastDebugTimestamp = null; // Reset timestamp tracking
            } catch (error) {
                console.error('Failed to clear debug logs:', error);
            }
        }
        
        function filterDebugLogs() {
            const filterValue = document.getElementById('debug-log-filter').value;
            const debugLogsContainer = document.getElementById('debug-logs');
            const entries = debugLogsContainer.querySelectorAll('.debug-log-entry');
            
            if (entries.length === 0) return;
            
            // Build request groups by finding request boundaries (━━━━ separators)
            const requestGroups = [];
            let currentGroup = { url: '', entries: [] };
            
            entries.forEach(entry => {
                const messageSpan = entry.querySelector('.message');
                const message = messageSpan ? messageSpan.textContent : '';
                
                // Check if this is a request start marker
                if (message.includes('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')) {
                    // Save previous group if it has entries
                    if (currentGroup.entries.length > 0) {
                        requestGroups.push(currentGroup);
                    }
                    // Start new group
                    currentGroup = { url: '', entries: [entry] };
                } else if (message.includes('📥 INCOMING REQUEST:')) {
                    // Extract URL from message like "📥 INCOMING REQUEST: GET https://example.com"
                    const urlMatch = message.match(/📥 INCOMING REQUEST: \\w+ (.+)/);
                    if (urlMatch) {
                        currentGroup.url = urlMatch[1];
                    }
                    currentGroup.entries.push(entry);
                } else {
                    // Add to current group
                    currentGroup.entries.push(entry);
                }
            });
            
            // Don't forget the last group
            if (currentGroup.entries.length > 0) {
                requestGroups.push(currentGroup);
            }
            
            // Apply filter based on selection
            if (filterValue === 'all') {
                // Show everything
                entries.forEach(entry => entry.style.display = 'flex');
            } else if (filterValue === 'chat-completions') {
                // Show only groups where URL contains "chat/completions"
                requestGroups.forEach(group => {
                    const shouldShow = group.url.includes('chat/completions');
                    group.entries.forEach(entry => {
                        entry.style.display = shouldShow ? 'flex' : 'none';
                    });
                });
            } else if (filterValue === 'matched-rules') {
                // Show entire request groups where ANY log indicates a rule matched
                requestGroups.forEach(group => {
                    // Check if any entry in this group shows a rule match
                    const hasMatch = group.entries.some(entry => {
                        const messageSpan = entry.querySelector('.message');
                        const message = messageSpan ? messageSpan.textContent : '';
                        return message.includes('✅ RULE MATCHED') ||
                               message.includes('SUCCESS') ||
                               message.includes('Applying rule') ||
                               (message.includes('Rule #') && !message.includes('not a match')) ||
                               message.includes('Transforming') ||
                               message.includes('Modified');
                    });
                    
                    // Show or hide the entire group
                    group.entries.forEach(entry => {
                        entry.style.display = hasMatch ? 'flex' : 'none';
                    });
                });
            }
        }
        
        function handleDropRequestChange() {
            const dropRequest = document.getElementById('rule-drop-request').checked;
            const dropStatusGroup = document.getElementById('rule-drop-status-group');
            
            if (dropRequest) {
                dropStatusGroup.style.display = 'block';
            } else {
                dropStatusGroup.style.display = 'none';
            }
        }
        
        async function handleScopeChange() {
            const scope = document.getElementById('rule-scope').value;
            const sessionIdGroup = document.getElementById('rule-session-id-group');
            const workspaceFolderGroup = document.getElementById('rule-workspace-folder-group');
            
            // Hide all scope-specific fields
            sessionIdGroup.style.display = 'none';
            workspaceFolderGroup.style.display = 'none';
            
            // Show fields based on selected scope
            if (scope === 'session') {
                sessionIdGroup.style.display = 'block';
                // Load available sessions and wait for them to load
                await loadSessionsForDropdown();
            } else if (scope === 'workspace') {
                workspaceFolderGroup.style.display = 'block';
            }
        }
        
        async function loadSessionsForDropdown() {
            try {
                const response = await fetch('/sessions');
                const data = await response.json();
                const sessionDropdown = document.getElementById('rule-session-id');
                
                // Clear existing options except first one
                sessionDropdown.innerHTML = '<option value="">Select a session...</option>';
                
                // Add sessions
                data.sessions.forEach(session => {
                    const option = document.createElement('option');
                    option.value = session.id;
                    option.textContent = session.name;
                    option.title = \`Session ID: \${session.id}\${session.workspacePath ? ' | Workspace: ' + session.workspacePath : ''}\`;
                    sessionDropdown.appendChild(option);
                });
                
                if (data.sessions.length === 0) {
                    const option = document.createElement('option');
                    option.value = '';
                    option.textContent = 'No active sessions';
                    option.disabled = true;
                    sessionDropdown.appendChild(option);
                }
            } catch (error) {
                console.error('Failed to load sessions:', error);
            }
        }
        
        function hideAddRuleForm() {
            editingRuleId = null;
            document.getElementById('add-rule-form').classList.remove('active');
            document.getElementById('rule-name').value = '';
            document.getElementById('rule-pattern').value = '';
            document.getElementById('rule-redirect').value = '';
            document.getElementById('rule-jsonata').value = '';
            document.getElementById('rule-drop-request').checked = false;
            document.getElementById('rule-drop-status').value = '204';
            document.getElementById('rule-scope').value = 'global';
            document.getElementById('rule-session-id').value = '';
            document.getElementById('rule-workspace-folder').value = '';
            document.getElementById('rule-debug').checked = false;
            handleScopeChange(); // Reset scope visibility
            document.querySelector('.add-rule-form .add-rule-button').textContent = 'Save Rule';
        }
        
        async function editProxyRule(ruleId) {
            try {
                const response = await fetch(\`/proxy/rules\`);
                const rules = await response.json();
                const rule = rules.find(r => r.id === ruleId);
                
                if (!rule) {
                    alert('Rule not found');
                    return;
                }
                
                // Set edit mode
                editingRuleId = ruleId;
                
                // Pre-populate form
                document.getElementById('rule-name').value = rule.name || '';
                document.getElementById('rule-pattern').value = rule.pattern || '';
                document.getElementById('rule-redirect').value = rule.redirect || '';
                document.getElementById('rule-jsonata').value = rule.jsonata || '';
                document.getElementById('rule-drop-request').checked = rule.dropRequest || false;
                document.getElementById('rule-drop-status').value = rule.dropStatusCode || 204;
                document.getElementById('rule-scope').value = rule.scope || 'global';
                document.getElementById('rule-workspace-folder').value = rule.workspaceFolder || '';
                document.getElementById('rule-debug').checked = rule.debug || false;
                
                // Update drop status visibility
                handleDropRequestChange();
                
                // Update scope visibility and reload sessions if needed
                await handleScopeChange();
                
                // After sessions are loaded, set the selected session
                if (rule.sessionId) {
                    document.getElementById('rule-session-id').value = rule.sessionId;
                }
                
                // Show form in edit mode
                document.getElementById('add-rule-form').classList.add('active');
                document.querySelector('.add-rule-form .add-rule-button').textContent = 'Update Rule';
            } catch (error) {
                console.error('Failed to load rule for editing:', error);
                alert('Failed to load rule for editing');
            }
        }
        
        async function loadProxyRules() {
            try {
                const response = await fetch('/proxy/rules');
                const rules = await response.json();
                
                const rulesListContainer = document.getElementById('proxy-rules-list');
                rulesListContainer.innerHTML = '';
                
                if (rules.length === 0) {
                    rulesListContainer.innerHTML = '<div style="opacity: 0.6; text-align: center; padding: 20px;">No proxy rules configured. Click "Add Rule" to create one.</div>';
                } else {
                    rules.forEach(rule => addProxyRuleToUI(rule));
                }
            } catch (error) {
                console.error('Failed to load proxy rules:', error);
            }
        }
        
        function addProxyRuleToUI(rule) {
            const rulesListContainer = document.getElementById('proxy-rules-list');
            if (!rulesListContainer) return;
            
            // Remove placeholder if exists
            const placeholder = rulesListContainer.querySelector('div[style*="opacity: 0.6"]');
            if (placeholder) {
                placeholder.remove();
            }
            
            const ruleDiv = document.createElement('div');
            ruleDiv.className = \`proxy-rule \${rule.enabled ? '' : 'disabled'}\`;
            ruleDiv.dataset.ruleId = rule.id;
            
            // Build info lines
            let infoHtml = \`<div class="proxy-rule-name" style="font-weight: bold; color: #58a6ff; margin-bottom: 4px;">\${escapeHtml(rule.name || 'Unnamed Rule')}</div>\`;
            infoHtml += \`<div class="proxy-rule-pattern">\${escapeHtml(rule.pattern)}</div>\`;
            
            if (rule.dropRequest) {
                infoHtml += \`<div class="proxy-rule-target" style="color: #d73a49;">🚫 DROP REQUEST (status \${rule.dropStatusCode || 204})</div>\`;
            } else {
                if (rule.redirect) {
                    infoHtml += \`<div class="proxy-rule-target">➜ \${escapeHtml(rule.redirect)}</div>\`;
                }
                
                if (rule.jsonata) {
                    infoHtml += \`<div class="proxy-rule-target" style="font-size: 11px; opacity: 0.8;">
                        🔄 JSONata: \${escapeHtml(rule.jsonata.length > 50 ? rule.jsonata.substring(0, 47) + '...' : rule.jsonata)}</div>\`;
                }
                
                // Support legacy rules
                if (rule.jsonPath && rule.replacement) {
                    infoHtml += \`<div class="proxy-rule-target" style="font-size: 11px; opacity: 0.8; color: orange;">
                        ⚠️ Legacy JSONPath: \${escapeHtml(rule.jsonPath)} → \${escapeHtml(rule.replacement)}</div>\`;
                }
            }
            
            ruleDiv.innerHTML = \`
                <div class="proxy-rule-info">
                    \${infoHtml}
                </div>
                <div class="proxy-rule-actions">
                    <label class="toggle-switch">
                        <input type="checkbox" \${rule.enabled ? 'checked' : ''} onchange="toggleProxyRule('\${rule.id}', this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                    <button class="edit-rule-button" onclick="editProxyRule('\${rule.id}')">✏️</button>
                    <button class="delete-rule-button" onclick="deleteProxyRule('\${rule.id}')">Delete</button>
                </div>
            \`;
            
            rulesListContainer.appendChild(ruleDiv);
        }
        
        async function saveNewRule() {
            const name = document.getElementById('rule-name').value.trim();
            const pattern = document.getElementById('rule-pattern').value.trim();
            const redirect = document.getElementById('rule-redirect').value.trim();
            const jsonata = document.getElementById('rule-jsonata').value.trim();
            const dropRequest = document.getElementById('rule-drop-request').checked;
            const dropStatusCode = parseInt(document.getElementById('rule-drop-status').value) || 204;
            const scope = document.getElementById('rule-scope').value;
            const sessionIdSelect = document.getElementById('rule-session-id');
            const sessionId = sessionIdSelect.value.trim();
            const sessionName = sessionIdSelect.selectedIndex > 0 ? sessionIdSelect.options[sessionIdSelect.selectedIndex].textContent : '';
            const workspaceFolder = document.getElementById('rule-workspace-folder').value.trim();
            const debug = document.getElementById('rule-debug').checked;
            
            if (!name) {
                alert('Please provide a rule name');
                return;
            }
            
            if (!pattern) {
                alert('Please provide a URL pattern');
                return;
            }
            
            if (!dropRequest && !redirect && !jsonata) {
                alert('Please provide either: drop request, redirect URL, or JSONata transformation');
                return;
            }
            
            // Validate scope-specific requirements
            if (scope === 'session' && !sessionId) {
                alert('Please provide a session ID for session-scoped rules');
                return;
            }
            
            if (scope === 'workspace' && !workspaceFolder) {
                alert('Please provide a workspace folder path for workspace-scoped rules');
                return;
            }
            
            try {
                // Validate regex pattern
                new RegExp(pattern);
            } catch (error) {
                alert('Invalid regex pattern: ' + error.message);
                return;
            }
            
            try {
                const ruleData = {
                    name,
                    pattern,
                    redirect: redirect || undefined,
                    jsonata: jsonata || undefined,
                    dropRequest: dropRequest,
                    dropStatusCode: dropRequest ? dropStatusCode : undefined,
                    enabled: true,
                    scope: scope,
                    sessionId: scope === 'session' ? sessionId : undefined,
                    sessionName: scope === 'session' && sessionName ? sessionName : undefined,
                    workspaceFolder: scope === 'workspace' ? workspaceFolder : undefined,
                    debug: debug
                };
                
                let response;
                if (editingRuleId) {
                    // Update existing rule
                    response = await fetch(\`/proxy/rules/\${editingRuleId}\`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(ruleData)
                    });
                } else {
                    // Create new rule
                    response = await fetch('/proxy/rules', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(ruleData)
                    });
                }
                
                if (!response.ok) {
                    throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
                }
                
                const result = await response.json();
                if (result.success) {
                    hideAddRuleForm();
                    loadProxyRules();
                } else {
                    alert(\`Failed to \${editingRuleId ? 'update' : 'save'} rule: \` + (result.error || 'Unknown error'));
                }
            } catch (error) {
                alert(\`Error \${editingRuleId ? 'updating' : 'saving'} rule: \` + error.message);
                console.error(\`Failed to \${editingRuleId ? 'update' : 'save'} rule:\`, error);
            }
        }
        
        async function toggleProxyRule(ruleId, enabled) {
            try {
                const response = await fetch(\`/proxy/rules/\${ruleId}\`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                
                if (!response.ok) {
                    throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
                }
                
                const result = await response.json();
                if (result.success) {
                    const ruleDiv = document.querySelector(\`[data-rule-id="\${ruleId}"]\`);
                    if (ruleDiv) {
                        ruleDiv.classList.toggle('disabled', !enabled);
                    }
                } else {
                    alert('Failed to update rule: ' + (result.error || 'Unknown error'));
                    loadProxyRules(); // Reload to sync state
                }
            } catch (error) {
                alert('Error updating rule: ' + error.message);
                console.error('Failed to toggle rule:', error);
                loadProxyRules(); // Reload to sync state
            }
        }
        
        async function deleteProxyRule(ruleId) {
            if (!confirm('Are you sure you want to delete this rule?')) {
                return;
            }
            
            try {
                const response = await fetch(\`/proxy/rules/\${ruleId}\`, {
                    method: 'DELETE'
                });
                
                if (!response.ok) {
                    throw new Error(\`HTTP \${response.status}: \${response.statusText}\`);
                }
                
                const result = await response.json();
                if (result.success) {
                    loadProxyRules();
                } else {
                    alert('Failed to delete rule: ' + (result.error || 'Unknown error'));
                }
            } catch (error) {
                alert('Error deleting rule: ' + error.message);
                console.error('Failed to delete rule:', error);
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
      
      // Try to load message settings from workspace override file
      try {
        const overrideFilePath = path.join(workspacePath, '.vscode', 'HumanAgentOverride.json');
        if (fs.existsSync(overrideFilePath)) {
          const overrideContent = fs.readFileSync(overrideFilePath, 'utf8');
          const overrideFileData = JSON.parse(overrideContent);
          if (overrideFileData.messageSettings) {
            this.sessionMessageSettings.set(sessionId, overrideFileData.messageSettings);
            this.debugLogger.log('INFO', `Loaded message settings from override file for session ${sessionId}`);
          }
        }
      } catch (error) {
        this.debugLogger.log('ERROR', `Failed to load message settings from override file: ${error}`);
      }
    }
    
    this.debugLogger.log('INFO', `Session registered: ${sessionId} (${this.activeSessions.size} total sessions)`);
    
    // Get quick reply options for this session
    const messageSettings = this.sessionMessageSettings.get(sessionId);
    let quickReplyOptions = [
      "Yes Please Proceed",
      "Explain in more detail please"
    ];
    
    if (messageSettings && messageSettings.quickReplies && messageSettings.quickReplies.options && Array.isArray(messageSettings.quickReplies.options)) {
      quickReplyOptions = messageSettings.quickReplies.options;
    }
    
    // Send session registration to web interface only (for web UI tab creation)
    this.sendToWebInterface('session-registered', { sessionId, totalSessions: this.activeSessions.size, quickReplyOptions });
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