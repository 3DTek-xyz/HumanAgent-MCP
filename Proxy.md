
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

---

## Phase 2: HTTPS Interception (COMPLETED ✅)

### Overview
The proxy server now supports full HTTPS/TLS traffic interception by dynamically generating a Certificate Authority (CA). HTTP and HTTPS requests are intercepted, logged, and forwarded using Mockttp's built-in HTTPS proxy capabilities.

### Implementation Summary

**1. Certificate Authority Generation:**
- CA certificate + private key automatically generated on first MCP server start
- Cached in `/tmp/humanagent-proxy/` directory
- Reused on subsequent starts (no regeneration needed)
- Uses Mockttp's `generateCACertificate()` function

**2. ProxyServer Integration:**
- Proxy runs as part of MCP server process (single integrated proxy)
- Accepts HTTPS config with `keyPath` and `certPath` parameters
- Reads certificate files and passes content to Mockttp
- Single proxy instance handles both HTTP and HTTPS traffic

**3. MCP Server Initialization:**
- On start, MCP server calls `initializeProxyCA()` to generate/load CA cert
- Passes CA paths to `proxyServer.start(httpsOptions)`
- Sets `NODE_EXTRA_CA_CERTS` environment variable for Node.js process trust
- Proxy starts on dynamic port (typically 8001) with full HTTPS support

### Key Features
✅ **Integrated Design** - Proxy is part of MCP server, not separate process  
✅ **Automatic HTTPS** - CA certificate generated and configured automatically  
✅ **HTTP + HTTPS** - Single proxy handles both protocols  
✅ **Certificate Caching** - CA generated once, reused on subsequent starts  
✅ **Zero Configuration** - No manual certificate installation required  
✅ **Node.js Trust** - All Node.js processes automatically trust the CA  

### Files Modified
- `src/mcp/server.ts` - Added `initializeProxyCA()` function and CA initialization in `start()`
- `src/mcp/proxyServer.ts` - Updated to read cert files and pass content to Mockttp
- `src/extension.ts` - Removed duplicate proxy code (was incorrectly implemented outside MCP server)

### Current Status
- ✅ CA certificate generation working
- ✅ HTTPS configuration in proxyServer.ts working
- ✅ MCP server integration complete
- ✅ HTTPS interception verified with curl (SSL certificate verify ok)
- ⚠️ VS Code Marketplace integration blocked - awaiting Phase 3 implementation

---

## Phase 3: System Certificate Trust (IN PROGRESS 🔄)

### Problem Statement
While the HTTPS proxy successfully intercepts traffic (verified with curl), VS Code/Chromium does not trust the dynamically generated CA certificate. This causes `ERR_CERT_AUTHORITY_INVALID` errors when VS Code makes requests through the proxy (e.g., Extension Marketplace).

**Root Cause:** Chromium (which VS Code is built on) uses the **OS certificate trust store**, not `http.proxyStrictSSL` setting. The `http.proxyStrictSSL: false` setting only applies to legacy extension CLI operations, not the main VS Code/Chromium network stack.

### Solution: macOS System Keychain Installation
For users to benefit from HTTPS interception, the CA certificate must be installed in the macOS System Keychain (or equivalent on other platforms).

### Requirements

**1. Permanent Certificate Storage:**
- Move CA certificate from temp directory (`/tmp/humanagent-proxy/`) to permanent location
- Suggested path: `~/.vscode/extensions/humanagent-mcp-<version>/data/ca.pem` (or global storage API)
- Update `initializeProxyCA()` in `server.ts` to use permanent path
- Ensure cert persists across VS Code updates and system reboots

