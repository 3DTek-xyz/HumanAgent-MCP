import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import { McpServer } from './mcp/server';
import { ChatTreeProvider } from './providers/chatTreeProvider';
import { ChatWebviewProvider } from './webview/chatWebviewProvider';
import { McpConfigManager } from './mcp/mcpConfigManager';

let mcpServer: McpServer;
let chatTreeProvider: ChatTreeProvider;
let mcpConfigManager: McpConfigManager;
let standaloneServerProcess: ChildProcess | undefined;
let workspaceSessionId: string;

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

export async function activate(context: vscode.ExtensionContext) {
	console.log('HumanAgent MCP extension is now active!');

	// Generate or retrieve persistent workspace session ID
	workspaceSessionId = getWorkspaceSessionId(context);

	// Initialize MCP Configuration Manager
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	mcpConfigManager = new McpConfigManager(workspaceRoot, context.extensionPath);

	// Initialize MCP Server (internal to extension)
	mcpServer = new McpServer(workspaceSessionId, workspaceRoot);
	
	// Auto-detect and start MCP server if already configured
	await autoStartMcpServer(mcpConfigManager, mcpServer, workspaceSessionId);

	// Register this workspace session with the internal server
	mcpServer.registerSession(workspaceSessionId, workspaceRoot);

	// Initialize Tree View Provider
	chatTreeProvider = new ChatTreeProvider();
	const treeView = vscode.window.createTreeView('humanagent-mcp.chatSessions', {
		treeDataProvider: chatTreeProvider,
		showCollapseAll: true
	});

	// Initialize Chat Webview Provider
	const chatWebviewProvider = new ChatWebviewProvider(context.extensionUri, mcpServer, mcpConfigManager, workspaceSessionId);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatWebviewProvider.viewType, chatWebviewProvider)
	);

	// Listen to MCP server events for direct messaging
	mcpServer.on('human-agent-request', async (data: any) => {
		// Update tree view to show active chat
		chatTreeProvider.updateActiveChat(true);
		// Ensure chat webview displays the message and sets up response handling
		await chatWebviewProvider.displayHumanAgentMessage(data.message, data.context, data.requestId);
	});

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
		const tools = mcpServer.getAvailableTools();
		const pendingRequests = mcpServer.getPendingRequests();
		
		vscode.window.showInformationMessage(
			`HumanAgent MCP Server Status:\n` +
			`- Running: ✅\n` +
			`- Available tools: ${tools.length}\n` +
			`- Pending requests: ${pendingRequests.length}\n` +
			`- Workspace registration: ${isWorkspaceRegistered ? '✅' : '❌'}\n` +
			`- Global registration: ${isGlobalRegistered ? '✅' : '❌'}`
		);
	});

	const configureMcpCommand = vscode.commands.registerCommand('humanagent-mcp.configureMcp', async () => {
		const hasWorkspace = mcpConfigManager?.hasWorkspace() ?? false;
		const isWorkspaceRegistered = mcpConfigManager?.isMcpServerRegistered(false) ?? false;
		const isGlobalRegistered = mcpConfigManager?.isMcpServerRegistered(true) ?? false;

		const options = [];
		
		if (hasWorkspace) {
			if (isWorkspaceRegistered) {
				options.push('🗑️ Unregister from This Workspace');
			} else {
				options.push('📝 Register for This Workspace');
			}
		}
		
		if (isGlobalRegistered) {
			options.push('🗑️ Unregister Globally');
		} else {
			options.push('🌐 Register Globally');
		}
		
		if (hasWorkspace) {
			options.push('📄 Open Workspace Configuration');
		}
		options.push('📊 Show Status');

		const action = await vscode.window.showQuickPick(options, {
			placeHolder: 'Choose MCP Server configuration action:'
		});

		if (!action) {
			return;
		}

		try {
			switch (action) {
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
		configureMcpCommand
	);

	// Show welcome message
	//vscode.window.showInformationMessage('HumanAgent MCP extension activated successfully!');
}

// Auto-detect and start MCP server if configured
async function autoStartMcpServer(configManager: McpConfigManager, server: McpServer, sessionId: string): Promise<void> {
	try {
		// Always start internal server first
		await server.start();
		
		// Check for workspace configuration first (higher priority)
		if (configManager.isMcpServerRegistered(false)) {
			console.log(`HumanAgent MCP: Found workspace configuration for session ${sessionId}, ensuring standalone server is running...`);
			await ensureSharedStandaloneServer(sessionId);
			return;
		}
		
		// Check for global configuration
		if (configManager.isMcpServerRegistered(true)) {
			console.log(`HumanAgent MCP: Found global configuration for session ${sessionId}, ensuring standalone server is running...`);
			await ensureSharedStandaloneServer(sessionId);
			return;
		}
		
		// No configuration found - show notification to guide user to setup
		console.log(`HumanAgent MCP: No configuration found for session ${sessionId}, only internal server running`);
		vscode.window.showInformationMessage('HumanAgent MCP Server ready - use the cog menu to configure installation');
		
	} catch (error) {
		console.error('HumanAgent MCP: Failed to auto-start server:', error);
		vscode.window.showErrorMessage('Failed to start HumanAgent MCP Server');
	}
}

// Check if a port is in use
async function isPortInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		
		server.listen(port, () => {
			server.close(() => resolve(false)); // Port is available
		});
		
		server.on('error', () => {
			resolve(true); // Port is in use
		});
	});
}

