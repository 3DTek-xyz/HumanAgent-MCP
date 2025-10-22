# humanagent-mcp README

This is the README for your extension "humanagent-mcp". After writing up a brief description, we recommend including the following sections.

## Features

Describe specific features of your extension including screenshots of your extension in action. Image paths are relative to this README file.

# HumanAgent MCP - VS Code Extension

A VS Code extension that implements an MCP (Model Context Protocol) server for chatting with human agents. This extension provides a dockable chat interface that enables real-time communication between users and human agents through the MCP protocol.

## Features

- **MCP Server Integration**: Built-in MCP server that handles human agent communication
- **Dockable Chat Interface**: Fully integrated chat UI within VS Code
- **Session Management**: Create and manage multiple chat sessions
- **Real-time Messaging**: Instant message delivery and responses
- **Cross-platform Support**: Works on Windows, macOS, and Linux
- **Tree View Integration**: Browse and manage chat sessions in the Explorer panel

### Key Components

- **Chat Sessions Tree View**: View and manage all your chat sessions in the Explorer
- **Dockable Chat Panel**: Main chat interface that can be docked anywhere in VS Code
- **MCP Protocol Compliance**: Full implementation of MCP for human agent communication

## Installation

1. **From Source**: Clone this repository and install dependencies:
   ```bash
   git clone https://github.com/your-username/humanagent-mcp.git
   cd humanagent-mcp
   npm install
   npm run compile
   ```

2. **Development**: Press `F5` to launch the Extension Development Host

3. **Package for Distribution**:
   ```bash
   npm install -g vsce
   vsce package
   ```

## Usage

### Creating a Chat Session

1. Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run "Create New Chat Session"
3. Enter a name for your session
4. The session will appear in the Chat Sessions tree view

### Starting a Conversation

1. Click on a session in the Chat Sessions tree view to open it
2. Use the chat interface in the panel to send messages
3. Human agents will receive and respond to your messages in real-time

### Managing Sessions

- **Refresh**: Click the refresh button in the Chat Sessions view
- **Create New**: Use the "+" button or command palette
- **View Status**: Check MCP server status via command palette

## Commands

- `humanagent-mcp.createSession`: Create a new chat session
- `humanagent-mcp.refreshSessions`: Refresh the sessions list
- `humanagent-mcp.showStatus`: Display MCP server status
- `humanagent-mcp.openChat`: Open a specific chat session

## Project Structure

```
src/
├── extension.ts              # Main extension entry point
├── mcp/
│   ├── server.ts            # MCP server implementation
│   └── types.ts             # Type definitions
├── providers/
│   └── chatTreeProvider.ts  # Tree view for chat sessions
└── webview/
    └── chatWebviewProvider.ts # Chat interface implementation
```

## Development

### Prerequisites

- Node.js 18+
- VS Code 1.105.0+
- TypeScript 5.9+

### Building

```bash
npm install
npm run compile    # Build once
npm run watch      # Build and watch for changes
```

### Testing

```bash
npm test           # Run tests
```

### Packaging

```bash
npm run package    # Create production build
vsce package       # Create .vsix file
```

## MCP Protocol Support

This extension implements the following MCP capabilities:

- **Chat Methods**:
  - `chat/send`: Send messages to human agents
  - `chat/list-sessions`: List all chat sessions
  - `chat/create-session`: Create new chat sessions

- **Protocol Features**:
  - Full MCP 2024-11-05 protocol compliance
  - Session management
  - Real-time message handling
  - Error handling and recovery

## Configuration

Currently, no additional configuration is required. The extension works out of the box with default settings.

## Known Issues

- Human agent responses are currently simulated (for demo purposes)
- Session persistence is in-memory only (sessions are lost on restart)

## Roadmap

- [ ] Persistent session storage
- [ ] Real human agent integration
- [ ] Message history export
- [ ] Custom themes for chat interface
- [ ] File sharing capabilities
- [ ] Group chat sessions

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

For support, please open an issue on GitHub or contact the development team.

---

**Built with ❤️ for the VS Code community**

> Tip: Many popular extensions utilize animations. This is an excellent way to show off your extension! We recommend short, focused animations that are easy to follow.

## Requirements

If you have any requirements or dependencies, add a section describing those and how to install and configure them.

## Extension Settings

Include if your extension adds any VS Code settings through the `contributes.configuration` extension point.

For example:

This extension contributes the following settings:

* `myExtension.enable`: Enable/disable this extension.
* `myExtension.thing`: Set to `blah` to do something.

## Known Issues

Calling out known issues can help limit users opening duplicate issues against your extension.

## Release Notes

Users appreciate release notes as you update your extension.

### 1.0.0

Initial release of ...

### 1.0.1

Fixed issue #.

### 1.1.0

Added features X, Y, and Z.

---

## Following extension guidelines

Ensure that you've read through the extensions guidelines and follow the best practices for creating your extension.

* [Extension Guidelines](https://code.visualstudio.com/api/references/extension-guidelines)

## Working with Markdown

You can author your README using Visual Studio Code. Here are some useful editor keyboard shortcuts:

* Split the editor (`Cmd+\` on macOS or `Ctrl+\` on Windows and Linux).
* Toggle preview (`Shift+Cmd+V` on macOS or `Shift+Ctrl+V` on Windows and Linux).
* Press `Ctrl+Space` (Windows, Linux, macOS) to see a list of Markdown snippets.

## For more information

* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)
* [Markdown Syntax Reference](https://help.github.com/articles/markdown-basics/)

**Enjoy!**
