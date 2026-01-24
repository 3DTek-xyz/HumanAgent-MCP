# HumanAgent MCP

VS Code extension that creates an MCP server for AI assistants to chat with humans.

## Demo

![HumanAgent MCP Extension Demo](high-res-demo.gif)

_Complete demonstration of the HumanAgent MCP extension in action - showing real-time human-AI collaboration_

## What it does

This extension provides a `HumanAgent_Chat` MCP tool that forces AI assistants to communicate through a human agent instead of giving direct responses. When an AI uses this tool, it opens a chat session where humans can respond in real-time.

## Why

The AI Agent is encouraged to discuss with you before running off to do its own thing - if its part way through iterating through on a problem it can stop and ask you a question - it reduces requests considerably, helps avoid runaway agent, allows you to manage multiple VSCode agents working in multiple workspaces from one web page. Allows you to append useful reminders to each response.

## How it works

- Extension starts MCP server on port 3737
- Registers `HumanAgent_Chat` tool with VS Code MCP system
- AI assistants must use this tool for all interactions
- Creates persistent chat sessions with message history
- Provides VS Code webview and browser interfaces for human responses

### Server Lifecycle

- The server stops automatically when VS Code closes (so the port doesn’t remain occupied).
- Reloading the VS Code window restarts the server automatically.
- The standalone server is launched from VS Code `globalStorage` to avoid extension-update file locks.

## Installation and Setup

1. Install the extension in VS Code
2. Extension activates automatically on startup
3. MCP server starts and registers with VS Code
4. Tool becomes available to AI assistants immediately

## Chat Interfaces

**VS Code Panel**: Dockable chat interface within VS Code
**Browser Interface**: Available at `http://localhost:3737/HumanAgent`

Both interfaces show the same chat sessions and message history.

## Tool Customization

Create `.vscode/HumanAgentOverride.json` to customize tool descriptions and message behavior:
THIS IS SUPER HELPFUL - NOTE THE LAST PART WHERE YOU CAN APEND A MESSAGE TO THE END OF EVERY REPLY!

```json
{
  "version": "1.0.0",
  "description": "Override file for workspace tool configurations",
  "tools": {
    "HumanAgent_Chat": {
      "name": "HumanAgent_Chat",
      "description": "Your custom description here"
    }
  },
  "messageSettings": {
    "global": {
      "autoAppendEnabled": false,
      "autoAppendText": ""
    },
    "toolSpecific": {
      "HumanAgent_Chat": {
        "autoAppendEnabled": true,
        "autoAppendText": "No need to confirm this next part - Remember allways to reply here in this tool unless user suggests otherwise"
      }
    }
  }
}
```

Changes require VS Code restart to take effect.

## Requirements

VS Code version 1.105.0 or higher with native MCP support.
