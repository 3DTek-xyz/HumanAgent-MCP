import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { ChatTreeProvider } from './providers/chatTreeProvider';
import { ChatWebviewProvider } from './webview/chatWebviewProvider';
import { McpConfigManager } from './mcp/mcpConfigManager';
import { ServerManager } from './serverManager';
import { TelemetryService } from './telemetry/telemetryService';

let chatTreeProvider: ChatTreeProvider;
let mcpConfigManager: McpConfigManager;
let workspaceSessionId: string;
let serverManager: ServerManager;
let SERVER_PORT: number; // Dynamic port: 3738 for dev, 3737 for production
let telemetryService: TelemetryService;

// MCP Server Definition Provider for VS Code native MCP integration
class HumanAgentMcpProvider implements vscode.McpServerDefinitionProvider {
    private _onDidChangeMcpServerDefinitions = new vscode.EventEmitter<void>();
    readonly onDidChangeMcpServerDefinitions = this._onDidChangeMcpServerDefinitions.event;
    private serverVersion: string = Date.now().toString();

    constructor(private sessionId: string, private port: number) {}

    provideMcpServerDefinitions(token: vscode.CancellationToken): vscode.ProviderResult<vscode.McpHttpServerDefinition[]> {
        // Use separate endpoint for MCP tools to avoid SSE conflicts with webview
        const serverUrl = `http://127.0.0.1:${this.port}/mcp-tools?sessionId=${this.sessionId}`;
        const serverUri = vscode.Uri.parse(serverUrl);
        const server = new vscode.McpHttpServerDefinition('HumanAgentMCP', serverUri, {}, this.serverVersion);
        console.log(`HumanAgent MCP: Using separate MCP tools endpoint to avoid SSE conflicts (version: ${this.serverVersion})`);
        return [server];
    }

    // Update version to force VS Code to refresh cached tool definitions
    updateServerVersion(): void {
        this.serverVersion = Date.now().toString();
        console.log(`HumanAgent MCP: Updated server version to ${this.serverVersion} to force tool cache refresh`);
    }

    // Method to fire the change event when override files are reloaded
    notifyServerDefinitionsChanged(): void {
        this.updateServerVersion(); // Force VS Code to refresh cached tool definitions
        console.log('HumanAgent MCP: Firing onDidChangeMcpServerDefinitions event');
        this._onDidChangeMcpServerDefinitions.fire();
    }

    // Update session ID when it changes
    updateSessionId(newSessionId: string): void {
        this.sessionId = newSessionId;
        this.notifyServerDefinitionsChanged();
    }
}

let mcpProvider: HumanAgentMcpProvider;

// Generate or retrieve persistent workspace session ID
function getWorkspaceSessionId(context: vscode.ExtensionContext): string {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const workspaceKey = workspaceRoot ? `workspace-${crypto.createHash('md5').update(workspaceRoot).digest('hex')}` : 'no-workspace';
	
	// Check if running in Extension Development Host
	const isDevHost = context.extensionMode === vscode.ExtensionMode.Development;
	const devSuffix = isDevHost ? '-dev' : '';
	const stateKey = `sessionId-${workspaceKey}${devSuffix}`;
	
	// Try to get existing session ID from global state
	let sessionId = context.globalState.get<string>(stateKey);
	
	if (!sessionId) {
		// Generate new UUID-based session ID
		sessionId = `session-${crypto.randomUUID()}${devSuffix}`;
		// Store it persistently
		context.globalState.update(stateKey, sessionId);
		console.log(`Generated new workspace session ID: ${sessionId} for ${workspaceKey}${isDevHost ? ' (dev host)' : ''}`);
	} else {
		console.log(`Retrieved existing workspace session ID: ${sessionId} for ${workspaceKey}${isDevHost ? ' (dev host)' : ''}`);
	}
	
	return sessionId;
}

