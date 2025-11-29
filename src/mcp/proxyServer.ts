import { EventEmitter } from 'events';
import * as Mockttp from 'mockttp';
import * as fs from 'fs';
import * as path from 'path';
// JSONata will be imported dynamically when needed

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
    private maxLogs: number = 200; // FIFO buffer size
    private isRunning: boolean = false;
    private httpsOptions?: { keyPath: string; certPath: string };
    private rules: any[] = []; // Proxy rules loaded from storage

    constructor() {
        super();
    }

    /**
     * Start the proxy server on a dynamic port with optional HTTPS support
     * @param httpsOptions Optional HTTPS configuration with keyPath and certPath
     */
    async start(httpsOptions?: { keyPath: string; certPath: string }): Promise<number> {
        if (this.isRunning) {
            console.log('[ProxyServer] Already running');
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
                console.log(`[ProxyServer] HTTPS enabled with CA cert from: ${httpsOptions.certPath}`);
            }

            // Create Mockttp instance
            this.mockttpServer = Mockttp.getLocal(config);

            // Set up rule-based handlers
            await this.setupRuleHandlers();
            
            // Catch-all handler for requests not matching any rules
            await this.mockttpServer.forAnyRequest().thenPassThrough({
                beforeRequest: async (req) => {
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
                },
                beforeResponse: async (res) => {
                    const logEntry = this.logs[this.logs.length - 1];
                    if (logEntry) {
                        logEntry.responseStatus = res.statusCode;
                        logEntry.responseHeaders = { ...res.headers } as Record<string, string | string[]>;
                        logEntry.responseBody = res.body?.buffer ? res.body.buffer.toString('utf8') : undefined;
                        logEntry.duration = Date.now() - logEntry.timestamp;

                        this.emit('response', logEntry);
                        this.emit('log-updated', logEntry);
                    }
                }
            });

            // Start server on dynamic port
            await this.mockttpServer.start();
            this.port = this.mockttpServer.port;
            this.isRunning = true;

            console.log(`[ProxyServer] Started on port ${this.port}`);
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
            console.log('[ProxyServer] Stopped');
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
        if (!text) return '';
        const words = text.toString().trim().split(/\s+/);
        if (words.length <= wordCount) return text;
        return words.slice(0, wordCount).join(' ') + '...';
    }

    /**
     * Reload proxy rules (called when rules are updated in storage)
     * Requires restarting the proxy to apply new handlers
     */
    async reloadRules(): Promise<void> {
        console.log('[ProxyServer] Reloading proxy rules...');
        
        if (!this.isRunning) {
            console.log('[ProxyServer] Proxy not running, skipping rule reload');
            return;
        }
        
        // Restart proxy to apply new rules
        const port = this.port;
        const httpsOpts = this.httpsOptions;
        
        await this.stop();
        await this.start(httpsOpts);
        
        console.log(`[ProxyServer] Proxy restarted with updated rules on port ${port}`);
    }

    /**
     * Set proxy rules from external storage
     * @param rules Array of rule objects with id, pattern, redirect, jsonata, enabled
     */
    setRules(rules: any[]): void {
        this.rules = rules;
        console.log(`[ProxyServer] Set ${rules.length} proxy rules`);
    }

    /**
     * Get current proxy rules
     */
    getRules(): any[] {
        return [...this.rules];
    }

    /**
     * Set up Mockttp handlers for each enabled rule
     */
    private async setupRuleHandlers(): Promise<void> {
        if (!this.mockttpServer) return;
        
        const enabledRules = this.rules.filter(r => r.enabled);
        console.log(`[ProxyServer] Setting up ${enabledRules.length} enabled proxy rules`);
        
        for (let i = 0; i < enabledRules.length; i++) {
            const rule = enabledRules[i];
            // Find the actual index in the full rules list (1-based for display)
            const ruleIndex = this.rules.findIndex(r => r.id === rule.id) + 1;
            
            try {
                const urlPattern = new RegExp(rule.pattern);
                
                // Match requests by URL pattern - check if we should drop the request
                if (rule.dropRequest) {
                    // Drop the request with configurable status code
                    const dropStatusCode = rule.dropStatusCode || 204; // Default to 204 No Content
                    await this.mockttpServer.forAnyRequest()
                        .matching((req) => urlPattern.test(req.url))
                        .thenCallback(async (req) => {
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
                            
                            // Return the drop response
                            return {
                                statusCode: dropStatusCode,
                                statusMessage: dropStatusCode === 204 ? 'No Content' : 'Not Found',
                                headers: {},
                                body: ''
                            };
                        });
                } else {
                    // Normal request processing with potential modifications
                    await this.mockttpServer.forAnyRequest()
                        .matching((req) => urlPattern.test(req.url))
                        .thenPassThrough({
                            beforeRequest: async (req) => {
                            const originalUrl = req.url;
                            const modifications: string[] = [];
                            let modifiedUrl = req.url;
                            let modifiedBody: any = undefined;
                            
                            // Apply URL redirect if specified
                            if (rule.redirect) {
                                // Simple replacement for now - could be enhanced with capture groups
                                modifiedUrl = req.url.replace(urlPattern, rule.redirect);
                                modifications.push(`URL: ${originalUrl} → ${modifiedUrl} (Rule: ${rule.name || 'Unnamed'})`);
                            }
                            
                            // Apply JSONata transformation if specified
                            if (rule.jsonata && req.body?.buffer) {
                                try {
                                    const bodyText = req.body.buffer.toString('utf8');
                                    let bodyJson: any;
                                    
                                    // Try parsing as JSON, if it fails try JSONL
                                    try {
                                        bodyJson = JSON.parse(bodyText);
                                    } catch {
                                        // Try JSONL format (multiple JSON objects)
                                        const lines = bodyText.trim().split('\n');
                                        if (lines.length > 1) {
                                            bodyJson = lines.map(line => JSON.parse(line.trim()));
                                        } else {
                                            throw new Error('Invalid JSON format');
                                        }
                                    }
                                    
                                    // Apply JSONata transformation using dynamic import
                                    const JSONata = (await import('jsonata')).default;
                                    const expression = JSONata(rule.jsonata);
                                    const transformedData = await expression.evaluate(bodyJson);
                                    
                                    if (transformedData !== undefined) {
                                        modifiedBody = transformedData;
                                        modifications.push(`JSONata: Applied transformation "${rule.jsonata.length > 30 ? rule.jsonata.substring(0, 30) + '...' : rule.jsonata}" (Rule: ${rule.name || 'Unnamed'})`);
                                    }
                                } catch (error) {
                                    console.error(`[ProxyServer] Failed to apply JSONata transformation for rule ${ruleIndex}:`, error);
                                    // Continue without transformation on error - send original request
                                }
                            }
                            
                            // Support legacy JSONPath rules for backward compatibility
                            if (rule.jsonPath && rule.replacement && req.body?.buffer && !rule.jsonata) {
                                try {
                                    console.warn(`[ProxyServer] Using legacy JSONPath rule - consider upgrading to JSONata`);
                                    const bodyText = req.body.buffer.toString('utf8');
                                    const bodyJson = JSON.parse(bodyText);
                                    
                                    // Simple nested property replacement (basic legacy support)
                                    const path = rule.jsonPath.replace(/^\$\./, '').split('.');
                                    let obj = bodyJson;
                                    for (let i = 0; i < path.length - 1; i++) {
                                        if (obj && typeof obj === 'object') {
                                            obj = obj[path[i]];
                                        }
                                    }
                                    if (obj && typeof obj === 'object' && path.length > 0) {
                                        const oldValue = obj[path[path.length - 1]];
                                        obj[path[path.length - 1]] = rule.replacement;
                                        modifiedBody = bodyJson;
                                        modifications.push(`Legacy JSON: ${rule.jsonPath} = "${oldValue}" → "${rule.replacement}" (Rule: ${rule.name || 'Unnamed'})`);
                                    }
                                } catch (error) {
                                    console.error(`[ProxyServer] Failed to apply legacy JSONPath for rule ${ruleIndex}:`, error);
                                }
                            }
                            
                            // Prepare hover info for tooltip
                            let hoverInfo: { originalText: string; replacementText: string } | undefined;
                            if (modifications.length > 0) {
                                // Check for URL modification first (redirect)
                                const urlMod = modifications.find(mod => mod.startsWith('URL:'));
                                if (urlMod) {
                                    // Extract from: URL: originalUrl → modifiedUrl
                                    const match = urlMod.match(/URL: (.*?) → (.*?)$/);
                                    if (match && match.length >= 3) {
                                        hoverInfo = {
                                            originalText: this.truncateToWords(match[1], 10),
                                            replacementText: this.truncateToWords(match[2], 10)
                                        };
                                        console.log(`[ProxyServer] Debug - URL hover info created:`, hoverInfo);
                                    }
                                } else {
                                    // Check for JSONata transformation
                                    const jsonataMod = modifications.find(mod => mod.startsWith('JSONata:'));
                                    if (jsonataMod) {
                                        // For JSONata transformations, show before/after JSON snippets
                                        try {
                                            const originalJson = req.body?.buffer ? JSON.parse(req.body.buffer.toString('utf8')) : {};
                                            const modifiedJson = modifiedBody;
                                            hoverInfo = {
                                                originalText: this.truncateToWords(JSON.stringify(originalJson), 15),
                                                replacementText: this.truncateToWords(JSON.stringify(modifiedJson), 15)
                                            };
                                        } catch (error) {
                                            // Fallback to transformation description
                                            hoverInfo = {
                                                originalText: 'Original data',
                                                replacementText: 'JSONata transformed'
                                            };
                                        }
                                    } else {
                                        // Extract original and replacement text from legacy JSON modification
                                        const jsonMod = modifications.find(mod => mod.startsWith('Legacy JSON:'));
                                        console.log(`[ProxyServer] Debug - Legacy JSON modification found:`, jsonMod);
                                        if (jsonMod) {
                                            // Match: Legacy JSON: path = "oldValue" → "newValue"
                                            const match = jsonMod.match(/Legacy JSON: .* = "(.*?)" → "(.*?)"/);
                                            console.log(`[ProxyServer] Debug - Legacy JSON match result:`, match);
                                            if (match && match.length >= 3) {
                                                hoverInfo = {
                                                    originalText: this.truncateToWords(match[1], 10),
                                                    replacementText: this.truncateToWords(match[2], 10)
                                                };
                                                console.log(`[ProxyServer] Debug - Legacy JSON hover info created:`, hoverInfo);
                                            }
                                        }
                                    }
                                }
                            }
                            
                            // Log the request with rule applied
                            const protocol = originalUrl.startsWith('https://') ? 'https' : 'http';
                            const logEntry: ProxyLogEntry = {
                                id: this.generateLogId(),
                                timestamp: Date.now(),
                                method: req.method,
                                url: modifiedUrl, // Use modified URL for display
                                requestHeaders: { ...req.headers } as Record<string, string | string[]>,
                                requestBody: modifiedBody ? JSON.stringify(modifiedBody) : (req.body?.buffer ? req.body.buffer.toString('utf8') : undefined),
                                protocol: protocol,
                                ruleApplied: {
                                    ruleId: rule.id,
                                    ruleIndex: ruleIndex,
                                    originalUrl: modifiedUrl !== originalUrl ? originalUrl : undefined,
                                    modifications: modifications.length > 0 ? modifications : undefined,
                                    hoverInfo: hoverInfo
                                }
                            };
                            
                            this.addLogEntry(logEntry);
                            this.emit('request', logEntry);
                            
                            // Return modified request
                            return {
                                url: modifiedUrl,
                                json: modifiedBody
                            };
                        },
                        beforeResponse: async (res) => {
                            const logEntry = this.logs[this.logs.length - 1];
                            if (logEntry) {
                                logEntry.responseStatus = res.statusCode;
                                logEntry.responseHeaders = { ...res.headers } as Record<string, string | string[]>;
                                logEntry.responseBody = res.body?.buffer ? res.body.buffer.toString('utf8') : undefined;
                                logEntry.duration = Date.now() - logEntry.timestamp;

                                this.emit('response', logEntry);
                                this.emit('log-updated', logEntry);
                            }
                        }
                    });
                }
                
                console.log(`[ProxyServer] Rule #${ruleIndex} handler set up: ${rule.pattern} ${rule.dropRequest ? '(DROP)' : ''}`);
            } catch (error) {
                console.error(`[ProxyServer] Failed to set up rule #${ruleIndex}:`, error);
            }
        }
    }
}
