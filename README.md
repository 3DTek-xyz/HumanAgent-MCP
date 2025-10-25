# HumanAgent MCP - VS Code Extension

# HumanAgent MCP

A VS Code extension that enables AI agents to communicate directly with developers through an integrated chat interface. Built on the Model Context Protocol (MCP) standard.

## What it does

When AI assistants like Claude or Cursor need clarification, approval, or input from you, they can use the HumanAgent_Chat tool to send messages directly to your VS Code interface. You see their questions in real-time and can respond immediately, creating a seamless collaborative workflow.

## Installation

1. Open VS Code
2. Install the HumanAgent MCP extension from the marketplace
3. The extension automatically starts an MCP server on port 3737
4. Configure your AI assistant to use the MCP server at `http://127.0.0.1:3737/mcp`

## Usage

### VS Code Interface

After installation, you'll see:
- **Chat Sessions** view in the Explorer panel showing active conversations
- **HumanAgent Chat** panel (dockable) for the main chat interface
- Audio notifications when new messages arrive (configurable)

### Basic Workflow

1. AI assistant calls the `HumanAgent_Chat` tool when it needs human input
2. Message appears in your VS Code chat interface with optional sound notification
3. You respond through the chat interface
4. AI assistant receives your response and continues working

### Commands

- **Create New Chat Session** - Start a fresh conversation
- **Configure MCP Server** - Set up workspace or global MCP registration
- **Show Status** - View server status and active sessions

## Configuration

### MCP Server Registration

The extension can register the MCP server in two ways:

**Workspace Registration** (Recommended)
- Creates `.vscode/mcp.json` in your current workspace
- Server only available to this workspace
- Automatic session management per workspace

**Global Registration**
- Registers in VS Code's global MCP settings  
- Available to all workspaces
- Manual session management

### Settings

Access via VS Code Settings (search for "HumanAgent"):

- `humanagent-mcp.logging.enabled` - Enable debug logging to `.vscode` directory (default: false)
- `humanagent-mcp.logging.level` - Log level: ERROR, WARN, INFO, DEBUG (default: INFO)

### Tool Customization

Create `.vscode/override-prompt.md` in your workspace to customize how the AI tool behaves:

```markdown
# Custom HumanAgent_Chat Tool

## Description
Your custom description here

## Properties
- message: Custom message field description
- timeout: Response timeout in seconds (optional)
```

## Web Interface

Access the web interface at `http://127.0.0.1:3737/` to:
- View chat sessions from any browser
- Send messages from outside VS Code  
- Monitor active conversations

## Requirements

- VS Code 1.105.0 or higher
- Network access to localhost port 3737
- AI assistant configured to use MCP (Claude, Cursor, etc.)

## Troubleshooting

**Extension not starting**
- Check VS Code Developer Console for errors
- Verify port 3737 is not in use by another application

**AI can't connect**  
- Ensure MCP server is registered (use Configure MCP Server command)
- Check the server URL includes your session ID: `http://127.0.0.1:3737/mcp?sessionId=your-session-id`

**No audio notifications**
- Check VS Code notification settings
- Test notifications using the Configure panel

**Messages not appearing**
- Refresh the Chat Sessions view
- Check server status in the HumanAgent Chat panel

## License

MIT License

## Features

- ** AI-to-Human Communication**: AI agents can send messages and questions directly to developers
- ** VS Code Chat Interface**: Dockable chat panel integrated into VS Code
- ** Session Management**: Each workspace gets its own communication session  
- ** Workspace Tool Overrides**: Customize MCP tool behavior per workspace
- ** Audio Notifications**: Optional sound alerts for new AI messages
- ** Status Monitoring**: Track server status and pending requests
- ** HTTP + Stdio Support**: Compatible with various MCP clients

## Installation

### VS Code Marketplace (Recommended)

1. Open VS Code
2. Go to Extensions (`Ctrl+Shift+X` or `Cmd+Shift+X`)
3. Search for "HumanAgent MCP"  
4. Click **Install**
5. The extension will auto-configure and start working

### Manual Installation

Download the `.vsix` file from releases and install:
```bash
code --install-extension humanagent-mcp-*.vsix
```

## Quick Start

1. **Install the extension** in VS Code
2. **Open any workspace** - the extension auto-starts
3. **Open the HumanAgent Chat** panel (View → HumanAgent MCP Chat)
4. **AI agents can immediately send messages** that appear in your chat interface

