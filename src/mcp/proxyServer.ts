import { EventEmitter } from 'events';
import * as Mockttp from 'mockttp';
import * as fs from 'fs';
import * as path from 'path';
// JSONata will be imported dynamically when needed

/**
 * ProxyRule scope type
 */
export type ProxyRuleScope = 'global' | 'session' | 'workspace';

/**
 * ProxyRule represents a proxy rule configuration
 */
export interface ProxyRule {
    id: string;
    name: string;
    pattern: string;
    enabled: boolean;
    createdAt: string;
    redirect?: string;
    jsonata?: string;
    dropRequest?: boolean;
    dropStatusCode?: number;
    scope?: ProxyRuleScope;
    sessionId?: string;
    sessionName?: string;
    workspaceFolder?: string;
    debug?: boolean; // Enable enhanced debug logging for this rule
}

/**
 * ProxyLogEntry represents a single HTTP request/response captured by the proxy
 */
export interface ProxyLogEntry {
    id: string;
    timestamp: number;
    method: string;
    url: string;
    requestHeaders: Record<string, string | string[]>;
    requestBody?: string;
    responseStatus?: number;
    responseHeaders?: Record<string, string | string[]>;
    responseBody?: string;
    duration?: number;
    protocol?: string; // 'http' | 'https'
    ruleApplied?: {
        ruleId: string;
        ruleIndex: number;
        originalUrl?: string;
        modifications?: string[];
        hoverInfo?: {
            originalText: string;
            replacementText: string;
        };
    };
}

/**
 * ProxyServer manages the Mockttp proxy instance
 * Runs as part of the MCP server process
 */
export class ProxyServer extends EventEmitter {
    private mockttpServer: Mockttp.Mockttp | null = null;
    private port: number = 0;
    private logs: ProxyLogEntry[] = [];
    private debugLogs: Array<{timestamp: string, message: string}> = [];
    private maxLogs: number = 200; // FIFO buffer size
    private maxDebugLogs: number = 500; // Debug logs buffer
    private isRunning: boolean = false;
    private httpsOptions?: { keyPath: string; certPath: string };
    private rules: ProxyRule[] = []; // Proxy rules loaded from storage
    private currentSessionId?: string; // Current session ID for filtering rules
    private currentWorkspaceFolder?: string; // Current workspace folder for filtering rules
    private sessionLookup?: (vscodeSessionId: string) => { sessionId: string, workspacePath?: string } | undefined; // Callback to lookup session context from VS Code session ID

    constructor(sessionLookup?: (vscodeSessionId: string) => { sessionId: string, workspacePath?: string } | undefined) {
        super();
        this.sessionLookup = sessionLookup;
    }

    /**
     * Add debug log entry that can be retrieved via web interface
     */
    private addDebugLog(message: string) {
        const entry = {
            timestamp: new Date().toISOString(),
            message: `[ProxyServer] ${message}`
        };
        
        this.debugLogs.push(entry);
        
        // Keep buffer size limited
        if (this.debugLogs.length > this.maxDebugLogs) {
            this.debugLogs.shift();
        }
        
        // Also log to console for development
        console.log(entry.message);
    }

    /**
     * Get debug logs for web interface
     */
    getDebugLogs(): Array<{timestamp: string, message: string}> {
        return [...this.debugLogs];
    }

