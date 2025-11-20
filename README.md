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

**Cog Menu** (⚙️):
- Show Status - check server state
- Name This Chat - set session name
- Open Web View - manage all workspaces in browser
- Configure MCP - start/stop/restart server
- Report Issue / Request Feature - GitHub links

### Web Interface

Open from cog menu → **Open Web View**

Access all workspace chats in one browser tab at `http://localhost:3737/HumanAgent`
- See all conversations
- Switch between workspaces
- Append reminders to your responses

### Connection Status

- Auto-reconnects with exponential backoff (1s → 2s → 4s → 8s → 16s → 30s max)
- Manually starting server resets reconnection immediately
- No timeout - will retry forever

## Troubleshooting

**Red dot / disconnected:**
- Cog menu → Configure MCP → Start Server
- Check VS Code Output panel for errors

**Server won't start:**
- Check port 3737 not in use: `lsof -i :3737`
- Restart VS Code

**Copilot not using the tool:**
- Tool registers automatically on startup
- Try: "Use HumanAgent_Chat to discuss this with me"

## Development

Press F5 to debug - dev mode uses port 3738, production uses 3737. No conflicts.

## More Info

See [README-Additional.md](README-Additional.md) for technical details

## Demo

![HumanAgent MCP Extension Demo](high-res-demo.gif)

*Complete demonstration of the HumanAgent MCP extension in action - showing real-time human-AI collaboration*

## Medium Article
https://medium.com/@harperbenwilliam/stop-the-ai-chaos-why-human-in-the-loop-beats-fully-autonomous-coding-agents-eeb0ae17fde9