// Register session with standalone server via HTTP
async function registerSessionWithStandaloneServer(sessionId: string): Promise<void> {
	try {
		const response = await fetch('http://127.0.0.1:3737/sessions/register', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId })
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

// Ensure shared standalone MCP server is running for this session
async function ensureSharedStandaloneServer(sessionId: string): Promise<void> {
	try {
		// Check if port 3737 is already in use
		const portInUse = await isPortInUse(3737);
		
		if (portInUse) {
			console.log('HumanAgent MCP: Port 3737 is already in use - assuming standalone server is already running');
			return; // Don't start another server
		}

		// Kill existing process if we have one tracked
		if (standaloneServerProcess) {
			standaloneServerProcess.kill();
			standaloneServerProcess = undefined;
		}

		const serverPath = path.join(__dirname, 'mcpStandalone.js');
		console.log(`HumanAgent MCP: Starting independent shared server (detached) at:`, serverPath);
		
		return new Promise((resolve, reject) => {
			// Start server as detached process that runs independently
			standaloneServerProcess = spawn('node', [serverPath], {
				cwd: path.dirname(__dirname), // Go up one level from out/ to project root
				stdio: ['ignore', 'ignore', 'ignore'], // Completely detached
				detached: true
			});
			
			// Unref so this process doesn't keep the extension alive
			standaloneServerProcess.unref();
			standaloneServerProcess = undefined; // We don't track detached processes

			// Give it a moment to start, then register session
			setTimeout(async () => {
				// Test if server is running by checking the port
				const serverRunning = await isPortInUse(3737);
				if (serverRunning) {
					console.log(`HumanAgent MCP: Server detected, registering session ${sessionId}`);
					// Register this session with the standalone server
					await registerSessionWithStandaloneServer(sessionId);
					resolve();
				} else {
					console.log('HumanAgent MCP: Server may have failed to start, but continuing...');
					resolve(); // Don't fail - may have been already running
				}
			}, 2000);
		});

	} catch (error) {
		console.error('Error starting standalone server:', error);
		throw error;
	}
}

export async function deactivate() {
	if (mcpServer && workspaceSessionId) {
		mcpServer.unregisterSession(workspaceSessionId);
		mcpServer.stop();
		
		// Also unregister from standalone server
		await unregisterSessionWithStandaloneServer(workspaceSessionId);
	}
	
	// Note: We don't kill the standalone server as it's running independently
	// Other extensions may still be using it
	console.log(`HumanAgent MCP: Extension deactivated for session ${workspaceSessionId}`);
}