    /**
     * Start the proxy server on a dynamic port with optional HTTPS support
     * @param httpsOptions Optional HTTPS configuration with keyPath and certPath
     */
    async start(httpsOptions?: { keyPath: string; certPath: string }): Promise<number> {
        if (this.isRunning) {
            this.addDebugLog('Already running');
            return this.port;
        }

        try {
            this.httpsOptions = httpsOptions;
            
            // Build Mockttp configuration
            const config: any = {
                cors: true,
                recordTraffic: false // We'll handle logging ourselves
            };
            
            // Add HTTPS support if key/cert paths provided
            if (httpsOptions?.keyPath && httpsOptions?.certPath) {
                // Mockttp requires cert/key content as strings, not paths
                const certContent = fs.readFileSync(httpsOptions.certPath, 'utf8');
                const keyContent = fs.readFileSync(httpsOptions.keyPath, 'utf8');
                
                config.https = {
                    cert: certContent,
                    key: keyContent
                };
                this.addDebugLog(`HTTPS enabled with CA cert from: ${httpsOptions.certPath}`);
            }

            // Create Mockttp instance
            this.mockttpServer = Mockttp.getLocal(config);

            // Set up unified handler that processes rules and logs all requests
            this.addDebugLog('DEBUG: About to call setupUnifiedHandler...');
            await this.setupUnifiedHandler();
            this.addDebugLog('DEBUG: setupUnifiedHandler completed');

            // Start server on dynamic port
            await this.mockttpServer.start();
            this.port = this.mockttpServer.port;
            this.isRunning = true;

            this.addDebugLog(`Started on port ${this.port}`);
            this.emit('started', this.port);

            return this.port;
        } catch (error) {
            console.error('[ProxyServer] Failed to start:', error);
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Stop the proxy server
     */
    async stop(): Promise<void> {
        if (!this.isRunning || !this.mockttpServer) {
            return;
        }

        try {
            await this.mockttpServer.stop();
            this.isRunning = false;
            this.port = 0;
            this.addDebugLog('Stopped');
            this.emit('stopped');
        } catch (error) {
            console.error('[ProxyServer] Failed to stop:', error);
            this.emit('error', error);
            throw error;
        }
    }

    /**
     * Get the current proxy port
     */
    getPort(): number {
        return this.port;
    }

    /**
     * Get proxy server status
     */
    getStatus(): { running: boolean; port: number } {
        return {
            running: this.isRunning,
            port: this.port
        };
    }

    /**
     * Get all proxy logs (FIFO buffer)
     */
    getLogs(): ProxyLogEntry[] {
        return [...this.logs];
    }

    /**
     * Clear all proxy logs
     */
    clearLogs(): void {
        this.logs = [];
        this.emit('logs-cleared');
    }

    /**
     * Clear all debug logs
     */
    clearDebugLogs(): void {
        this.debugLogs = [];
        this.addDebugLog('Debug logs cleared');
    }

    /**
     * Add a log entry to the FIFO buffer
     */
    private addLogEntry(entry: ProxyLogEntry): void {
        this.logs.push(entry);

        // Maintain FIFO buffer size
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        this.emit('log-added', entry);
    }

    /**
     * Generate a unique log entry ID
     */
    private generateLogId(): string {
        return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }

    /**
     * Truncate text to first N words for display
     */
    private truncateToWords(text: string, wordCount: number = 10): string {
        if (!text) {
            return '';
        }
        const words = text.toString().trim().split(/\s+/);
        if (words.length <= wordCount) {
            return text;
        }
        return words.slice(0, wordCount).join(' ') + '...';
    }

    /**
     * Reload proxy rules (called when rules are updated in storage)
     * Requires restarting the proxy to apply new handlers
     */
    async reloadRules(): Promise<void> {
        this.addDebugLog('DEBUG: ========= RELOAD RULES CALLED =========');
        this.addDebugLog(`DEBUG: isRunning: ${this.isRunning}`);
        this.addDebugLog(`DEBUG: current rules count: ${this.rules?.length || 0}`);
        
        if (!this.isRunning) {
            this.addDebugLog('Proxy not running, skipping rule reload');
            return;
        }
        
        // Restart proxy to apply new rules
        const port = this.port;
        const httpsOpts = this.httpsOptions;
        
        await this.stop();
        await this.start(httpsOpts);
        
        this.addDebugLog(`Proxy restarted with updated rules on port ${port}`);
    }

    /**
     * Set proxy rules from external storage
     * @param rules Array of rule objects with id, pattern, redirect, jsonata, enabled
     */
    setRules(rules: any[]): void {
        this.rules = rules;
        this.addDebugLog(`Set ${rules.length} proxy rules`);
    }

    /**
     * Set current session context for rule filtering
     */
    setSessionContext(sessionId?: string): void {
        this.currentSessionId = sessionId;
        this.addDebugLog(`Session context updated: ${sessionId || 'none'}`);
    }

    /**
     * Set current workspace context for rule filtering
     */
    setWorkspaceContext(workspaceFolder?: string): void {
        this.currentWorkspaceFolder = workspaceFolder;
        this.addDebugLog(`Workspace context updated: ${workspaceFolder || 'none'}`);
    }

    /**
     * Filter rules based on current scope context
     * Returns only rules that should apply in the current context
     */
    private getApplicableRules(): ProxyRule[] {
        const applicable = this.rules.filter(rule => {
            // If no scope specified, treat as global (backward compatibility)
            const scope = rule.scope || 'global';
            
            // Global rules always apply
            if (scope === 'global') {
                return true;
            }
            
            // Session rules only apply if sessionId matches
            if (scope === 'session') {
                const matches = rule.sessionId === this.currentSessionId;
                if (!matches) {
                    this.addDebugLog(`   ⏭️  Skipping session rule "${rule.name || rule.id}" - requires session "${rule.sessionName || rule.sessionId}" but current is "${this.currentSessionId || 'none'}"`);
                }
                return matches;
            }
            
            // Workspace rules only apply if workspaceFolder matches
            if (scope === 'workspace') {
                const matches = rule.workspaceFolder === this.currentWorkspaceFolder;
                if (!matches) {
                    this.addDebugLog(`   ⏭️  Skipping workspace rule "${rule.name || rule.id}" - requires workspace "${rule.workspaceFolder}" but current is "${this.currentWorkspaceFolder || 'none'}"`);
                }
                return matches;
            }
            
            return false;
        });
        
        return applicable;
    }

    /**
     * Get current proxy rules
     */
    getRules(): any[] {
        return [...this.rules];
    }

    /**
     * Set up unified handler that processes all requests - with rules and logging
     */
    private async setupUnifiedHandler(): Promise<void> {
        this.addDebugLog('DEBUG: ========= SETUP UNIFIED HANDLER CALLED =========');
        this.addDebugLog(`DEBUG: mockttpServer exists: ${!!this.mockttpServer}`);
        this.addDebugLog(`DEBUG: rules array length: ${this.rules?.length || 0}`);
        
        if (!this.mockttpServer) {
            this.addDebugLog('DEBUG: No mockttpServer - returning early');
            return;
        }
        
        this.addDebugLog(`Setting up UNIFIED HANDLER for proxy rules (will filter per-request based on scope)`);

        // Single unified handler that processes rules and logs ALL requests
        await this.mockttpServer.forAnyRequest()
            .thenPassThrough({
                beforeRequest: async (req) => {
                    this.addDebugLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                    this.addDebugLog(`📥 INCOMING REQUEST: ${req.method} ${req.url}`);
                    this.addDebugLog(`   Headers: ${JSON.stringify(req.headers, null, 2)}`);
                    
                    // Extract session context from request FIRST
                    // Check for VS Code's native session ID header (no hyphen)
                    const vscodeSessionId = req.headers['vscode-sessionid'];
                    if (vscodeSessionId && this.sessionLookup) {
                        const sessionContext = this.sessionLookup(vscodeSessionId as string);
                        if (sessionContext) {
                            this.addDebugLog(`   VS Code Session ID detected: ${vscodeSessionId} → MCP Session: ${sessionContext.sessionId}, Workspace: ${sessionContext.workspacePath || 'none'}`);
                            this.setSessionContext(sessionContext.sessionId);
                            if (sessionContext.workspacePath) {
                                this.setWorkspaceContext(sessionContext.workspacePath);
                            }
                        } else {
                            this.addDebugLog(`   VS Code Session ID detected but not mapped: ${vscodeSessionId}`);
                        }
                    } else {
                        // Fallback to legacy headers
                        const sessionId = req.headers['x-session-id'] || 
                                         req.headers['x-vscode-session-id'] || 
                                         req.headers['session-id'];
                        if (sessionId) {
                            this.addDebugLog(`   Session ID detected from legacy headers: ${sessionId}`);
                            this.setSessionContext(sessionId as string);
                        } else {
                            this.addDebugLog(`   No session ID in headers, using current context: ${this.currentSessionId || 'none'}, workspace: ${this.currentWorkspaceFolder || 'none'}`);
                        }
                    }
                    
                    // Get applicable rules based on CURRENT scope context (after session detection)
                    const applicableRules = this.getApplicableRules().filter(r => r.enabled);
                    this.addDebugLog(`   Found ${applicableRules.length} applicable enabled rules (out of ${this.rules.length} total)`);
                    
                    if (applicableRules.length > 0) {
                        this.addDebugLog(`   Evaluating ${applicableRules.length} applicable rules...`);
                    }
                    
                    // Process each applicable rule in order until we find a match
                    for (let i = 0; i < applicableRules.length; i++) {
                        const rule = applicableRules[i];
                        const ruleIndex = this.rules.findIndex(r => r.id === rule.id) + 1;
                        
                        try {
                            // Handle both regex patterns and literal URLs
                            let isMatch: boolean;
                            if (rule.pattern.startsWith('^') || rule.pattern.includes('.*') || rule.pattern.includes('\\')) {
                                // Treat as regex pattern
                                const urlPattern = new RegExp(rule.pattern);
                                isMatch = urlPattern.test(req.url);
                            } else {
                                // Treat as literal URL - use robust normalization and matching
                                const normalizedPattern = rule.pattern.trim().toLowerCase();
                                const normalizedUrl = req.url.trim().toLowerCase();
                                
                                // Try exact match first, then contains match
                                isMatch = normalizedUrl === normalizedPattern || 
                                         normalizedUrl.includes(normalizedPattern) ||
                                         req.url === rule.pattern ||
                                         req.url.includes(rule.pattern);
                            }
                            
                            // Enhanced debug logging for rules with debug flag enabled
                            if (rule.debug) {
                                this.addDebugLog(`🔍 DEBUG MODE ENABLED FOR RULE: "${rule.name || rule.id}"`);
                                this.addDebugLog(`   Pattern: "${rule.pattern}"`);
                                this.addDebugLog(`   Request URL: "${req.url}"`);
                                this.addDebugLog(`   URL Match Result: ${isMatch}`);
                                this.addDebugLog(`   Match Type: ${rule.pattern.startsWith('^') || rule.pattern.includes('.*') || rule.pattern.includes('\\') ? 'REGEX' : 'LITERAL'}`);
                                this.addDebugLog(`   Pattern Length: ${rule.pattern.length}`);
                                this.addDebugLog(`   Request URL Length: ${req.url.length}`);
                                this.addDebugLog(`   Strict Equality: ${rule.pattern === req.url}`);
                                this.addDebugLog(`   Scope: ${rule.scope || 'global'}`);
                                if (rule.sessionId) {
                                    this.addDebugLog(`   Session ID: ${rule.sessionId}`);
                                }
                                if (rule.workspaceFolder) {
                                    this.addDebugLog(`   Workspace: ${rule.workspaceFolder}`);
                                }
                            }
                            
                            const ruleLabel = `[${i + 1}/${applicableRules.length}] "${rule.name || rule.id}"`;
                            this.addDebugLog(`   ${isMatch ? '✅' : '❌'} ${ruleLabel} - Pattern: "${rule.pattern}" - Match: ${isMatch}`);
                            
                            if (isMatch) {
                                // Determine scope type for logging
                                let scopeType = 'GLOBAL';
                                if (rule.scope === 'session' && rule.sessionId) {
                                    scopeType = `SESSION (${rule.sessionName || rule.sessionId})`;
                                } else if (rule.scope === 'workspace' && rule.workspaceFolder) {
                                    scopeType = `WORKSPACE (${rule.workspaceFolder})`;
                                }
                                
                                this.addDebugLog(`   🎯 RULE MATCHED! [${scopeType}] Applying "${rule.name || rule.id}"`);
                                
                                // Handle drop requests
                                if (rule.dropRequest) {
                                    const dropStatusCode = rule.dropStatusCode || 204;
                                    this.addDebugLog(`   🛑 DROP REQUEST - Status: ${dropStatusCode}`);
                                    this.addDebugLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                                    
                                    // Log the dropped request
                                    const protocol = req.url.startsWith('https://') ? 'https' : 'http';
                                    const logEntry: ProxyLogEntry = {
                                        id: this.generateLogId(),
                                        timestamp: Date.now(),
                                        method: req.method,
                                        url: req.url,
                                        requestHeaders: { ...req.headers } as Record<string, string | string[]>,
                                        requestBody: req.body?.buffer ? req.body.buffer.toString('utf8') : undefined,
                                        responseStatus: dropStatusCode,
                                        responseHeaders: {},
                                        responseBody: `Request dropped by proxy rule (status ${dropStatusCode})`,
                                        duration: 0,
                                        protocol: protocol,
                                        ruleApplied: {
                                            ruleId: rule.id,
                                            ruleIndex: ruleIndex,
                                            modifications: [`Request dropped with status ${dropStatusCode}`],
                                            hoverInfo: {
                                                originalText: 'Request sent to server',
                                                replacementText: `Dropped with ${dropStatusCode} status`
                                            }
                                        }
                                    };
                                    
                                    this.addLogEntry(logEntry);
                                    this.emit('request', logEntry);
                                    this.emit('log-updated', logEntry);
                                    
                                    // Throw to stop further processing - this will be caught by Mockttp
                                    throw new Error(`DROPPED:${dropStatusCode}`);
                                }

                                // Handle request modifications (URL redirect, JSONata transformation)
                                return await this.applyRuleModifications(req, rule, ruleIndex);
                            }
                        } catch (error) {
                            this.addDebugLog(`ERROR in rule "${rule.name || rule.id}": ${error}`);
                        }
                    }
                    
                    // No rules matched - log as passthrough request
                    this.addDebugLog(`   ⚠️  NO RULES MATCHED - Logging and passing through unchanged`);
                    
                    // Log request (no rule applied)
                    const protocol = req.url.startsWith('https://') ? 'https' : 'http';
                    const logEntry: ProxyLogEntry = {
                        id: this.generateLogId(),
                        timestamp: Date.now(),
                        method: req.method,
                        url: req.url,
                        requestHeaders: { ...req.headers } as Record<string, string | string[]>,
                        requestBody: req.body?.buffer ? req.body.buffer.toString('utf8') : undefined,
                        protocol: protocol
                    };

                    this.addLogEntry(logEntry);
                    this.emit('request', logEntry);
                    
                    this.addDebugLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                    return req;
                },
                beforeResponse: async (res) => {
                    // Find the most recent log entry that doesn't have a response yet
                    const logEntry = [...this.logs].reverse().find(entry => 
                        entry.responseStatus === undefined
                    );
                    
                    if (logEntry) {
                        logEntry.responseStatus = res.statusCode;
                        logEntry.responseHeaders = { ...res.headers } as Record<string, string | string[]>;
                        logEntry.responseBody = res.body?.buffer ? res.body.buffer.toString('utf8') : undefined;
                        logEntry.duration = Date.now() - logEntry.timestamp;

                        this.emit('response', logEntry);
                        this.emit('log-updated', logEntry);
                        
                        // Add debug log for response
                        this.addDebugLog(`   ✅ Response: ${res.statusCode} (${logEntry.duration}ms)`);
                    } else {
                        console.warn('[ProxyServer] Could not find matching log entry for response');
                    }
                }
            });
    }

    /**
     * Apply rule modifications to a request
     */
    private async applyRuleModifications(req: any, rule: any, ruleIndex: number): Promise<any> {
        const originalUrl = req.url;
        const modifications: string[] = [];
        let modifiedUrl = req.url;
        let modifiedBody: any = undefined;
        
        this.addDebugLog(`   🔧 Applying modifications...`);
        
        // Apply URL redirect if specified
        if (rule.redirect) {
            const urlPattern = new RegExp(rule.pattern);
            modifiedUrl = req.url.replace(urlPattern, rule.redirect);
            modifications.push(`URL: ${originalUrl} → ${modifiedUrl} (Rule: ${rule.name || 'Unnamed'})`);
            this.addDebugLog(`      🔀 URL Redirect: ${originalUrl} → ${modifiedUrl}`);
        }
        
        // Apply JSONata transformation if specified
        if (rule.jsonata && req.body?.buffer) {
            try {
                this.addDebugLog(`      🔄 JSONata transformation: ${rule.jsonata.substring(0, 50)}...`);
                const bodyText = req.body.buffer.toString('utf8');
                let bodyJson: any;
                
                // Try parsing as JSON, if it fails try JSONL
                try {
                    bodyJson = JSON.parse(bodyText);
                } catch {
                    // Try JSONL format (multiple JSON objects)
                    const lines = bodyText.trim().split('\n');
                    if (lines.length > 1) {
                        bodyJson = lines.map((line: string) => JSON.parse(line.trim()));
                    } else {
                        throw new Error('Invalid JSON format');
                    }
                }
                
                // Apply JSONata transformation using dynamic import
                const JSONata = (await import('jsonata')).default;
                const expression = JSONata(rule.jsonata);
                const transformedData = await expression.evaluate(bodyJson);
                
                this.addDebugLog(`JSONata RESULT: ${JSON.stringify(transformedData)}`);
                
                // Check if transformation actually produced a valid, different result
                if (transformedData !== undefined && transformedData !== null) {
                    // Ensure the transformed data is actually different from original
                    const transformedString = JSON.stringify(transformedData);
                    const originalString = JSON.stringify(bodyJson);
                    
                    if (transformedString !== originalString) {
                        modifiedBody = transformedData;
                        modifications.push(`JSONata: Applied transformation "${rule.jsonata.length > 30 ? rule.jsonata.substring(0, 30) + '...' : rule.jsonata}" (Rule: ${rule.name || 'Unnamed'})`);
                        this.addDebugLog(`         ✅ SUCCESS - Body transformed (${originalString.length} → ${transformedString.length} bytes)`);
                    } else {
                        this.addDebugLog(`         ⚠️  NO CHANGE - Transformation returned same data`);
                    }
                } else {
                    this.addDebugLog(`         ❌ NULL RESULT - Transformation returned undefined/null`);
                }
            } catch (error) {
                this.addDebugLog(`         ❌ ERROR: ${error}`);
                // Continue without transformation on error - send original request
            }
        }
        
        // Create log entry for the request
        const protocol = req.url.startsWith('https://') ? 'https' : 'http';
        const logEntry: ProxyLogEntry = {
            id: this.generateLogId(),
            timestamp: Date.now(),
            method: req.method,
            url: req.url,
            requestHeaders: { ...req.headers } as Record<string, string | string[]>,
            requestBody: req.body?.buffer ? req.body.buffer.toString('utf8') : undefined,
            protocol: protocol,
            ruleApplied: modifications.length > 0 ? {
                ruleId: rule.id,
                ruleIndex: ruleIndex,
                originalUrl: originalUrl !== req.url ? originalUrl : undefined,
                modifications: modifications
            } : undefined
        };
        
        this.addLogEntry(logEntry);
        this.emit('request', logEntry);
        this.emit('log-updated', logEntry);
        
        // Return modified request data in correct Mockttp format
        const result: any = {};
        
        if (modifiedUrl !== originalUrl) {
            result.url = modifiedUrl;
            this.addDebugLog(`   📤 Returning modified URL`);
        }
        
        if (modifiedBody !== undefined) {
            result.body = JSON.stringify(modifiedBody);
            this.addDebugLog(`   📤 Returning modified body (${result.body.length} bytes)`);
        }
        
        // If no modifications, return original request unchanged
        if (Object.keys(result).length === 0) {
            this.addDebugLog(`   ⚠️  No modifications applied - returning original`);
            this.addDebugLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
            return req;
        }
        
        this.addDebugLog(`   ✅ Modifications complete: ${Object.keys(result).join(', ')}`);
        this.addDebugLog(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        return result;
    }
}
