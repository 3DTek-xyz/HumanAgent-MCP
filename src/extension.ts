import * as vscode from 'vscode';
import { McpServer } from './mcp/server';
import { ChatTreeProvider } from './providers/chatTreeProvider';
import { ChatWebviewProvider } from './webview/chatWebviewProvider';
import { McpConfigManager } from './mcp/mcpConfigManager';

let mcpServer: McpServer;
let chatTreeProvider: ChatTreeProvider;
let mcpConfigManager: McpConfigManager;

export async function activate(context: vscode.ExtensionContext) {
	console.log('HumanAgent MCP extension is now active!');

	// Initialize MCP Configuration Manager
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	mcpConfigManager = new McpConfigManager(workspaceRoot, context.extensionPath);

	// Initialize MCP Server (internal to extension)
	mcpServer = new McpServer();
	await mcpServer.start();

	// Initialize Tree View Provider
	chatTreeProvider = new ChatTreeProvider();
	const treeView = vscode.window.createTreeView('humanagent-mcp.chatSessions', {
		treeDataProvider: chatTreeProvider,
		showCollapseAll: true
	});

	// Initialize Chat Webview Provider
	const chatWebviewProvider = new ChatWebviewProvider(context.extensionUri, mcpServer, mcpConfigManager);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatWebviewProvider.viewType, chatWebviewProvider)
	);

	// Listen to MCP server events for direct messaging
	mcpServer.on('human-agent-request', (data: any) => {
		// Update tree view to show active chat
		chatTreeProvider.updateActiveChat(true);
		// Ensure chat webview displays the message and sets up response handling
		chatWebviewProvider.displayHumanAgentMessage(data.message, data.context, data.requestId);
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

	const showStatusCommand = vscode.commands.registerCommand('humanagent-mcp.showStatus', () => {
		const tools = mcpServer.getAvailableTools();
		const pendingRequests = mcpServer.getPendingRequests();
		
		const isRegistered = mcpConfigManager?.isMcpServerRegistered() ?? false;
		
		vscode.window.showInformationMessage(
			`HumanAgent MCP Server Status:
			- Running: ✅
			- Available tools: ${tools.length}
			- Pending requests: ${pendingRequests.length}
			- Registered with VS Code: ${isRegistered ? '✅' : '❌'}`
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
	vscode.window.showInformationMessage('HumanAgent MCP extension activated successfully!');
}

export async function deactivate() {
	if (mcpServer) {
		await mcpServer.stop();
	}
}
