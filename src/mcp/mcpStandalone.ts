#!/usr/bin/env node

/**
 * Standalone MCP Server Entry Point
 * This script runs the HumanAgent MCP server as a standalone process
 * that can be connected to by VS Code's MCP client
 */

import { McpServer } from './server';

class StandaloneMcpServer {
  private server: McpServer;

  constructor() {
    // Use the parent directory of the dist folder as workspace path
    // This ensures log file is created where it can be properly cleared
    const workspacePath = require('path').resolve(__dirname, '..');
    // Get port from environment variable (set by ServerManager)
    const port = process.env.HUMANAGENT_MCP_PORT ? parseInt(process.env.HUMANAGENT_MCP_PORT) : undefined;
    this.server = new McpServer(undefined, workspacePath, port);
  }

  async start(): Promise<void> {
    try {
      await this.server.start();
      console.error('HumanAgent MCP Server started successfully (HTTP-only)'); // Use stderr for logging
    } catch (error) {
      console.error('Failed to start HumanAgent MCP Server:', error);
      process.exit(1);
    }
  }

  private async shutdown(): Promise<void> {
    try {
      await this.server.stop();
      console.error('HumanAgent MCP Server stopped');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  }
}

// Start the standalone server
const standaloneServer = new StandaloneMcpServer();
standaloneServer.start().catch((error) => {
  console.error('Failed to start standalone MCP server:', error);
  process.exit(1);
});