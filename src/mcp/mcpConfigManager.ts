import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface McpServerConfig {
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface McpConfiguration {
  servers: Record<string, McpServerConfig>;
  inputs?: any[];
}

export class McpConfigManager {
  private static readonly MCP_CONFIG_FILE = '.vscode/mcp.json';
  private static readonly SERVER_NAME = 'humanagent-mcp';
  private static readonly GLOBAL_CONFIG_KEY = 'mcp.servers';
  
  constructor(private workspaceRoot?: string, private extensionPath?: string) {
    if (!extensionPath) {
      throw new Error('Extension path is required');
    }
  }

  async ensureMcpServerRegistered(global: boolean = false): Promise<boolean> {
    if (global) {
      return this.registerGlobally();
    } else {
      return this.registerInWorkspace();
    }
  }

  private async registerInWorkspace(): Promise<boolean> {
    const currentWorkspaceRoot = this.getCurrentWorkspaceRoot();
    if (!currentWorkspaceRoot) {
      throw new Error('No workspace folder available for workspace registration - this is a blank workspace');
    }

    if (!this.extensionPath) {
      throw new Error('Extension path not provided');
    }

    try {
      const mcpConfigPath = path.join(currentWorkspaceRoot, McpConfigManager.MCP_CONFIG_FILE);
      
      // Ensure .vscode directory exists
      const vscodeDirPath = path.dirname(mcpConfigPath);
      if (!fs.existsSync(vscodeDirPath)) {
        fs.mkdirSync(vscodeDirPath, { recursive: true });
      }

      // Read existing config or create new one
      let config: McpConfiguration = { servers: {}, inputs: [] };
      if (fs.existsSync(mcpConfigPath)) {
        try {
          const configContent = fs.readFileSync(mcpConfigPath, 'utf8');
          config = JSON.parse(configContent);
        } catch (error) {
          console.warn('Failed to parse existing mcp.json, creating new one', error);
        }
      }

      // Check if our server is already registered
      if (config.servers[McpConfigManager.SERVER_NAME]) {
        return true; // Already configured
      }

      // Use the extension path passed during construction

      // Configure our MCP server (HTTP transport)
      const serverConfig: McpServerConfig = {
        type: 'http',
        url: 'http://127.0.0.1:3737/mcp'
      };

      // Add our server to the config
      config.servers[McpConfigManager.SERVER_NAME] = serverConfig;

      // Write the updated config
      fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
      
      return true;
    } catch (error) {
      console.error('Failed to register MCP server in workspace:', error);
      throw error;
    }
  }

  private async registerGlobally(): Promise<boolean> {
    if (!this.extensionPath) {
      throw new Error('Extension path not provided');
    }

    try {
      // Use the extension path passed during construction

      // Configure our MCP server (HTTP transport)
      const serverConfig: McpServerConfig = {
        type: 'http',
        url: 'http://127.0.0.1:3737/mcp'
      };

      // Get current global MCP servers configuration
      const config = vscode.workspace.getConfiguration();
      const mcpServers = config.get<Record<string, McpServerConfig>>(McpConfigManager.GLOBAL_CONFIG_KEY) || {};

      // Add our server
      mcpServers[McpConfigManager.SERVER_NAME] = serverConfig;

      // Update global configuration
      await config.update(McpConfigManager.GLOBAL_CONFIG_KEY, mcpServers, vscode.ConfigurationTarget.Global);
      
      return true;
    } catch (error) {
      console.error('Failed to register MCP server globally:', error);
      throw error;
    }
  }

  async removeMcpServerRegistration(global: boolean = false): Promise<boolean> {
    if (global) {
      return this.unregisterGlobally();
    } else {
      return this.unregisterFromWorkspace();
    }
  }

  private async unregisterFromWorkspace(): Promise<boolean> {
    const currentWorkspaceRoot = this.getCurrentWorkspaceRoot();
    if (!currentWorkspaceRoot) {
      throw new Error('No workspace folder available for workspace unregistration');
    }

    try {
      const mcpConfigPath = path.join(currentWorkspaceRoot, McpConfigManager.MCP_CONFIG_FILE);
      
      if (!fs.existsSync(mcpConfigPath)) {
        return true; // Nothing to remove
      }

      const configContent = fs.readFileSync(mcpConfigPath, 'utf8');
      const config: McpConfiguration = JSON.parse(configContent);

      if (config.servers[McpConfigManager.SERVER_NAME]) {
        delete config.servers[McpConfigManager.SERVER_NAME];
        fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
      }

      return true;
    } catch (error) {
      console.error('Failed to remove MCP server registration from workspace:', error);
      throw error;
    }
  }

  private async unregisterGlobally(): Promise<boolean> {
    try {
      const config = vscode.workspace.getConfiguration();
      const mcpServers = config.get<Record<string, McpServerConfig>>(McpConfigManager.GLOBAL_CONFIG_KEY) || {};

      if (mcpServers[McpConfigManager.SERVER_NAME]) {
        // Create a new object without the server instead of mutating the original
        const updatedServers = { ...mcpServers };
        delete updatedServers[McpConfigManager.SERVER_NAME];
        await config.update(McpConfigManager.GLOBAL_CONFIG_KEY, updatedServers, vscode.ConfigurationTarget.Global);
      }

      return true;
    } catch (error) {
      console.error('Failed to remove MCP server registration globally:', error);
      throw error;
    }
  }

  isMcpServerRegistered(global: boolean = false): boolean {
    if (global) {
      return this.isRegisteredGlobally();
    } else {
      return this.isRegisteredInWorkspace();
    }
  }

  private isRegisteredInWorkspace(): boolean {
    const currentWorkspaceRoot = this.getCurrentWorkspaceRoot();
    if (!currentWorkspaceRoot) {
      return false;
    }

    try {
      const mcpConfigPath = path.join(currentWorkspaceRoot, McpConfigManager.MCP_CONFIG_FILE);
      
      if (!fs.existsSync(mcpConfigPath)) {
        return false;
      }

      const configContent = fs.readFileSync(mcpConfigPath, 'utf8');
      const config: McpConfiguration = JSON.parse(configContent);

      return !!config.servers[McpConfigManager.SERVER_NAME];
    } catch (error) {
      console.error('Failed to check MCP server registration in workspace:', error);
      return false;
    }
  }

  private isRegisteredGlobally(): boolean {
    try {
      // Explicitly check ONLY global configuration, not workspace-merged config
      const config = vscode.workspace.getConfiguration();
      const globalServers = config.inspect<Record<string, McpServerConfig>>(McpConfigManager.GLOBAL_CONFIG_KEY);
      
      // Only check the globalValue, not the merged value
      const mcpServers = globalServers?.globalValue || {};
      return !!mcpServers[McpConfigManager.SERVER_NAME];
    } catch (error) {
      console.error('Failed to check global MCP server registration:', error);
      return false;
    }
  }

  hasWorkspace(): boolean {
    // Check current workspace state dynamically
    return !!vscode.workspace.workspaceFolders?.[0];
  }

  private getCurrentWorkspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }
}