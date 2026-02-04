# HumanAgent MCP Developer Guide

## Architecture Overview

VS Code extension that runs an HTTP MCP server on port 3737. The server handles three distinct endpoints to avoid connection conflicts:

- `/mcp` - Server-Sent Events for VS Code webview
- `/mcp-tools` - MCP protocol for VS Code extension registration  
- `/HumanAgent` - Web interface for browser access

## Core Components

**Extension Entry Point** (`src/extension.ts`)
- Implements `McpServerDefinitionProvider` for VS Code integration
- Manages workspace-specific session IDs using MD5 hash
- Handles version-based cache invalidation for tool updates

**MCP Server** (`src/mcp/server.ts`)  
- HTTP server handling MCP protocol and chat interfaces
- Session-based tool override system
- Real-time message broadcasting via SSE

**Chat Management** (`src/mcp/chatManager.ts`)
- Centralized message storage and session handling
- Pending request tracking for AI-human interactions

**Webview Provider** (`src/webview/chatWebviewProvider.ts`)
- VS Code panel integration with SSE connection
- Cog menu for session management and configuration

## Session System

Sessions are tied to VS Code workspaces:
- Session ID: `session-{uuid}` stored in VS Code global state
- Workspace mapping: MD5 hash of workspace path
- Tool overrides: Per-session tool configurations from `.vscode/HumanAgentOverride.json`

## Tool Override Implementation

1. Extension checks for override file on startup
2. Loads JSON configuration and registers session tools
3. Server maintains `sessionTools` Map for per-session customization
4. Version changes in `McpHttpServerDefinition` force VS Code cache refresh

Override file supports:
- Tool description and schema customization
- Message auto-appending (global and tool-specific)
- Session-specific configurations

## Key API Endpoints

```
GET  /sessions                    - List active sessions
POST /sessions/register           - Register session with overrides  
GET  /tools?sessionId=<id>        - Get tools for specific session
GET  /debug/tools?sessionId=<id>  - Debug tool inspection
POST /response                    - Submit human responses
```

## Development Workflow

**Build**: `npm run compile`
**Debug**: F5 launches extension development host
**Logs**: Check `HumanAgent-server.log` in system temp directory

## Connection Architecture

The three-endpoint design prevents SSE conflicts:

- VS Code webview connects to `/mcp` for real-time updates
- VS Code extension uses `/mcp-tools` for MCP protocol communication
- Browser clients access `/HumanAgent` for web interface

Each endpoint handles its specific protocol without interference.

## Message Flow

1. AI assistant calls `HumanAgent_Chat` tool via MCP
2. Server creates pending request and broadcasts to human interfaces
3. Human responds through webview or browser
4. Server resolves pending request and returns response to AI
5. Chat history persisted in ChatManager
