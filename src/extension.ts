import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { ChatTreeProvider } from './providers/chatTreeProvider';
import { ChatWebviewProvider } from './webview/chatWebviewProvider';
import { McpConfigManager } from './mcp/mcpConfigManager';
import { ServerManager } from './serverManager';

let chatTreeProvider: ChatTreeProvider;
let mcpConfigManager: McpConfigManager;
let workspaceSessionId: string;
let serverManager: ServerManager;

// Generate or retrieve persistent workspace session ID
function getWorkspaceSessionId(context: vscode.ExtensionContext): string {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const workspaceKey = workspaceRoot ? `workspace-${crypto.createHash('md5').update(workspaceRoot).digest('hex')}` : 'no-workspace';
	
	// Try to get existing session ID from global state
	let sessionId = context.globalState.get<string>(`sessionId-${workspaceKey}`);
	
	if (!sessionId) {
		// Generate new UUID-based session ID
		sessionId = `session-${crypto.randomUUID()}`;
		// Store it persistently
		context.globalState.update(`sessionId-${workspaceKey}`, sessionId);
		console.log(`Generated new workspace session ID: ${sessionId} for ${workspaceKey}`);
	} else {
		console.log(`Retrieved existing workspace session ID: ${sessionId} for ${workspaceKey}`);
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
	console.log('HumanAgent MCP extension is now active!');

	// Generate or retrieve persistent workspace session ID
	workspaceSessionId = getWorkspaceSessionId(context);

	// Restore the persisted session name for this session ID
	await restoreSessionName(context, workspaceSessionId);

	// Initialize MCP Configuration Manager
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	mcpConfigManager = new McpConfigManager(workspaceRoot, context.extensionPath);

	// Initialize Server Manager
	const serverPath = path.join(context.extensionPath, 'dist', 'mcpStandalone.js');
	
	// Check if logging is enabled via user settings
	const config = vscode.workspace.getConfiguration('humanagent-mcp');
	const loggingEnabled = config.get<boolean>('logging.enabled', false);
	const loggingLevel = config.get<string>('logging.level', 'INFO');
	
	const serverOptions: any = {
		serverPath: serverPath,
		port: 3737,
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

	// Auto-detect and start standalone MCP server if already configured
	await autoStartMcpServer(mcpConfigManager, workspaceSessionId);

	// Initialize Tree View Provider
	chatTreeProvider = new ChatTreeProvider();
	const treeView = vscode.window.createTreeView('humanagent-mcp.chatSessions', {
		treeDataProvider: chatTreeProvider,
		showCollapseAll: true
	});

	// Initialize Chat Webview Provider (no internal server dependency)
	const chatWebviewProvider = new ChatWebviewProvider(context.extensionUri, null, mcpConfigManager, workspaceSessionId, context);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatWebviewProvider.viewType, chatWebviewProvider)
	);

	// Notify webview that registration check is complete
	chatWebviewProvider.notifyRegistrationComplete();

	// Register Commands
	const openChatCommand = vscode.commands.registerCommand('humanagent-mcp.openChat', () => {
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
		const isWorkspaceRegistered = mcpConfigManager?.isMcpServerRegistered(false) ?? false;
		const isGlobalRegistered = mcpConfigManager?.isMcpServerRegistered(true) ?? false;
		
		// Get detailed server status
		const serverStatus = await serverManager.getServerStatus();
		
		vscode.window.showInformationMessage(
			`HumanAgent MCP Server Status:\n` +
			`- Running: ${serverStatus.isRunning ? '✅' : '❌'}\n` +
			`- PID: ${serverStatus.pid || 'N/A'}\n` +
			`- Port: ${serverStatus.port}\n` +
			`- Host: ${serverStatus.host}\n` +
			`- Session: ${workspaceSessionId}\n` +
			`- Workspace registration: ${isWorkspaceRegistered ? '✅' : '❌'}\n` +
			`- Global registration: ${isGlobalRegistered ? '✅' : '❌'}`
		);
	});

	// Create server management commands
	const startServerCommand = vscode.commands.registerCommand('humanagent-mcp.startServer', async () => {
		try {
			const success = await serverManager.ensureServerRunning();
			if (success) {
				vscode.window.showInformationMessage('HumanAgent MCP Server started successfully!');
			} else {
				vscode.window.showErrorMessage('Failed to start HumanAgent MCP Server. Check the logs for details.');
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to start server: ${error}`);
		}
	});

	const stopServerCommand = vscode.commands.registerCommand('humanagent-mcp.stopServer', async () => {
		try {
			const success = await serverManager.stopServer();
			if (success) {
				vscode.window.showInformationMessage('HumanAgent MCP Server stopped successfully!');
			} else {
				vscode.window.showWarningMessage('Server may not have been running or failed to stop cleanly.');
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
			} else {
				vscode.window.showErrorMessage('Failed to restart HumanAgent MCP Server. Check the logs for details.');
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to restart server: ${error}`);
		}
	});

	const configureMcpCommand = vscode.commands.registerCommand('humanagent-mcp.configureMcp', async () => {
		// Refresh state checks each time the command is executed
		const hasWorkspace = mcpConfigManager?.hasWorkspace() ?? false;
		const isWorkspaceRegistered = mcpConfigManager?.isMcpServerRegistered(false) ?? false;
		const isGlobalRegistered = mcpConfigManager?.isMcpServerRegistered(true) ?? false;
		
		console.log(`HumanAgent MCP: Configure command - hasWorkspace: ${hasWorkspace}, workspaceRegistered: ${isWorkspaceRegistered}, globalRegistered: ${isGlobalRegistered}`);

		const options = [];
		
		// Server management options
		const serverStatus = await serverManager.getServerStatus();
		if (serverStatus.isRunning) {
			options.push('🔴 Stop Server');
			options.push('🔄 Restart Server');
		} else {
			options.push('▶️ Start Server');
		}
		
		if (hasWorkspace) {
			if (isWorkspaceRegistered) {
				options.push('🗑️ Unregister from This Workspace');
				console.log('HumanAgent MCP: Added workspace UNREGISTER option');
			} else {
				options.push('📝 Register for This Workspace');
				console.log('HumanAgent MCP: Added workspace REGISTER option');
			}
		}
		
		if (isGlobalRegistered) {
			options.push('🗑️ Unregister Globally');
			console.log('HumanAgent MCP: Added global UNREGISTER option');
		} else {
			options.push('🌐 Register Globally');
			console.log('HumanAgent MCP: Added global REGISTER option');
		}
		
		if (hasWorkspace) {
			options.push('📄 Open Workspace Configuration');
		}
		options.push('📊 Show Status');
		
		console.log(`HumanAgent MCP: Final options: ${options.join(', ')}`);

		const action = await vscode.window.showQuickPick(options, {
			placeHolder: 'Choose MCP Server configuration action:'
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
				case '📝 Register for This Workspace':
					await mcpConfigManager!.ensureMcpServerRegistered(false);
					vscode.window.showInformationMessage('MCP server registered for this workspace! Restart VS Code to enable Copilot integration.');
					break;
				case '🌐 Register Globally':
					await mcpConfigManager!.ensureMcpServerRegistered(true);
					vscode.window.showInformationMessage('MCP server registered globally! Restart VS Code to enable Copilot integration.');
					break;
				case '🗑️ Unregister from This Workspace':
					await mcpConfigManager!.removeMcpServerRegistration(false);
					vscode.window.showInformationMessage('MCP server unregistered from this workspace. Restart VS Code to apply changes.');
					break;
				case '🗑️ Unregister Globally':
					await mcpConfigManager!.removeMcpServerRegistration(true);
					vscode.window.showInformationMessage('MCP server unregistered globally. Restart VS Code to apply changes.');
					break;
				case '📄 Open Workspace Configuration':
					const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					if (workspaceRoot) {
						const configPath = vscode.Uri.file(workspaceRoot + '/.vscode/mcp.json');
						vscode.commands.executeCommand('vscode.open', configPath);
					}
					break;
				case '📊 Show Status':
					// Call the dedicated status command
					vscode.commands.executeCommand('humanagent-mcp.showStatus');
					break;
			}
		} catch (error) {
			vscode.window.showErrorMessage(`MCP configuration failed: ${error instanceof Error ? error.message : String(error)}`);
		}
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
		configureMcpCommand
	);

	// Show welcome message
	//vscode.window.showInformationMessage('HumanAgent MCP extension activated successfully!');
}

// Auto-detect MCP server configuration and guide user if needed
async function autoStartMcpServer(configManager: McpConfigManager, sessionId: string): Promise<void> {
	try {
		// Check for workspace configuration first (higher priority)
		if (configManager.isMcpServerRegistered(false)) {
			console.log(`HumanAgent MCP: Found workspace configuration for session ${sessionId}, checking server status...`);
			await ensureServerAccessibleAndRegister(sessionId, 'workspace');
			return;
		}
		
		// Check for global configuration
		if (configManager.isMcpServerRegistered(true)) {
			console.log(`HumanAgent MCP: Found global configuration for session ${sessionId}, checking server status...`);
			await ensureServerAccessibleAndRegister(sessionId, 'global');
			return;
		}
		
		// No configuration found - guide user to setup
		console.log(`HumanAgent MCP: No MCP configuration found for session ${sessionId}`);
		vscode.window.showInformationMessage(
			'HumanAgent MCP Server not configured. Use the Configure MCP command to set up the server.',
			'Configure Now'
		).then(selection => {
			if (selection === 'Configure Now') {
				vscode.commands.executeCommand('humanagent-mcp.configureMcp');
			}
		});
		
	} catch (error) {
		console.error('HumanAgent MCP: Failed to check server configuration:', error);
		vscode.window.showErrorMessage('Failed to check HumanAgent MCP Server configuration');
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

// Check if MCP server is accessible and responding
async function isServerAccessible(): Promise<boolean> {
	try {
		const response = await fetch('http://127.0.0.1:3737/sessions', {
			method: 'GET',
			signal: AbortSignal.timeout(5000) // 5 second timeout
		});
		return response.ok;
	} catch (error) {
		console.log('HumanAgent MCP: Server accessibility check failed:', error);
		return false;
	}
}

// Check if session exists on server by testing a simple MCP call
async function validateSessionWithServer(sessionId: string): Promise<boolean> {
	try {
		const response = await fetch('http://127.0.0.1:3737/mcp', {
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
		console.log(`HumanAgent MCP: Session ${sessionId} validation failed:`, error);
		return false;
	}
}

// Register session with standalone server via HTTP (always sends override data)
async function registerSessionWithStandaloneServer(sessionId: string, forceReregister: boolean = false): Promise<void> {
	try {
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
		
		const response = await fetch('http://127.0.0.1:3737/sessions/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ 
				sessionId,
				overrideData: overrideData,
				forceReregister: forceReregister
			})
		});
		
		if (response.ok) {
			const result = await response.json() as any;
			console.log(`HumanAgent MCP: Session ${sessionId} registered successfully. Total sessions: ${result.totalSessions}`);
		} else {
			console.error(`HumanAgent MCP: Failed to register session ${sessionId}: ${response.status}`);
		}
	} catch (error) {
		console.error(`HumanAgent MCP: Error registering session ${sessionId}:`, error);
	}
}

// Unregister session with standalone server via HTTP
async function unregisterSessionWithStandaloneServer(sessionId: string): Promise<void> {
	try {
		const response = await fetch('http://127.0.0.1:3737/sessions/unregister', {
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
	if (workspaceSessionId) {
		// Unregister from standalone server
		await unregisterSessionWithStandaloneServer(workspaceSessionId);
	}
	
	// Dispose the server manager (this won't stop the server, just cleanup resources)
	if (serverManager) {
		serverManager.dispose();
	}
	
	// Note: We don't kill the standalone server as it's running independently
	// Other extensions may still be using it, and it should persist across workspace changes
	console.log(`HumanAgent MCP: Extension deactivated for session ${workspaceSessionId}`);
}
