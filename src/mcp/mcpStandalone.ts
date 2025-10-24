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
    this.server = new McpServer(undefined, workspacePath);
    this.setupProcessHandlers();
  }

  private setupProcessHandlers(): void {
    // Handle STDIO communication for MCP protocol
    process.stdin.on('data', async (data) => {
      try {
        const input = data.toString().trim();
        if (!input) {
          return;
        }

        const message = JSON.parse(input);
        const response = await this.server.handleMessage(message);
        
        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      } catch (error) {
        const errorResponse = {
          id: null,
          type: 'response',
          error: {
            code: -32700,
            message: 'Parse error',
            data: error instanceof Error ? error.message : String(error)
          }
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    });

    // Handle server events and forward them as notifications
    this.server.on('session-created', (session) => {
      const notification = {
        type: 'notification',
        method: 'session/created',
        params: { session }
      };
      process.stdout.write(JSON.stringify(notification) + '\n');
    });

    this.server.on('message-received', (data) => {
      const notification = {
        type: 'notification',
        method: 'message/received',
        params: data
      };
      process.stdout.write(JSON.stringify(notification) + '\n');
    });

    this.server.on('message-sent', (data) => {
      const notification = {
        type: 'notification',
        method: 'message/sent',
        params: data
      };
      process.stdout.write(JSON.stringify(notification) + '\n');
    });

    this.server.on('awaiting-human-response', (data) => {
      const notification = {
        type: 'notification',
        method: 'human/awaiting-response',
        params: data
      };
      process.stdout.write(JSON.stringify(notification) + '\n');
    });

    // Graceful shutdown handlers removed - server should remain independent
    // and only shut down when explicitly requested via API endpoints
    // process.on('SIGINT', () => this.shutdown());
    // process.on('SIGTERM', () => this.shutdown());
    // process.on('exit', () => this.shutdown());
  }

  async start(): Promise<void> {
    try {
      await this.server.start();
      
      // Send initialization notification
      const initNotification = {
        type: 'notification',
        method: 'server/started',
        params: {
          name: 'HumanAgent MCP Server',
          version: '1.0.0',
          capabilities: {
            chat: true,
            tools: true,
            resources: false
          }
        }
      };
      process.stdout.write(JSON.stringify(initNotification) + '\n');
      
      console.error('HumanAgent MCP Server started successfully'); // Use stderr for logging
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