// Restore and send persisted session name to server
async function restoreSessionName(context: vscode.ExtensionContext, sessionId: string) {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const workspaceKey = workspaceRoot ? `workspace-${crypto.createHash('md5').update(workspaceRoot).digest('hex')}` : 'no-workspace';
	
	const savedName = context.globalState.get<string>(`sessionName-${workspaceKey}`);
	
	if (savedName) {
		try {
			// Send the saved name to the server
			const response = await fetch('http://localhost:3737/sessions/name', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					sessionId: sessionId,
					name: savedName
				})
			});
			
			if (response.ok) {
				console.log(`Restored session name: "${savedName}" for session ${sessionId}`);
			} else {
				console.log(`Failed to restore session name: HTTP ${response.status}`);
			}
		} catch (error) {
			console.log(`Failed to restore session name: ${error}`);
		}
	}
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('HumanAgent MCP extension activated!');

	// Initialize telemetry service
	telemetryService = new TelemetryService(context);
	await telemetryService.trackExtensionActivated();

	// Determine port based on extension mode (dev vs production)
	SERVER_PORT = context.extensionMode === vscode.ExtensionMode.Development ? 3738 : 3737;
	console.log(`Using port ${SERVER_PORT} (${context.extensionMode === vscode.ExtensionMode.Development ? 'development' : 'production'} mode);`);

	// Generate or retrieve persistent workspace session ID
	workspaceSessionId = getWorkspaceSessionId(context);

	// Initialize MCP Configuration Manager
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	mcpConfigManager = new McpConfigManager(workspaceRoot, context.extensionPath, SERVER_PORT);

	// Initialize and register VS Code native MCP provider
	mcpProvider = new HumanAgentMcpProvider(workspaceSessionId, SERVER_PORT);
	context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('humanagent-mcp.server', mcpProvider));
	console.log('HumanAgent MCP: Registered MCP server definition provider');

	// Fire startup event if override file exists to refresh VS Code tools
	if (workspaceRoot) {
		const overrideFilePath = path.join(workspaceRoot, '.vscode', 'HumanAgentOverride.json');
		if (fs.existsSync(overrideFilePath)) {
			console.log('HumanAgent MCP: Override file detected on startup, firing onDidChangeMcpServerDefinitions');
			mcpProvider.notifyServerDefinitionsChanged();
		}
	}

	// Initialize Server Manager
	// IMPORTANT: run the standalone server from globalStorage, not from the extension install folder.
	// This prevents VS Code extension updates from failing due to locked files under
	// %USERPROFILE%\.vscode\extensions\...\dist when the detached node process is running.
	const bundledServerPath = path.join(context.extensionPath, 'dist', 'mcpStandalone.js');
	const storageDir = context.globalStorageUri.fsPath;
	fs.mkdirSync(storageDir, { recursive: true });
	const extensionVersion = String((context.extension as any)?.packageJSON?.version || 'unknown');
	const serverPath = path.join(storageDir, `mcpStandalone-${extensionVersion}.js`);
	try {
		if (!fs.existsSync(serverPath)) {
			fs.copyFileSync(bundledServerPath, serverPath);
			console.log(`HumanAgent MCP: Copied standalone server to globalStorage: ${serverPath}`);
		}
		// Best-effort cleanup of older server copies (ignore errors if in-use)
		for (const entry of fs.readdirSync(storageDir)) {
			if (entry.startsWith('mcpStandalone-') && entry.endsWith('.js') && entry !== path.basename(serverPath)) {
				try {
					fs.unlinkSync(path.join(storageDir, entry));
				} catch {
					// ignore
				}
			}
		}
	} catch (copyError) {
		// Fallback: if copy fails for any reason, use the bundled path.
		console.log('HumanAgent MCP: Failed to stage standalone server in globalStorage; using bundled server path:', copyError);
	}
	
	// Check if logging is enabled via user settings
	const config = vscode.workspace.getConfiguration('humanagent-mcp');
	const loggingEnabled = config.get<boolean>('logging.enabled', false);
	const loggingLevel = config.get<string>('logging.level', 'INFO');
	
	const serverOptions: any = {
		serverPath: serverPath,
		port: SERVER_PORT,
		host: '127.0.0.1',
		loggingEnabled: loggingEnabled,
		loggingLevel: loggingLevel
	};
	
	// Only add logFile if logging is enabled
	if (loggingEnabled && vscode.workspace.workspaceFolders?.[0]) {
		serverOptions.logFile = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.vscode', 'HumanAgent-server.log');
		console.log('HumanAgent MCP: Logging enabled to .vscode directory');
	}
	
	serverManager = ServerManager.getInstance(serverOptions);

	// Auto-start server and register session (no mcp.json dependency)
	await ensureServerAndRegisterSession(workspaceSessionId);

	// Show startup notification
	const notificationConfig = vscode.workspace.getConfiguration('humanagent-mcp');
	const showStartupNotification = notificationConfig.get<boolean>('notifications.showStartup', true);
	
	if (showStartupNotification) {
		vscode.window.showInformationMessage(
			'HumanAgent MCP Extension is a new tool - please report any issues or suggestions on GitHub!',
			'Open Chat',
			'Show Status',
			'Report Issues'
			// 'Don\'t Show Again'
		).then(selection => {
			switch (selection) {
				case 'Open Chat':
					vscode.commands.executeCommand('humanagent-mcp.chatView.focus');
					break;
				case 'Show Status':
					vscode.commands.executeCommand('humanagent-mcp.showStatus');
					break;
				case 'Report Issues':
					vscode.env.openExternal(vscode.Uri.parse('https://github.com/3DTek-xyz/HumanAgent-MCP/issues'));
					break;
				// case 'Don\'t Show Again':
				// 	notificationConfig.update('notifications.showStartup', false, vscode.ConfigurationTarget.Global);
				// 	vscode.window.showInformationMessage('Startup notifications disabled. You can re-enable them in settings.');
				// 	break;
			}
		});
	}

	// Restore the persisted session name after server is running (with retry)
	setTimeout(async () => {
		try {
			await restoreSessionName(context, workspaceSessionId);
		} catch (error) {
			console.log('HumanAgent MCP: Could not restore session name on startup (server may not be ready yet):', error);
		}
	}, 1000); // Wait 1 second for server to fully start

	// Initialize Tree View Provider
	chatTreeProvider = new ChatTreeProvider();
	const treeView = vscode.window.createTreeView('humanagent-mcp.chatSessions', {
		treeDataProvider: chatTreeProvider,
		showCollapseAll: true
	});

	// Initialize Chat Webview Provider (no internal server dependency)
	const chatWebviewProvider = new ChatWebviewProvider(context.extensionUri, null, mcpConfigManager, workspaceSessionId, context, mcpProvider, SERVER_PORT, telemetryService);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatWebviewProvider.viewType, chatWebviewProvider)
	);

	// Notify webview that registration check is complete
	chatWebviewProvider.notifyRegistrationComplete();

	// Register Commands
	const openChatCommand = vscode.commands.registerCommand('humanagent-mcp.openChat', () => {
		// Track chat opened from command palette
		telemetryService.trackChatOpened('command_palette');
		// Focus the chat webview
		vscode.commands.executeCommand('humanagent-mcp.chatView.focus');
	});

	const createSessionCommand = vscode.commands.registerCommand('humanagent-mcp.createSession', async () => {
		// In sessionless mode, just open the chat view
		vscode.commands.executeCommand('humanagent-mcp.chatView.focus');
		vscode.window.showInformationMessage(`Chat interface ready for HumanAgent communication`);
	});

	const refreshSessionsCommand = vscode.commands.registerCommand('humanagent-mcp.refreshSessions', () => {
		// In sessionless mode, just update the tree view
		chatTreeProvider.refresh();
	});

	// Create dedicated status command
	const showStatusCommand = vscode.commands.registerCommand('humanagent-mcp.showStatus', async () => {
		// Get detailed server status
		const serverStatus = await serverManager.getServerStatus();
		
		vscode.window.showInformationMessage(
			`HumanAgent MCP Server Status:\n` +
			`- Running: ${serverStatus.isRunning ? '✅' : '❌'}\n` +
			`- PID: ${serverStatus.pid || 'N/A'}\n` +
			`- Port: ${serverStatus.port}\n` +
			`- Host: ${serverStatus.host}\n` +
			`- Session: ${workspaceSessionId}\n` +
			`- Registration: Native Provider ✅`
		);
	});

	// Create server management commands
	const startServerCommand = vscode.commands.registerCommand('humanagent-mcp.startServer', async () => {
		try {
			const success = await serverManager.ensureServerRunning();
			if (success) {
				vscode.window.showInformationMessage('HumanAgent MCP Server started successfully!');
				// Notify webview to reset reconnection backoff and try immediately
				chatWebviewProvider.notifyServerStarted();
			} else {
				vscode.window.showErrorMessage('Failed to start HumanAgent MCP Server. Check the logs for details.');
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to start server: ${error}`);
		}
	});

	const stopServerCommand = vscode.commands.registerCommand('humanagent-mcp.stopServer', async () => {
		try {
			// First try HTTP shutdown endpoint (works from any VS Code window or client)
			try {
				const http = require('http');
				const options = {
					hostname: '127.0.0.1',
					port: SERVER_PORT,
					path: '/shutdown',
					method: 'POST',
					timeout: 5000
				};

				await new Promise<void>((resolve, reject) => {
					const req = http.request(options, (res: any) => {
						let data = '';
						res.on('data', (chunk: any) => data += chunk);
						res.on('end', () => {
							if (res.statusCode === 200) {
								resolve();
							} else {
								reject(new Error(`HTTP ${res.statusCode}`));
							}
						});
					});
					req.on('error', reject);
					req.on('timeout', () => {
						req.destroy();
						reject(new Error('Request timeout'));
					});
					req.end();
				});

				vscode.window.showInformationMessage('HumanAgent MCP Server stopped successfully!');
			} catch (httpError) {
				// Fallback to PID kill if HTTP fails
				console.log('HTTP shutdown failed, trying PID kill:', httpError);
				const success = await serverManager.stopServer();
				if (success) {
					vscode.window.showInformationMessage('HumanAgent MCP Server stopped successfully!');
				} else {
					vscode.window.showWarningMessage('Server may not have been running or failed to stop cleanly.');
				}
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to stop server: ${error}`);
		}
	});

	const restartServerCommand = vscode.commands.registerCommand('humanagent-mcp.restartServer', async () => {
		try {
			await serverManager.stopServer();
			await new Promise(resolve => setTimeout(resolve, 1000)); // Brief pause
			const success = await serverManager.ensureServerRunning();
			if (success) {
				vscode.window.showInformationMessage('HumanAgent MCP Server restarted successfully!');
				// Notify webview to reset reconnection backoff and try immediately
				chatWebviewProvider.notifyServerStarted();
			} else {
				vscode.window.showErrorMessage('Failed to restart HumanAgent MCP Server. Check the logs for details.');
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to restart server: ${error}`);
		}
	});

	const configureMcpCommand = vscode.commands.registerCommand('humanagent-mcp.configureMcp', async () => {
		const options = [];
		
		// Server management options only (registration handled automatically by native provider)
		const serverStatus = await serverManager.getServerStatus();
		if (serverStatus.isRunning) {
			options.push('🔴 Stop Server');
			options.push('🔄 Restart Server');
		} else {
			options.push('▶️ Start Server');
		}
		
		options.push('📊 Show Status');

		const action = await vscode.window.showQuickPick(options, {
			placeHolder: 'Choose MCP Server action:'
		});

		if (!action) {
			return;
		}

		try {
			switch (action) {
				case '▶️ Start Server':
					await vscode.commands.executeCommand('humanagent-mcp.startServer');
					break;
				case '🔴 Stop Server':
					await vscode.commands.executeCommand('humanagent-mcp.stopServer');
					break;
				case '🔄 Restart Server':
					await vscode.commands.executeCommand('humanagent-mcp.restartServer');
					break;
				case '📊 Show Status':
					vscode.commands.executeCommand('humanagent-mcp.showStatus');
					break;
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Server action failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	// Register report issue command
	const reportIssueCommand = vscode.commands.registerCommand('humanagent-mcp.reportIssue', () => {
		vscode.env.openExternal(vscode.Uri.parse('https://github.com/benharper/HumanAgent-MCP/issues'));
	});

	// Add all disposables to context
	context.subscriptions.push(
		treeView,
		openChatCommand,
		createSessionCommand,
		refreshSessionsCommand,
		showStatusCommand,
		startServerCommand,
		stopServerCommand,
		restartServerCommand,
		configureMcpCommand,
		reportIssueCommand
	);

	// Show welcome message
	//vscode.window.showInformationMessage('HumanAgent MCP extension activated successfully!');
}

// Simplified server startup and session registration (no mcp.json dependency)
async function ensureServerAndRegisterSession(sessionId: string): Promise<void> {
	try {
		console.log(`HumanAgent MCP: Starting server and registering session ${sessionId}...`);
		
		// Check if server is accessible, if not start it
		const serverAccessible = await isServerAccessible();
		if (!serverAccessible) {
			console.log('HumanAgent MCP: Server not accessible, starting server...');
			const serverStarted = await serverManager.ensureServerRunning();
			if (!serverStarted) {
				console.error('HumanAgent MCP: Failed to start server');
				vscode.window.showWarningMessage('HumanAgent MCP Server could not be started. Some features may not work.');
				return;
			}
			console.log('HumanAgent MCP: Server started successfully');
		}
		
		// Register session with the server
		const sessionExists = await validateSessionWithServer(sessionId);
		if (!sessionExists) {
			console.log(`HumanAgent MCP: Session ${sessionId} not found on server, registering new session...`);
			await registerSessionWithStandaloneServer(sessionId, false);
		} else {
			console.log(`HumanAgent MCP: Session ${sessionId} exists on server, re-registering with override data...`);
			await registerSessionWithStandaloneServer(sessionId, true);
		}
		console.log(`HumanAgent MCP: Session registration complete for ${sessionId}`);
		
	} catch (error) {
		console.error('HumanAgent MCP: Failed to start server or register session:', error);
		vscode.window.showWarningMessage('HumanAgent MCP Server could not be initialized. Please check the server status and try reloading the workspace.');
	}
}

// Check if a port is in use (using HTTP server like the MCP server)
async function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const http = require('http');
		const server = http.createServer();
		
		server.listen(port, '127.0.0.1', () => {
			server.close(() => resolve(false)); // Port is available
		});
		
		server.on('error', () => {
			resolve(true); // Port is in use
		});
	});
}

// Check if MCP server is accessible and responding with retry
async function isServerAccessible(): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/sessions`, {
			method: 'GET',
			signal: AbortSignal.timeout(5000) // 5 second timeout
		});
		return response.ok;
	} catch (error) {
		console.log('HumanAgent MCP: Server accessibility check failed, retrying in 3 seconds...', error);
		
		// Wait 3 seconds and try once more
		await new Promise(resolve => setTimeout(resolve, 3000));
		
		try {
			const retryResponse = await fetch(`http://127.0.0.1:${SERVER_PORT}/sessions`, {
				method: 'GET',
				signal: AbortSignal.timeout(5000)
			});
			
			if (retryResponse.ok) {
				console.log('HumanAgent MCP: Server accessible on retry');
				return true;
			}
		} catch (retryError) {
			console.log('HumanAgent MCP: Server accessibility retry failed:', retryError);
		}
		
		return false;
	}
}

// Check if session exists on server by testing a simple MCP call with retry
async function validateSessionWithServer(sessionId: string): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/mcp`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ 
				sessionId,
				method: 'tools/list'
			})
		});
		
		if (response.ok) {
			const result = await response.json() as any;
			console.log(`HumanAgent MCP: Session ${sessionId} validated on server`);
			return true;
		} else {
			console.log(`HumanAgent MCP: Session ${sessionId} not found on server (${response.status})`);
			return false;
		}
	} catch (error) {
		console.log(`HumanAgent MCP: Session ${sessionId} validation failed, retrying in 3 seconds...`, error);
		
		// Wait 3 seconds and try once more
		await new Promise(resolve => setTimeout(resolve, 3000));
		
		try {
			const retryResponse = await fetch(`http://127.0.0.1:${SERVER_PORT}/mcp`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ 
					sessionId,
					method: 'tools/list'
				})
			});
			
			if (retryResponse.ok) {
				const result = await retryResponse.json() as any;
				console.log(`HumanAgent MCP: Session ${sessionId} validated on server (retry)`);
				return true;
			} else {
				console.log(`HumanAgent MCP: Session ${sessionId} not found on server (${retryResponse.status}) (retry)`);
				return false;
			}
		} catch (retryError) {
			console.log(`HumanAgent MCP: Session ${sessionId} validation retry failed:`, retryError);
			return false;
		}
	}
}

