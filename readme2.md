# HumanAgent MCP - Complete Guide

**Force GitHub Copilot to chat with you before acting.** Stop runaway AI agents, reduce wasted API calls, and manage multiple workspaces from one interface.

---

## Table of Contents
- [Quick Start](#quick-start)
- [Basic Usage](#basic-usage)
- [Interfaces](#interfaces)
- [Customization](#customization)
- [Proxy Mode](#proxy-mode)
- [Troubleshooting](#troubleshooting)
- [Technical Details](#technical-details)
- [Privacy & Telemetry](#privacy--telemetry)

---

## Quick Start

### Installation
1. Install from VS Code Marketplace
2. Extension auto-activates and registers `HumanAgent_Chat` tool
3. **Recommended**: Create Override File (Cog menu → Create Override File)
   - Adds `.vscode/HumanAgentOverride.json` with VERY useful customizations including reminder for AI to allways use the tool which is what saves you hundreds of premium requests

### Requirements
- VS Code 1.105.0 or higher (native MCP support)
- Port 3737 must be available

---

## Basic Usage

### Workflow
1. **Prompt Copilot as usual** in the standard copilot chat box with something like: "Use HumanAgent_Chat to discuss with me"
2. **Chat Panel Opens** - Green dot = connected, message appears
3. **Respond in the new Human Agent MCP Chat Box** - Type or use Quick Replies ("Yes Please Proceed", etc.)
4. **Copilot Continues** - Receives your response and proceeds

### Why Use This?
- **Prevent runaway agents** - AI asks before acting
- **Reduce API waste** - Clarify requirements upfront
- **Multi-workspace management** - Handle multiple projects from browser
- **Add reminders** - Append notes to responses automatically

---

## Interfaces

### VS Code Panel (Sidebar)

**Status Indicators:**
- 🟢 Green dot = Server running and connected
- 🟠 Orange dot = Starting up / Proxy disabled
- 🔴 Red dot = Stopped or disconnected

**Features:**
- Quick Replies - Pre-configured common responses
- Message history - Persistent chat sessions
- Session naming - Organize conversations
- Always-on text input - Send button activates when AI is waiting

**Cog Menu (⚙️):**
| Command | Description |
|---------|-------------|
| Show Status | Check server connection state |
| Start/Stop/Restart Server | Manage server lifecycle |
| Enable/Disable Proxy | Toggle traffic capture mode |
| Install Proxy Certificate | Required for HTTPS proxy |
| Uninstall Proxy Certificate | Remove cert and disable proxy |
| Create Override File | Generate `.vscode/HumanAgentOverride.json` |
| Name This Chat | Set custom session identifier |
| Open Web View | Launch browser interface |
| Help & Documentation | Open README |
| Report Issue / Request Feature | GitHub links |

### Web Interface

Access at `http://localhost:3737/HumanAgent` (Cog menu → Open Web View)

**Features:**
- View all workspace conversations in one place
- Switch between multiple workspaces
- Append custom reminders to responses
- Same message history as VS Code panel

---

## Customization

### Override File

Create `.vscode/HumanAgentOverride.json` to customize behavior:

```json
{
  "version": "1.0.0",
  "description": "HumanAgent MCP Tool Overrides for this workspace",
  "tools": {
    "HumanAgent_Chat": {
      "name": "HumanAgent_Chat",
      "description": "**MANDATORY TOOL** - Custom instructions here"
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
        "autoAppendText": "Remember to always reply using this tool unless told otherwise"
      }
    }
  },
  "quickReplies": {
    "enabled": true,
    "options": [
      "Yes Please Proceed",
      "Explain in more detail please",
      "Can you provide an example?",
      "That looks good to me",
      "Please make those changes"
    ]
  }
}
```

**Key Features:**
- **Custom tool descriptions** - Modify AI behavior instructions
- **Auto-append text** - Add reminders to every response (forces AI to use tool)
- **Quick replies** - Customize pre-configured response buttons
- **Workspace-specific** - Different configs per project

**Note:** Changes require VS Code restart to take effect.

---

## Proxy Mode

**Advanced Feature:** Capture and inspect HTTP/HTTPS traffic from VS Code

### Setup
1. **Install Certificate** - Cog menu → Install Proxy Certificate (follow system prompts)
2. **Enable Proxy** - Cog menu → Enable Proxy
3. **View Traffic** - Open Web Interface → "Proxy Logs" tab

### Features
- Capture VS Code extension traffic, marketplace requests, API calls
- Inspect full request/response details (headers, body, timing)
- Create transformation rules using JSONata
- Debug extension behavior and network issues

### Proxy Rules
Control traffic with custom rules:
- **Redirect** - Send requests to different URLs
- **Transform** - Modify request/response data using JSONata
- **Block** - Stop specific requests
- **Mock** - Return fake responses

**Management:**
- Create rules from "Proxy Rules" tab
- Or click captured request → "Create Rule" for dynamic builder
- See [Proxy-Rules.md](Proxy-Rules.md) for detailed documentation

### Status Indicators
- 🟢 "Proxy (Enabled)" = Running AND enabled in VS Code
- 🟠 "Proxy (Disabled)" = Running but NOT enabled
- 🔴 "Proxy (Stopped)" = Not running

**Important:**
- Certificate MUST be installed BEFORE enabling proxy
- Affects ALL VS Code workspaces when enabled
- Certificate must be trusted in system keychain (macOS: System Keychain)
- Disable when not needed: Cog menu → Disable Proxy

---

## Troubleshooting

### Red Dot / Disconnected
- Cog menu → Start Server
- Check VS Code Output panel for errors
- Restart VS Code
- Verify port 3737 not in use: `lsof -i :3737`

### Server Won't Start
- Check port availability: `lsof -i :3737`
- Kill conflicting process: `kill -9 <PID>`
- Try manual restart from Cog menu
- Check VS Code version (need 1.105.0+)

### Copilot Not Using Tool
- Tool registers automatically on startup
- Explicitly request: "Use HumanAgent_Chat to discuss this with me"
- Try restarting server from Cog menu
- Check for override file conflicts

### Proxy Issues

**Proxy Not Capturing Traffic:**
- Must install certificate first (Cog menu → Install Proxy Certificate)
- Then enable proxy (Cog menu → Enable Proxy)
- Check status shows "Proxy (Enabled)" with green dot

**Certificate Not Trusted:**
- macOS: Open Keychain Access → System → Find "HumanAgent Proxy CA"
- Set to "Always Trust" for SSL
- Windows: Certificate should auto-install to Trusted Root

**Proxy Shows "Disabled" (Orange):**
- Server running but not enabled in VS Code settings
- Use Cog menu → Enable Proxy (don't manually edit settings)

---

## Technical Details

### Architecture
- **MCP Server** - Runs on port 3737 (dev: 3738)
- **Tool Registration** - Auto-registers with VS Code MCP system
- **Chat Sessions** - Persistent message history per workspace
- **WebSocket** - Real-time communication between interfaces
- **Proxy Server** - Optional MITM proxy for traffic inspection

### How It Works
1. Extension starts MCP server on activation
2. Registers `HumanAgent_Chat` tool with VS Code
3. AI assistants call tool with message parameter
4. Chat session opens in VS Code panel + web interface
5. Human responds, message sent back to AI
6. AI receives response and continues task

### Development
- Press F5 to debug in extension host
- Dev mode uses port 3738 (no conflict with production)
- TypeScript source in `src/`
- Webpack bundling for distribution

### File Structure
```
.vscode/HumanAgentOverride.json  # Workspace-specific config (optional)
src/
  extension.ts                    # Extension entry point
  serverManager.ts                # MCP server lifecycle
  mcp/
    server.ts                     # MCP server implementation
    chatManager.ts                # Session management
    proxyServer.ts                # Traffic capture server
  webview/
    chatWebviewProvider.ts        # VS Code panel UI
  providers/
    chatTreeProvider.ts           # Chat list provider
```

---

## Privacy & Telemetry

### What We Collect (Anonymous)
- ✅ Extension activation/deactivation events
- ✅ Feature usage (chat opened, messages sent count)
- ✅ Error types (not content)
- ✅ Session metrics (counts only)
- ✅ VS Code version, OS platform
- ✅ Days since installation

### What We DON'T Collect
- ❌ Your message content
- ❌ Name, email, or personal data
- ❌ Workspace paths or file names
- ❌ Any identifiable information

### Your Control
- Respects VS Code telemetry setting
- Disable: Settings → Telemetry → Level → Off
- Fully GDPR compliant
- Uses Google Analytics 4 (anonymous)

### Why Telemetry?
- Identify which features are used
- Track bugs and errors to fix
- Measure engagement patterns
- Guide future development

---

## Resources

- **GitHub**: [3DTek-xyz/HumanAgent-MCP](https://github.com/3DTek-xyz/HumanAgent-MCP)
- **Issues**: [Report bugs/request features](https://github.com/3DTek-xyz/HumanAgent-MCP/issues)
- **Medium Article**: [Human-in-the-Loop vs Fully Autonomous Agents](https://medium.com/@harperbenwilliam/stop-the-ai-chaos-why-human-in-the-loop-beats-fully-autonomous-coding-agents-eeb0ae17fde9)
- **Proxy Rules Documentation**: [Proxy-Rules.md](Proxy-Rules.md)

---

## Demo

![HumanAgent MCP Extension Demo](high-res-demo.gif)

*Complete demonstration showing real-time human-AI collaboration*
