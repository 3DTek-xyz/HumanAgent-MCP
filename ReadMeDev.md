# HumanAgent MCP - Developer Documentation

Technical documentation for developers working on or extending the HumanAgent MCP extension.

## Architecture

### Core Components

**Extension Entry Point** (`src/extension.ts`)
- VS Code extension activation and lifecycle
- MCP server definition provider for VS Code native integration
- Session management and workspace detection
- Command registration and event handling

**MCP Server** (`src/mcp/server.ts`)
- HTTP server on port 3737 serving MCP protocol
- Tool definitions and execution (HumanAgent_Chat)
- Session-specific tool overrides
- SSE connections for real-time updates
- Web interface generation

**Chat Manager** (`src/mcp/chatManager.ts`)
- Centralized message and session storage
- Request/response correlation
- Session cleanup and memory management

**Webview Provider** (`src/webview/chatWebviewProvider.ts`)
- VS Code webview integration
- Chat interface UI and messaging
- Server configuration and status monitoring

**Configuration Manager** (`src/mcp/mcpConfigManager.ts`)
- MCP server registration (workspace/global)
- Configuration file management (.vscode/mcp.json)

### Data Flow

```
AI Client -> MCP Server (port 3737) -> ChatManager -> Webview Provider -> VS Code UI
                                   -> SSE Client    -> Web Interface
```

## Key Features Implementation

### Session Management

Each workspace gets a unique session ID based on workspace path hash. Session data includes:
- Chat message history (managed by ChatManager)
- Pending requests awaiting human response
- Tool overrides loaded from `.vscode/override-prompt.md`
- Workspace-specific configuration

### Tool Override System

1. Default `HumanAgent_Chat` tool defined in `server.ts`
2. Per-workspace overrides loaded from `.vscode/override-prompt.md`
3. Markdown parsed to extract tool description and schema modifications
4. Session-specific tool maps maintain overrides per workspace

### Real-time Communication

- **MCP Protocol**: Standard JSON-RPC over HTTP for AI client communication
- **SSE (Server-Sent Events)**: Real-time updates to webview and web interface
- **VS Code Events**: Native VS Code messaging for webview updates

## Development Setup

### Prerequisites

- Node.js 18+
- VS Code 1.105.0+
- TypeScript knowledge

### Build Process

```bash
# Install dependencies
npm install

# Development build with watch
npm run watch

# Production build
npm run package

# Compile extension only
npm run compile
```

### Project Structure

```
src/
├── extension.ts              # Extension entry point
├── mcp/
│   ├── server.ts            # MCP server implementation  
│   ├── chatManager.ts       # Session and message management
│   ├── mcpConfigManager.ts  # Configuration handling
│   ├── types.ts             # TypeScript interfaces
│   └── mcpStandalone.ts     # Standalone server entry
├── webview/
│   └── chatWebviewProvider.ts # VS Code webview integration
├── providers/
│   └── chatTreeProvider.ts   # Explorer tree view
├── audio/
│   └── audioNotification.ts  # Sound notifications
└── serverManager.ts          # Server lifecycle management
```

### Key Classes

**McpServer**
- Main server class implementing MCP protocol
- Tool registration and execution
- HTTP request handling and routing
- SSE connection management

**ChatManager** 
- Message storage and retrieval
- Pending request tracking
- Session lifecycle management
- Memory cleanup and limits

**ChatWebviewProvider**
- VS Code webview implementation
- Chat UI rendering and interaction
- Server status monitoring
- Configuration management

## Configuration Files

### Extension Manifest (`package.json`)

Key sections:
- `contributes.commands` - VS Code commands
- `contributes.views` - Panel and tree view definitions  
- `contributes.configuration` - User settings schema
- `contributes.mcpServerDefinitionProviders` - VS Code MCP integration

### Workspace Configuration (`.vscode/mcp.json`)

Generated automatically when registering workspace MCP server:

```json
{
  "servers": {
    "humanagent-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:3737/mcp?sessionId=session-xxx",
      "notifications": {
        "enableSound": true,
        "enableFlashing": true
      }
    }
  }
}
```

### Tool Override (`.vscode/override-prompt.md`)

Markdown file for customizing tool behavior per workspace. Parsed sections:
- Description becomes tool description
- Properties section modifies input schema
- Additional context included in tool execution

## API Endpoints

The MCP server exposes both MCP protocol and web endpoints:

### MCP Protocol (`/mcp`)

Standard MCP JSON-RPC methods:
- `initialize` - Client initialization
- `tools/list` - Available tools query
- `tools/call` - Tool execution (HumanAgent_Chat)

### Web Endpoints

- `GET /` - Web chat interface
- `GET /sessions` - Session list API
- `POST /send-message` - Web message sending
- `GET /sse/{sessionId}` - Server-sent events connection

## Testing

### Extension Testing

```bash
# Run in extension development host
# Press F5 in VS Code to launch debug instance
```

### MCP Server Testing

```bash
# Test server independently
node dist/mcpStandalone.js
curl http://127.0.0.1:3737/sessions
```

### Integration Testing

Test AI client integration by configuring Claude/Cursor with:
```
http://127.0.0.1:3737/mcp?sessionId=test-session
```

## Logging and Debugging

### Extension Logs

Enable debug logging via settings:
- `humanagent-mcp.logging.enabled` = true  
- `humanagent-mcp.logging.level` = "DEBUG"

Logs written to `.vscode/HumanAgent-server.log` in workspace.

### VS Code Debug Console

View extension debug output:
1. Help > Toggle Developer Tools
2. Console tab shows extension logs

### Server Debug Mode

Environment variables for standalone server:
```bash
HUMANAGENT_LOGGING_ENABLED=true
HUMANAGENT_LOGGING_LEVEL=DEBUG
node dist/mcpStandalone.js
```

## Extension Points

### Adding New Tools

1. Define tool in `initializeDefaultTools()` method
2. Add handler in `handleToolCall()` method
3. Update tool override parsing if needed

### Custom Notification Types

1. Add new SSE message types in `sendMcpNotification()`
2. Handle in webview JavaScript
3. Update UI accordingly

### Additional Configuration

1. Add to `package.json` contributes.configuration
2. Read settings in extension code
3. Pass to server during initialization

## Common Patterns

### Async Request Handling

```typescript
// Store request resolver
this.requestResolvers.set(requestId, {
  resolve: (response: string) => {
    // Handle response
  },
  reject: (error: Error) => {
    // Handle error  
  }
});

// Set timeout if needed
if (timeoutMs) {
  setTimeout(() => {
    // Timeout logic
  }, timeoutMs);
}
```

### Session-Specific Operations

```typescript
// Get session tools
const sessionTools = this.sessionTools.get(sessionId) || this.tools;

// Store session data
this.sessionData.set(sessionId, data);

// Clean up session
this.activeSessions.delete(sessionId);
```

### Webview Communication

```typescript
// Send to webview
this._view.webview.postMessage({
  type: 'messageType',
  data: payload
});

// Handle webview messages
webview.onDidReceiveMessage(message => {
  switch (message.type) {
    case 'actionType':
      // Handle action
      break;
  }
});
```

## Build and Packaging

### Development Build

```bash
npm run compile
```

### Production Package

```bash
npm run package
```

This creates `dist/extension.js` and `dist/mcpStandalone.js` for distribution.

### Extension Packaging

```bash
vsce package
```

Creates `.vsix` file for manual installation or marketplace publishing.