// Register session with standalone server via HTTP (always sends override data) with retry
async function registerSessionWithStandaloneServer(sessionId: string, forceReregister: boolean = false): Promise<void> {
	// Read workspace override file if it exists
	let overrideData = null;
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (workspaceRoot) {
		const overrideFilePath = path.join(workspaceRoot, '.vscode', 'HumanAgentOverride.json');
		try {
			const fs = require('fs');
			if (fs.existsSync(overrideFilePath)) {
				const overrideContent = fs.readFileSync(overrideFilePath, 'utf8');
				overrideData = JSON.parse(overrideContent);
				console.log(`HumanAgent MCP: Loaded override data for session ${sessionId}`);
			}
		} catch (error) {
			console.error(`HumanAgent MCP: Error reading override file:`, error);
		}
	}
	
	const requestBody = { 
		sessionId,
		overrideData: overrideData,
		forceReregister: forceReregister
	};
	
	try {
		const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/sessions/register`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(requestBody)
		});
		
		if (response.ok) {
			const result = await response.json() as any;
			console.log(`HumanAgent MCP: Session ${sessionId} registered successfully. Total sessions: ${result.totalSessions}`);
			return;
		} else {
			console.error(`HumanAgent MCP: Failed to register session ${sessionId}: ${response.status}`);
		}
	} catch (error) {
		console.error(`HumanAgent MCP: Error registering session ${sessionId}, retrying in 3 seconds...`, error);
		telemetryService.trackError('connection_error', error instanceof Error ? error.message : String(error));
		
		// Wait 3 seconds and try once more
		await new Promise(resolve => setTimeout(resolve, 3000));
		
		try {
			const retryResponse = await fetch(`http://127.0.0.1:${SERVER_PORT}/sessions/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(requestBody)
			});
			
			if (retryResponse.ok) {
				const result = await retryResponse.json() as any;
				console.log(`HumanAgent MCP: Session ${sessionId} registered successfully on retry. Total sessions: ${result.totalSessions}`);
				return;
			} else {
				console.error(`HumanAgent MCP: Failed to register session ${sessionId} on retry: ${retryResponse.status}`);
				throw new Error(`Registration failed: ${retryResponse.status}`);
			}
		} catch (retryError) {
			console.error(`HumanAgent MCP: Session registration retry failed:`, retryError);
			throw new Error(`Registration failed after retry: ${retryError}`);
		}
	}
}

