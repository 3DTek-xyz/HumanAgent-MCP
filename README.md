# HumanAgent MCP

Forces GitHub Copilot to chat with you before acting. Stops runaway agents, reduces wasted API calls, lets you manage multiple workspaces from one interface.

## Installation

1. Install from VS Code Marketplace
2. Copilot automatically gets the `HumanAgent_Chat` tool
3. Done - no configuration needed

## How to Use

### Basic Workflow

1. **Ask Copilot to do something** - Copilot will use the HumanAgent_Chat tool
2. **Chat panel opens** - Green dot = connected, shows Copilot's message
3. **You respond** - Type your answer, click Send (or use Quick Replies)
4. **Copilot continues** - Gets your response and proceeds with the task

### VS Code Interface

**Chat Panel** (left sidebar):
- Green dot = connected to server
- Red dot = disconnected (auto-reconnects)
- Quick Replies = common responses like "Yes Please Proceed"
- Text input = always enabled, send button only active when Copilot is waiting

**Status Indicators:**
- **Server Status**
  - 🟢 Green = Running and connected
  - 🟠 Orange = Starting up
  - 🔴 Red = Stopped or disconnected
- **Proxy Status** (appears when proxy server is running)
  - 🟢 "Proxy (Enabled)" = Running AND enabled in VS Code
  - 🟠 "Proxy (Disabled)" = Running but NOT enabled
  - 🔴 "Proxy (Stopped)" = Not running

**Cog Menu** (⚙️):
- Show Status - check server state
- Start/Stop/Restart Server - manage server state
- Enable/Disable Proxy - toggle proxy mode (see Proxy Mode below)
- Install Proxy Certificate - install HTTPS cert (required for proxy)
- Uninstall Proxy Certificate - remove cert and disable proxy
- Create Override File - custom prompt override
- Name This Chat - set session name
- Open Web View - manage all workspaces in browser
- Help & Documentation - view this guide
- Report Issue / Request Feature - GitHub links

### Web Interface

Open from cog menu → **Open Web View**

Access all workspace chats in one browser tab at `http://localhost:3737/HumanAgent`
- See all conversations
- Switch between workspaces
- Append reminders to your responses

### Proxy Mode (Advanced)

Captures and displays HTTP/HTTPS traffic from VS Code for debugging extensions, marketplace requests, or other connections.

**Setup:**
1. Cog menu → Install Proxy Certificate (follow system prompts)
2. Cog menu → Enable Proxy
3. Browse anywhere in VS Code
4. View captured requests in "Proxy Logs" section
5. Click any log entry to expand and see full request/response details

**Important:**
- Certificate must be installed BEFORE enabling proxy
- Only captures traffic when enabled (orange/green status)
- To disable: Cog menu → Disable Proxy
- To uninstall cert: Cog menu → Uninstall Proxy Certificate

### Connection Status

- Auto-reconnects with exponential backoff (1s → 2s → 4s → 8s → 16s → 30s max)
- Manually starting server resets reconnection immediately
- No timeout - will retry forever

## Troubleshooting

**Red dot / disconnected:**
- Cog menu → Start Server
- Check VS Code Output panel for errors
- Restart VS Code

**Server won't start:**
- Check port 3737 not in use: `lsof -i :3737`
- Try manually restarting from cog menu

**Copilot not using the tool:**
- Tool registers automatically on startup
- Try: "Use HumanAgent_Chat to discuss this with me"

**Proxy not working:**
- Must install certificate first (cog menu → Install Proxy Certificate)
- Then enable proxy (cog menu → Enable Proxy)
- Check status shows "Proxy (Enabled)" with green dot
- Certificate must be trusted in system keychain (macOS: System Keychain)

**Proxy shows "Disabled" (orange dot):**
- Proxy server running but not enabled in VS Code settings
- Use cog menu → Enable Proxy (don't manually edit settings)

## Development

Press F5 to debug - dev mode uses port 3738, production uses 3737. No conflicts.

## Privacy & Telemetry

This extension collects **anonymous usage data** to help improve the product:

**What we track:**
- Extension activation/deactivation
- Feature usage (chat opened, messages sent/received)
- Error diagnostics (error types, not content)
- Session metrics (message counts, not content)
- Extension version, VS Code version, OS platform
- Days since installation

**What we DON'T track:**
- ❌ Your message content
- ❌ Your name, email, or any personal data
- ❌ Workspace paths or file names
- ❌ Any identifiable information

**Your privacy:**
- Respects VS Code's telemetry setting
- To disable: Settings → Telemetry → Level → Off
- Fully GDPR compliant
- Uses Google Analytics 4 for anonymous metrics

**Why telemetry?**
- Helps us understand which features are used
- Identifies bugs and errors to fix
- Measures engagement and retention
- Guides future development priorities

For questions: [GitHub Issues](https://github.com/3DTek-xyz/HumanAgent-MCP/issues)

## More Info

See [README-Additional.md](README-Additional.md) for technical details

## Demo

![HumanAgent MCP Extension Demo](high-res-demo.gif)

*Complete demonstration of the HumanAgent MCP extension in action - showing real-time human-AI collaboration*

## Medium Article
https://medium.com/@harperbenwilliam/stop-the-ai-chaos-why-human-in-the-loop-beats-fully-autonomous-coding-agents-eeb0ae17fde9

