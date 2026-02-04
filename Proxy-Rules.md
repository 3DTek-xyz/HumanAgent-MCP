# Proxy Rules

Transform, redirect, or drop HTTP/HTTPS requests using powerful JSONata expressions.

## What Are Proxy Rules?

Proxy rules let you intercept and modify network traffic passing through the HumanAgent MCP proxy. You can:
- Redirect requests to different URLs
- Transform request/response data with JSONata
- Block specific requests
- Debug API calls and responses

## Creating Rules

Two default example rules are created on first install (both disabled):
1. **Karen Personality** - Adds personality to Copilot responses (see Use Cases below)
- This is the main reason i added the proxy - it enables you to completly replace the horrid system prompt used by copilot - the one that makes it run of and ruin everything.
2. **Block GitHub Copilot Telemetry** - Blocks telemetry requests

You can enable these examples or create your own custom rules.

### Via Web Interface
1. Open cog menu → **Open Web View**
2. Navigate to **Proxy Logs** tab
3. Click **Add Rule** button
4. Fill in the rule form:
   - **Name**: Descriptive name for your rule
   - **Pattern**: URL pattern to match (regex supported, e.g., `.*marketplace.*`)
   - **Redirect**: Optional URL to redirect to
   - **JSONata**: Optional transformation expression
   - **Drop Request**: Check to block matching requests
   - **Scope**: Global (all sessions) or Session-specific
   - **Debug**: Enable verbose logging for this rule

### Rule Components

**Pattern (Required)**
- Regular expression to match request URLs
- Examples:
  - `.*marketplace.*` - matches any marketplace URL
  - `^https://api\.github\.com/.*` - matches GitHub API
  - `.*\\.json$` - matches all JSON file requests

**Redirect (Optional)**
- Redirect matching requests to a different URL
- Example: Redirect API calls to a local mock server
  ```
  Pattern: ^https://api\.example\.com/(.*)
  Redirect: http://localhost:3000/$1
  ```

**JSONata (Optional)**
- Transform request/response data using JSONata expressions
- Access request data: `$request.url`, `$request.method`, `$request.headers`
- Access response data: `$response.statusCode`, `$response.body`
- Example: Modify API response
  ```jsonata
  {
    "modified": true,
    "originalData": $response.body
  }
  ```

**Drop Request**
- Block matching requests entirely
- Returns 403 Forbidden by default
- Useful for blocking telemetry or tracking requests

**Scope**
- **Global**: Rule applies to all workspaces and sessions
- **Session**: Rule only applies to specific workspace/session

**Debug Mode**
- Enables detailed logging for this rule
- Shows pattern matching, transformations, and execution details
- Appears in proxy logs with [DEBUG] prefix

## Managing Rules

### Viewing Rules
- Open **Proxy Logs** tab in web interface
- All active rules shown above request logs
- Status indicator shows enabled/disabled state

### Editing Rules
- Click rule name or edit icon
- Modify any rule parameters
- Changes take effect immediately (no restart needed)

### Deleting Rules
- Click delete icon next to rule
- Confirmation required
- Cannot be undone

### Enabling/Disabling Rules
- Toggle switch next to each rule
- Disabled rules won't match requests
- Rule configuration preserved when disabled

## Use Cases

### 1. Karen Personality (Default Example)
Transform GitHub Copilot API requests to add personality instructions:
```
Name: Karen Personality
Pattern: ^https://api\.individual\.githubcopilot\.com/chat/completions/?$
JSONata: $merge([$, {"messages": $.messages.(  role = "system" ?   $merge([$, {"content": "Your Name is Karen - behave like one - not too rude racist or sexist - just a bit of a bitch"}]) :   $)}])
Scope: Global
Enabled: ❌ (disabled by default, enable to activate)
```

This rule intercepts Copilot chat requests and modifies the system message to add personality traits.

### 2. Block Telemetry (Default Example)
Stop GitHub Copilot telemetry requests:
```
Name: Block GitHub Copilot Telemetry
Pattern: ^https://telemetry\.individual\.githubcopilot\.com/.*$
Drop Request: ✓
Drop Status Code: 204
Scope: Global
Enabled: ❌ (disabled by default, enable to activate)
```

This rule blocks all telemetry requests from GitHub Copilot by returning 204 No Content.

### 3. API Mocking
Redirect production API to local development server:
```
Pattern: ^https://api\.production\.com/(.*)
Redirect: http://localhost:4000/api/$1
```

### 4. Response Transformation
Modify API responses with JSONata:
```
Pattern: ^https://api\.example\.com/users
JSONata: {
  "users": $response.body.users[role = "admin"]
}
```

### 5. Debugging API Calls
Log detailed request/response info:
```
Pattern: ^https://api\.github\.com/.*
Debug: ✓
```

## JSONata Resources

- [JSONata Documentation](https://jsonata.org/)
- [JSONata Exerciser](https://try.jsonata.org/) - Test expressions
- Built-in rule builder includes examples and syntax help

## Limitations

- Rules only apply when proxy is enabled
- Pattern matching uses JavaScript RegExp
- JSONata errors will block request transformation
- Heavy transformations may slow request processing
- Maximum 200 proxy logs retained (FIFO)

## Security

- Rules can intercept sensitive data (credentials, tokens)
- Only use on trusted development machines
- Don't share rules that contain sensitive patterns
- Clear rules when working with production data

## Troubleshooting

**Rule not matching requests:**
- Check pattern regex syntax
- Enable debug mode to see pattern matching
- Verify proxy is enabled (green status indicator)

**JSONata transformation failing:**
- Test expression at [try.jsonata.org](https://try.jsonata.org/)
- Check proxy logs for error messages
- Enable debug mode for detailed error info

**Redirects not working:**
- Verify target URL is accessible
- Check redirect URL doesn't create infinite loop
- Ensure target server is running (for localhost redirects)