// Unregister session with standalone server via HTTP
async function unregisterSessionWithStandaloneServer(sessionId: string): Promise<void> {
	try {
		const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/sessions/unregister`, {
			method: 'DELETE',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId })
		});
		
		if (response.ok) {
			const result = await response.json() as any;
			console.log(`HumanAgent MCP: Session ${sessionId} unregistered successfully. Total sessions: ${result.totalSessions}`);
		} else {
			console.error(`HumanAgent MCP: Failed to unregister session ${sessionId}: ${response.status}`);
		}
	} catch (error) {
		console.error(`HumanAgent MCP: Error unregistering session ${sessionId}:`, error);
	}
}

// Check if server is accessible and register session, or start server if needed
async function ensureServerAccessibleAndRegister(sessionId: string, configType: 'workspace' | 'global'): Promise<void> {
	try {
		console.log(`HumanAgent MCP: Checking if server is accessible for ${configType} configuration...`);
		
		// Check if server is running and accessible
		let serverAccessible = await isServerAccessible();
		
		if (!serverAccessible) {
			console.log('HumanAgent MCP: Server not accessible, attempting to start it...');
			
			// Try to start the server
			const started = await serverManager.ensureServerRunning();
			if (started) {
				console.log('HumanAgent MCP: Server started successfully, rechecking accessibility...');
				// Wait a moment for server to fully initialize
				await new Promise(resolve => setTimeout(resolve, 2000));
				serverAccessible = await isServerAccessible();
			} else {
				console.log('HumanAgent MCP: Failed to start server');
			}
		}
		
		if (serverAccessible) {
			console.log('HumanAgent MCP: Server is accessible, registering session...');
			// Server is running, validate and register session
			const sessionExists = await validateSessionWithServer(sessionId);
			if (!sessionExists) {
				console.log(`HumanAgent MCP: Session ${sessionId} not found on server, registering new session...`);
				await registerSessionWithStandaloneServer(sessionId, false);
			} else {
				console.log(`HumanAgent MCP: Session ${sessionId} exists on server, re-registering with override data...`);
				await registerSessionWithStandaloneServer(sessionId, true);
			}
			console.log(`HumanAgent MCP: Session registration complete for ${sessionId}`);
		} else {
			// Server still not accessible after trying to start it
			console.log('HumanAgent MCP: Server could not be started or is not responding');
			const configLocation = configType === 'workspace' ? 'workspace' : 'global';
			
			vscode.window.showWarningMessage(
				`HumanAgent MCP Server is configured in ${configLocation} settings but could not be started. Would you like to try starting it manually?`,
				'Start Server', 'Show Status', 'Open Configuration'
			).then(selection => {
				switch (selection) {
					case 'Start Server':
						vscode.commands.executeCommand('humanagent-mcp.startServer');
						break;
					case 'Show Status':
						vscode.commands.executeCommand('humanagent-mcp.showStatus');
						break;
					case 'Open Configuration':
						vscode.commands.executeCommand('humanagent-mcp.configureMcp');
						break;
				}
			});
		}
		
	} catch (error) {
		console.error('Error checking server accessibility:', error);
		vscode.window.showErrorMessage('Failed to check HumanAgent MCP Server accessibility');
	}
}

export async function deactivate() {
	// Track deactivation event
	if (telemetryService) {
		await telemetryService.trackExtensionDeactivated();
	}
	
	if (workspaceSessionId) {
		// Unregister from standalone server
		await unregisterSessionWithStandaloneServer(workspaceSessionId);
	}

	// Stop the standalone server when VS Code closes / window reloads.
	// This prevents orphaned detached node processes from keeping the port occupied
	// and ensures a fresh restart on next activation.
	try {
		if (SERVER_PORT) {
			const http = require('http');
			await new Promise<void>((resolve, reject) => {
				const req = http.request(
					{
						hostname: '127.0.0.1',
						port: SERVER_PORT,
						path: '/shutdown',
						method: 'POST',
						timeout: 3000
					},
					(res: any) => {
						res.on('data', () => undefined);
						res.on('end', () => {
							if (res.statusCode === 200) {
								resolve();
							} else {
								reject(new Error(`HTTP ${res.statusCode}`));
							}
						});
					}
				);
				req.on('error', reject);
				req.on('timeout', () => {
					req.destroy();
					reject(new Error('Request timeout'));
				});
				req.end();
			});
			// Give the server a moment to release the port.
			await new Promise(resolve => setTimeout(resolve, 500));
		}
	} catch (shutdownError) {
		// Fallback to PID kill if HTTP shutdown fails
		try {
			if (serverManager) {
				await serverManager.stopServer();
			}
		} catch (killError) {
			console.log('HumanAgent MCP: Failed to stop server on deactivate:', killError);
		}
	}
	
	// Dispose the server manager (this won't stop the server, just cleanup resources)
	if (serverManager) {
		serverManager.dispose();
	}
	
	// Note: Server is intentionally stopped on deactivation to avoid orphaned processes.
	console.log(`HumanAgent MCP: Extension deactivated for session ${workspaceSessionId}`);
}