**2. Certificate Installation Command:**
- Add "Install Proxy Certificate" option to cog menu
- Command runs: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <ca-cert-path>`
- Requires user's sudo password
- Should handle errors gracefully (password cancelled, permission denied, etc.)

**3. Certificate Check on Enable Proxy:**
- When user clicks "Enable Proxy", check if certificate is installed in System Keychain
- If not installed: Show warning/prompt to install certificate first
- Provide clear instructions that HTTPS interception requires certificate trust

**4. Cog Menu Options:**
- "Install Proxy Certificate" - Installs CA cert to System Keychain (requires sudo)
- "Uninstall Proxy Certificate" - Removes CA cert from System Keychain (requires sudo, optional cleanup)
- "Enable Proxy" - Sets `http.proxy` setting and checks cert installation status
- "Disable Proxy" - Clears `http.proxy` setting

**5. Certificate Verification:**
- Implement function to check if certificate is installed in System Keychain
- macOS command: `security find-certificate -c "HumanAgent Proxy CA" /Library/Keychains/System.keychain`
- Exit code 0 = installed, non-zero = not installed

### Implementation Steps

1. **Update Certificate Storage Path:** ✅ COMPLETED
   - Modified `initializeProxyCA()` in `server.ts` to accept storage path parameter
   - Added `certStoragePath` to `ServerManagerOptions` interface
   - Extension passes `context.globalStorageUri.fsPath` to ServerManager
   - ServerManager passes path to MCP server via `HUMANAGENT_CERT_STORAGE_PATH` env var
   - Certificate now stored in: `~/.vscode/extensions/<ext-id>/globalStorage/proxy-ca/`
   - Fallback to `/tmp` if storage path not provided

2. **Add Certificate Verification Function:** (Platform-Independent Approach)
   - Create utility function to test HTTPS proxy functionality
   - Make test request through proxy to `https://example.com`
   - If succeeds → Certificate installed and working ✓
   - If fails with SSL error → Certificate not installed or broken ✗
   - Works on ALL platforms without OS-specific commands
   - Function will be called before enabling proxy

3. **Implement Install Certificate Command:**
   - Add VS Code command `humanagent-mcp.installProxyCertificate`
   - Show information message explaining what will happen
   - Platform-specific installation:
     - **macOS:** `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <ca-cert-path>`
     - **Windows:** `certutil -addstore Root <ca-cert-path>` (requires admin)
     - **Linux:** Distribution-specific (Ubuntu: `sudo cp <ca-cert-path> /usr/local/share/ca-certificates/ && sudo update-ca-certificates`)
   - Show success/error notifications
   - Handle password cancellation and permission errors

4. **Implement Uninstall Certificate Command:**
   - Add VS Code command `humanagent-mcp.uninstallProxyCertificate`
   - Platform-specific uninstallation:
     - **macOS:** `sudo security delete-certificate -c "HumanAgent Proxy CA" /Library/Keychains/System.keychain`
     - **Windows:** `certutil -delstore Root "HumanAgent Proxy CA"`
     - **Linux:** Remove from trust store and run `sudo update-ca-certificates`

5. **Update Enable Proxy Logic:**
   - Before setting `http.proxy`, check certificate using verification function (step 2)
   - If verification fails: Block enabling and show error: "Certificate not installed. Use 'Install Proxy Certificate' first."
   - If verification succeeds: Enable proxy and show success message
   - Prevent broken proxy configuration at all costs

6. **Update Cog Menu:**
   - Add "Install Proxy Certificate" option
   - Add "Uninstall Proxy Certificate" option
   - Keep existing "Enable Proxy" / "Disable Proxy" options
   - Enable Proxy option shows warning if cert not installed

7. **Testing:**
   - Test certificate storage in globalStorage directory
   - Test certificate installation on macOS (manual test already successful)
   - Verify VS Code Marketplace works after cert installation (manual test already successful)
   - Test certificate verification function
   - Test enable proxy with/without certificate
   - Test certificate uninstallation
   - Verify error handling (cancelled password, permission denied)
   - Test on Windows/Linux (platform-specific commands)

### Security Considerations
- User must explicitly approve certificate installation (sudo password required)
- Clear messaging about what the certificate does (MITM proxy for development)
- Uninstall option provided for cleanup
- Certificate only valid for proxy, limited scope

### User Experience Flow
1. User enables proxy → Warning: "Certificate not installed. HTTPS interception won't work."
2. User clicks "Install Proxy Certificate" from cog menu
3. System prompts for sudo password
4. Certificate installed to System Keychain
5. User enables proxy again → Success! HTTPS traffic now intercepted

### Platform Support
- **macOS:** `security add-trusted-cert` / `security delete-certificate`
- **Windows:** `certutil -addstore Root` / `certutil -delstore Root`
- **Linux:** Varies by distribution, typically `update-ca-certificates` or `trust anchor`

### Current Status
- ✅ Requirements documented
- ✅ Certificate storage path updated to use VS Code globalStorage
- ✅ Manual certificate installation tested and verified working
- ✅ VS Code Marketplace confirmed working with installed certificate
- ⏳ Certificate verification function not implemented yet
- ⏳ Install Certificate command not implemented yet
- ⏳ Uninstall Certificate command not implemented yet
- ⏳ Cog menu options not added yet
- ⏳ Enable Proxy certificate check not implemented yet

**Next:** Implement certificate verification function (platform-independent test approach)
