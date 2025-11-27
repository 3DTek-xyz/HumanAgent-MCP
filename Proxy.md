
# Proxy.md

## Proxy Integration Plan (Built Into MCP Server)

### Technology Stack
- **Mockttp** - Modern, actively maintained Node.js HTTP/HTTPS MITM proxy library
  - Latest version: 4.2.1 (actively maintained)
  - Supports request/response interception, transformation, SSL
  - TypeScript-first with strong typing
  - Battle-tested (powers HTTP Toolkit)

### PHASE 1

#### Overview
- The proxy server will be implemented as part of the MCP server process using Mockttp.
- MCP server will expose a dedicated proxy port for HTTP(S) traffic.

#### VS Code Integration
- A new option will be added to the Human Agent cog menu:
	- Enable Proxy: Sets VS Code's `http.proxy` setting to the MCP proxy port.
	- Disable Proxy: Clears VS Code's `http.proxy` setting.
- Proxy status (active/inactive) will be displayed next to the MCP server status (green dot) at the top of the Human Agent chat panel.

#### Lifecycle
- Proxy runs as part of the MCP server, sharing its singleton, persistent lifecycle.
- Proxy port is discoverable by all VS Code instances.
- Proxy remains active even if the calling VS Code instance is closed.

#### Status Display
- Human Agent chat panel will show:
	- MCP server status (coloured dot as per current code)
	- Proxy status Same (same coloured dot)

#### Interface
- New tab in mcp web page showing proxy.
- Each request /response coming through proxy is logged and displayed - no persistant memory just  say 200 requests with first in first out.

 - Web page will not need refresh to update - should use SSE or whatever technology currently drives chat.

## Phase 1 Implementation Steps

1. Update MCP server to launch and manage the proxy server as part of its process.
2. Expose a dedicated proxy port from the MCP server for HTTP(S) traffic.
3. Implement proxy logic to intercept, log, and forward requests/responses (FIFO buffer, 200 entries).
4. Add proxy enable/disable options to the Human Agent cog menu:
    - Enable: set VS Code's `http.proxy` to MCP proxy port
    - Disable: clear VS Code's `http.proxy`
5. Update Human Agent chat panel UI to show proxy status indicator next to MCP server status.
6. Add a new tab in the MCP web page to display proxy logs (requests/responses, FIFO, no persistent memory). Web page will not need refresh to update - should use SSE or what ever technology currently drives chat
7. Ensure proxy lifecycle matches MCP server (singleton, persistent, discoverable by all VS Code instances).
8. Test proxy functionality, UI integration, and error handling across multiple VS Code instances.
9. Document configuration, usage, and troubleshooting in project docs.
