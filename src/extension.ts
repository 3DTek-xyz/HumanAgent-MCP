import * as vscode from 'vscode';
import * as path from 'path';
import * as net from 'net';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
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
let updateStatusBarItem: vscode.StatusBarItem | undefined;
let chatWebviewProvider: ChatWebviewProvider;

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
async function restoreSessionName(context: vscode.ExtensionContext, sessionId: string, port: number) {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const workspaceKey = workspaceRoot ? `workspace-${crypto.createHash('md5').update(workspaceRoot).digest('hex')}` : 'no-workspace';
	
	const savedName = context.globalState.get<string>(`sessionName-${workspaceKey}`);
	
	if (savedName) {
		try {
			// Send the saved name to the server
			const response = await fetch(`http://localhost:${port}/sessions/name`, {
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

/**
 * Check for extension updates from VS Code Marketplace
 * @returns Promise<string | null> - Latest version if available, null otherwise
 */
async function checkForUpdates(): Promise<string | null> {
	try {
		const currentVersion = vscode.extensions.getExtension('3DTek-xyz.humanagent-mcp')?.packageJSON.version;
		if (!currentVersion) {
			console.log('[UpdateCheck] Could not determine current extension version');
			return null;
		}

		console.log(`[UpdateCheck] Current version: ${currentVersion}`);

		// Query VS Code Marketplace API for latest version
		const response = await fetch('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
			method: 'POST',
			headers: {
				'Accept': 'application/json;api-version=3.0-preview.1',
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				filters: [{
					criteria: [
						{ filterType: 7, value: '3DTek-xyz.humanagent-mcp' }
					]
				}],
				flags: 914
			})
		});

		if (!response.ok) {
			console.log(`[UpdateCheck] Marketplace API returned ${response.status}`);
			return null;
		}

		const data: any = await response.json();
		const extension = data.results?.[0]?.extensions?.[0];
		if (!extension) {
			console.log('[UpdateCheck] Extension not found in marketplace response');
			return null;
		}

		const latestVersion = extension.versions?.[0]?.version;
		if (!latestVersion) {
			console.log('[UpdateCheck] Could not parse latest version from marketplace');
			return null;
		}

		console.log(`[UpdateCheck] Latest marketplace version: ${latestVersion}`);

		// Compare versions (simple string comparison works for semantic versioning)
		if (latestVersion > currentVersion) {
			console.log(`[UpdateCheck] ✅ Update available: ${currentVersion} → ${latestVersion}`);
			return latestVersion;
		}

		console.log('[UpdateCheck] Extension is up to date');
		return null;
	} catch (error) {
		console.log(`[UpdateCheck] Failed to check for updates: ${error}`);
		return null;
	}
}

/**
 * Show update notification and handle user response
 */
async function notifyUpdate(latestVersion: string, context: vscode.ExtensionContext) {
	// Create persistent status bar item FIRST (before dialog)
	updateStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	updateStatusBarItem.text = `$(cloud-download) v${latestVersion}`;
	updateStatusBarItem.tooltip = `HumanAgent MCP update available - Click to update to version ${latestVersion}`;
	updateStatusBarItem.command = 'humanagent-mcp.updateExtension';
	updateStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
	updateStatusBarItem.show();
	
	context.subscriptions.push(updateStatusBarItem);
	
	console.log(`[UpdateCheck] Status bar item created and shown for v${latestVersion}`);
	
	// Show notification without await so status bar is immediately visible
	vscode.window.showInformationMessage(
		`HumanAgent MCP v${latestVersion} is available! You're currently on an older version.`,
		'Update Now',
		'Later'
	).then(selection => {
		if (selection === 'Update Now') {
			performUpdate(latestVersion);
		}
	});
}

/**
 * Perform the extension update
 */
async function performUpdate(latestVersion: string) {
	try {
		// Trigger VS Code's built-in extension update
		await vscode.commands.executeCommand('workbench.extensions.installExtension', '3DTek-xyz.humanagent-mcp', {
			installPreReleaseVersion: false
		});
		
		// Hide status bar item after update starts
		if (updateStatusBarItem) {
			updateStatusBarItem.dispose();
			updateStatusBarItem = undefined;
		}
		
		vscode.window.showInformationMessage(
			'HumanAgent MCP is updating. You may need to reload VS Code after installation.',
			'Reload Now'
		).then(choice => {
			if (choice === 'Reload Now') {
				vscode.commands.executeCommand('workbench.action.reloadWindow');
			}
		});
	} catch (error) {
		vscode.window.showErrorMessage(`Failed to update extension: ${error}`);
	}
}

/**
 * Verify that the proxy CA certificate is installed and working
 * Platform-independent approach: Checks if cert exists in system keychain
 * @returns Promise<boolean> - true if certificate is installed, false otherwise
 */
async function verifyCertificateInstallation(): Promise<boolean> {
	try {
		console.log('[CertVerify] Checking certificate installation...');
		
		// Platform-specific certificate verification
		return new Promise<boolean>((resolve) => {
			let checkCommand: string;
			
			if (process.platform === 'darwin') {
				// macOS: Check if certificate exists in System.keychain
				checkCommand = 'security find-certificate -c "HumanAgent Proxy CA" /Library/Keychains/System.keychain 2>&1';
			} else if (process.platform === 'win32') {
				// Windows: Check if certificate exists in Root store
				checkCommand = 'certutil -verifystore Root "HumanAgent Proxy CA" 2>&1';
			} else {
				// Linux: Check NSS database
				checkCommand = 'certutil -L -d sql:$HOME/.pki/nssdb 2>&1 | grep "HumanAgent Proxy CA"';
			}
			
			// Execute check command
			const { exec } = require('child_process');
			exec(checkCommand, (error: any, stdout: string, stderr: string) => {
				if (error) {
					// Certificate not found
					console.log(`[CertVerify] ❌ Certificate not installed (exit code: ${error.code})`);
					resolve(false);
					return;
				}
				
				// Check if certificate name appears in output
				if (stdout.includes('HumanAgent Proxy CA')) {
					console.log('[CertVerify] ✅ Certificate is installed in system keychain');
					resolve(true);
				} else {
					console.log('[CertVerify] ❌ Certificate not found in system keychain');
					resolve(false);
				}
			});
		});
	} catch (error) {
		console.log(`[CertVerify] ❌ Verification failed: ${error}`);
		return false;
	}
}

export async function activate(context: vscode.ExtensionContext) {
	console.log('HumanAgent MCP extension activated!');

	// Initialize telemetry service
	telemetryService = new TelemetryService(context);
	await telemetryService.trackExtensionActivated();
	await telemetryService.trackFirstTimeUser(); // Track new installs
	await telemetryService.trackWeeklyActive(); // Track weekly retention

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
		if (require('fs').existsSync(overrideFilePath)) {
			console.log('HumanAgent MCP: Override file detected on startup, firing onDidChangeMcpServerDefinitions');
			mcpProvider.notifyServerDefinitionsChanged();
		}
	}

	// Initialize Server Manager
	const serverPath = path.join(context.extensionPath, 'dist', 'mcpStandalone.js');
	
	// Check if logging is enabled via user settings
	const config = vscode.workspace.getConfiguration('humanagent-mcp');
	const loggingEnabled = config.get<boolean>('logging.enabled', false);
	const loggingLevel = config.get<string>('logging.level', 'INFO');
	
	// Get certificate storage path from VS Code global storage
	const certStoragePath = context.globalStorageUri.fsPath;
	
	const serverOptions: any = {
		serverPath: serverPath,
		port: SERVER_PORT,
		host: '127.0.0.1',
		loggingEnabled: loggingEnabled,
		loggingLevel: loggingLevel,
		certStoragePath: certStoragePath
	};
	
	// Only add logFile if logging is enabled
	if (loggingEnabled && vscode.workspace.workspaceFolders?.[0]) {
		serverOptions.logFile = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.vscode', 'HumanAgent-server.log');
		console.log('HumanAgent MCP: Logging enabled to .vscode directory');
	}
	
	console.log(`HumanAgent MCP: Certificate storage path: ${certStoragePath}`);
	
	serverManager = ServerManager.getInstance(serverOptions);

	// Auto-start server and register session (no mcp.json dependency)
	await ensureServerAndRegisterSession(workspaceSessionId);

	// Check for extension updates on startup
	checkForUpdates().then(latestVersion => {
		if (latestVersion) {
			notifyUpdate(latestVersion, context);
			
			// Also send to webview if it's active
			if (chatWebviewProvider) {
				chatWebviewProvider.showUpdateNotification(latestVersion);
			}
		}
	}).catch(error => {
		console.log(`[UpdateCheck] Update check failed: ${error}`);
	});

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
			await restoreSessionName(context, workspaceSessionId, SERVER_PORT);
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

	// Update proxy status in tree view periodically
	const updateProxyStatus = async () => {
		try {
			const serverStatus = await serverManager.getServerStatus();
			chatTreeProvider.updateProxyStatus(serverStatus.proxy);
		} catch (error) {
			console.error('Failed to update proxy status:', error);
		}
	};
	
	// Initial update
	updateProxyStatus();
	
	// Update every 10 seconds
	const proxyStatusInterval = setInterval(updateProxyStatus, 10000);
	context.subscriptions.push({ dispose: () => clearInterval(proxyStatusInterval) });

	// Initialize Chat Webview Provider (no internal server dependency)
	chatWebviewProvider = new ChatWebviewProvider(context.extensionUri, null, mcpConfigManager, workspaceSessionId, context, mcpProvider, SERVER_PORT, telemetryService);
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
		
		let statusMessage = 
			`HumanAgent MCP Server Status:\n` +
			`- Running: ${serverStatus.isRunning ? '✅' : '❌'}\n` +
			`- PID: ${serverStatus.pid || 'N/A'}\n` +
			`- Port: ${serverStatus.port}\n` +
			`- Host: ${serverStatus.host}\n` +
			`- Session: ${workspaceSessionId}\n` +
			`- Registration: Native Provider ✅`;
		
		if (serverStatus.proxy) {
			statusMessage += `\n\nProxy Server:\n` +
				`- Running: ${serverStatus.proxy.running ? '✅' : '❌'}\n` +
				`- Port: ${serverStatus.proxy.port || 'N/A'}`;
		}
		
		vscode.window.showInformationMessage(statusMessage);
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
				// MCP server restarted silently
				// Notify webview to reset reconnection backoff and try immediately
				chatWebviewProvider.notifyServerStarted();
			} else {
				vscode.window.showErrorMessage('Failed to restart HumanAgent MCP Server. Check the logs for details.');
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to restart server: ${error}`);
		}
	});

	// Configure MCP command removed - functionality moved to webview context menu

	// Register extension update command
	const updateExtensionCommand = vscode.commands.registerCommand('humanagent-mcp.updateExtension', async () => {
		const latestVersion = updateStatusBarItem?.text.match(/v([\d.]+)/)?.[1];
		if (latestVersion) {
			await performUpdate(latestVersion);
		}
	});

	// Register report issue command
	const reportIssueCommand = vscode.commands.registerCommand('humanagent-mcp.reportIssue', () => {
		vscode.env.openExternal(vscode.Uri.parse('https://github.com/benharper/HumanAgent-MCP/issues'));
	});

	// Register install proxy certificate command
	const installProxyCertificateCommand = vscode.commands.registerCommand('humanagent-mcp.installProxyCertificate', async () => {
		try {
			// Get certificate path from globalStorage
			const certStoragePath = context.globalStorageUri.fsPath;
			const certPath = path.join(certStoragePath, 'proxy-ca', 'ca.pem');
			
			// Check if certificate exists
			if (!fs.existsSync(certPath)) {
				vscode.window.showErrorMessage('Proxy certificate not found. Please start the proxy server first.');
				return;
			}
			
			// Show information message explaining what will happen
			const proceed = await vscode.window.showInformationMessage(
				'This will install the HumanAgent Proxy CA certificate to your system keychain. This requires administrator privileges (sudo password).',
				{ modal: true },
				'Install'
			);
			
			if (proceed !== 'Install') {
				return;
			}
			
			// Determine platform-specific command
			let installCommand: string;
			if (process.platform === 'darwin') {
				// macOS
				installCommand = `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`;
			} else if (process.platform === 'win32') {
				// Windows
				installCommand = `certutil -addstore Root "${certPath}"`;
			} else {
				// Linux
				vscode.window.showWarningMessage(
					'Certificate installation on Linux varies by distribution. Please install manually:\n' +
					`sudo cp "${certPath}" /usr/local/share/ca-certificates/humanagent-proxy-ca.crt && sudo update-ca-certificates`
				);
				return;
			}
			
			// Execute installation command
			const terminal = vscode.window.createTerminal('HumanAgent: Install Certificate');
			terminal.sendText(installCommand);
			terminal.show();
			
			// Wait a moment, then verify installation
			setTimeout(async () => {
				const verified = await verifyCertificateInstallation();
				if (verified) {
					vscode.window.showInformationMessage('✅ Proxy certificate installed successfully! You can now enable the proxy.');
				} else {
					vscode.window.showWarningMessage('Certificate installation may have failed. Please check the terminal output.');
				}
			}, 3000);
			
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to install certificate: ${error}`);
		}
	});

	// Register uninstall proxy certificate command
	const uninstallProxyCertificateCommand = vscode.commands.registerCommand('humanagent-mcp.uninstallProxyCertificate', async () => {
		try {
			// Check if proxy is currently enabled
			const proxyConfig = vscode.workspace.getConfiguration().get('http.proxy');
			if (proxyConfig) {
				// Disable proxy first
				const disableFirst = await vscode.window.showWarningMessage(
					'Proxy is currently enabled. It will be disabled before uninstalling the certificate.',
					{ modal: true },
					'Continue'
				);
				
				if (disableFirst !== 'Continue') {
					return;
				}
				
				await vscode.workspace.getConfiguration().update('http.proxy', undefined, vscode.ConfigurationTarget.Global);
				// Proxy disabled silently
			}
			
			// Show confirmation message
			const proceed = await vscode.window.showWarningMessage(
				'This will remove the HumanAgent Proxy CA certificate from your system keychain. This requires administrator privileges (sudo password).',
				{ modal: true },
				'Uninstall'
			);
			
			if (proceed !== 'Uninstall') {
				return;
			}
			
			// Determine platform-specific command
			let uninstallCommand: string;
			if (process.platform === 'darwin') {
				// macOS
				uninstallCommand = 'sudo security delete-certificate -c "HumanAgent Proxy CA" /Library/Keychains/System.keychain';
			} else if (process.platform === 'win32') {
				// Windows
				uninstallCommand = 'certutil -delstore Root "HumanAgent Proxy CA"';
			} else {
				// Linux
				vscode.window.showWarningMessage(
					'Certificate uninstallation on Linux varies by distribution. Please remove manually:\n' +
					'sudo rm /usr/local/share/ca-certificates/humanagent-proxy-ca.crt && sudo update-ca-certificates'
				);
				return;
			}
			
			// Execute uninstallation command
			const terminal = vscode.window.createTerminal('HumanAgent: Uninstall Certificate');
			terminal.sendText(uninstallCommand);
			terminal.show();
			
			setTimeout(() => {
				vscode.window.showInformationMessage('Certificate uninstalled. You may need to restart VS Code for changes to take effect.');
			}, 2000);
			
		} catch (error) {
			vscode.window.showErrorMessage(`Failed to uninstall certificate: ${error}`);
		}
	});

	// Register verify certificate command (internal use by enableProxy)
	const verifyCertificateCommand = vscode.commands.registerCommand('humanagent-mcp.verifyCertificate', async () => {
		return await verifyCertificateInstallation();
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
		updateExtensionCommand,
		reportIssueCommand,
		installProxyCertificateCommand,
		uninstallProxyCertificateCommand,
		verifyCertificateCommand
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
	
	// Get VS Code's session ID for mapping
	const vscodeSessionId = vscode.env.sessionId;
	console.log(`HumanAgent MCP: VS Code Session ID: ${vscodeSessionId}`);
	console.log(`HumanAgent MCP: Workspace Path: ${workspaceRoot || 'none'}`);
	
	const requestBody = { 
		sessionId,
		vscodeSessionId: vscodeSessionId,
		workspacePath: workspaceRoot,
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
	
	// Dispose the server manager (this won't stop the server, just cleanup resources)
	if (serverManager) {
		serverManager.dispose();
	}
	
	// Note: We don't kill the standalone server as it's running independently
	// Other extensions may still be using it, and it should persist across workspace changes
	console.log(`HumanAgent MCP: Extension deactivated for session ${workspaceSessionId}`);
}
