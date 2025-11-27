import { EventEmitter } from 'events';
import * as Mockttp from 'mockttp';

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

    constructor() {
        super();
    }

    /**
     * Start the proxy server on a dynamic port
     */
    async start(): Promise<number> {
        if (this.isRunning) {
            console.log('[ProxyServer] Already running');
            return this.port;
        }

        try {
            // Create Mockttp instance
            this.mockttpServer = Mockttp.getLocal({
                cors: true,
                recordTraffic: false // We'll handle logging ourselves
            });

            // Set up request/response interceptors
            await this.mockttpServer.forAnyRequest().thenPassThrough({
                beforeRequest: async (req) => {
                    const logEntry: ProxyLogEntry = {
                        id: this.generateLogId(),
                        timestamp: Date.now(),
                        method: req.method,
                        url: req.url,
                        requestHeaders: { ...req.headers } as Record<string, string | string[]>,
                        requestBody: req.body?.buffer ? req.body.buffer.toString('utf8') : undefined
                    };

                    // Store entry temporarily (will be completed on response)
                    this.addLogEntry(logEntry);
                    this.emit('request', logEntry);
                },
                beforeResponse: async (res) => {
                    // Find the matching log entry and update with response data
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
}