The extension automatically:
- ✅ Configures MCP server settings  
- ✅ Starts HTTP server on port 3737
- ✅ Registers with VS Code's MCP system
- ✅ Creates workspace-specific session

## How It Works

The extension automatically:
- ✅ Starts an MCP server on `http://127.0.0.1:3737/mcp`
- ✅ Configures itself within VS Code's extension system  
- ✅ Provides the `HumanAgent_Chat` tool for AI agents
- ✅ Creates a chat interface for receiving AI messages

**For AI agents:** Use the MCP tool `HumanAgent_Chat` to send messages to the human developer. Messages appear instantly in the VS Code chat panel.

## Tool Customization

Create a `.vscode/HumanAgentOverride.json` file in your workspace to customize tool behavior:

```json
{
  "version": "1.0.0",
  "description": "Custom HumanAgent tools for this workspace",
  "tools": {
    "HumanAgent_Chat": {
      "name": "HumanAgent_Chat",
      "description": "Custom description for this workspace's chat tool",
      "inputSchema": {
        "type": "object",
        "properties": {
          "message": {
            "type": "string",
            "description": "The message to send"
          },
          "context": {
            "type": "string", 
            "description": "Optional context"
          },
          "priority": {
            "type": "string",
            "enum": ["low", "normal", "high", "urgent"],
            "default": "normal"
          }
        },
        "required": ["message"]
      }
    }
  }
}
```

Use the **🔄 Reload Override File** option in the chat panel's cog menu to apply changes.

## Available Commands

- **Create Session**: Initialize a new chat session
- **Show Status**: Display server status and statistics
- **Configure MCP**: Set up MCP server registration
- **Override Prompt**: Create workspace-specific tool configurations

## Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   MCP Client    │    │  HumanAgent MCP  │    │   VS Code UI    │
│ (Claude/Cursor) │◄──►│     Server       │◄──►│  Chat Interface │
│                 │    │  (Port 3737)     │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

## Development

### Development Installation

```bash
git clone <repository-url>
cd humanagent-mcp
npm install
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host.

### Project Structure
```
src/
├── extension.ts              # VS Code extension entry point
├── mcp/
│   ├── server.ts            # MCP HTTP server implementation
│   ├── mcpStandalone.js     # Standalone server runner
│   └── types.ts             # TypeScript definitions
├── webview/
│   └── chatWebviewProvider.ts # Chat UI implementation
└── providers/
    └── chatTreeProvider.ts   # Session tree view
```

### Build Commands
```bash
npm run compile    # TypeScript compilation
npm run watch      # Watch mode for development
npm run package    # Production build
```

### Testing
```bash
# Test MCP server directly
curl -X POST http://localhost:3737/mcp \
  -H "Content-Type: application/json" \
  -d '{"id":"test","type":"request","method":"tools/list"}'
```

## Logging

- **Development**: Logs appear in VS Code Developer Console
- **Production**: Logs saved to `.vscode/HumanAgent.log` in each workspace
- **Standalone**: Logs saved to system temp directory

## Technical Details

### MCP Protocol Support
- **Protocol Version**: 2024-11-05
- **Transport**: HTTP (primary), Stdio (compatibility)
- **Tools**: `HumanAgent_Chat` with workspace customization
- **Session Management**: Isolated per workspace

### Security Considerations
- HTTP server binds to localhost only (127.0.0.1)
- No external network access required
- Workspace-specific tool isolation

## Limitations

- Requires VS Code to be running for AI communication
- HTTP server uses fixed port 3737 (configurable in code)
- Tool overrides require manual reload after changes

## Troubleshooting

**Server not starting?**
- Check port 3737 is available: `lsof -i :3737`
- Verify workspace has write permissions for `.vscode/` directory

**AI messages not appearing?**
- Confirm MCP client is connected to `http://127.0.0.1:3737/mcp`
- Check HumanAgent Chat panel is open in VS Code
- Review logs in `.vscode/HumanAgent.log`

**Override file not working?**
- Validate JSON syntax in HumanAgentOverride.json
- Use "🔄 Reload Override File" to apply changes
- Check Developer Console for error messages

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

---

**Built for seamless AI-human collaboration in VS Code** 🚀