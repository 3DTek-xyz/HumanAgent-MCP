import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';

export interface ServerManagerOptions {
    serverPath: string;
    port: number;
    host?: string;
    logFile?: string;
}

export class ServerManager {
    private static instance: ServerManager | undefined;
    private options: ServerManagerOptions;
    private readonly pidFile: string;
    private readonly logFile?: string;

    private constructor(options: ServerManagerOptions) {
        this.options = {
            host: '127.0.0.1',
            ...options
        };
        this.pidFile = path.join(path.dirname(options.serverPath), '.humanagent-mcp-server.pid');
        this.logFile = options.logFile;
    }

    public static getInstance(options?: ServerManagerOptions): ServerManager {
        if (!ServerManager.instance) {
            if (!options) {
                throw new Error('ServerManager options required for first initialization');
            }
            ServerManager.instance = new ServerManager(options);
        }
        return ServerManager.instance;
    }

    /**
     * Check if the server is already running by testing the port
     */
    public async isServerRunning(): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            
            socket.setTimeout(1000);
            socket.on('connect', () => {
                socket.destroy();
                resolve(true);
            });
            
            socket.on('timeout', () => {
                socket.destroy();
                resolve(false);
            });
            
            socket.on('error', () => {
                resolve(false);
            });
            
            socket.connect(this.options.port, this.options.host!);
        });
    }

    /**
     * Check if there's a PID file and if that process is still running
     */
    private async isProcessRunning(pid: number): Promise<boolean> {
        try {
            // On Unix systems, sending signal 0 checks if process exists
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Get the PID from the PID file if it exists
     */
    private async getStoredPid(): Promise<number | undefined> {
        try {
            if (fs.existsSync(this.pidFile)) {
                const pidStr = fs.readFileSync(this.pidFile, 'utf-8').trim();
                const pid = parseInt(pidStr, 10);
                return isNaN(pid) ? undefined : pid;
            }
        } catch (error) {
            console.log('Error reading PID file:', error);
        }
        return undefined;
    }

    /**
     * Store the PID in the PID file
     */
    private async storePid(pid: number): Promise<void> {
        try {
            fs.writeFileSync(this.pidFile, pid.toString());
        } catch (error) {
            console.error('Error writing PID file:', error);
        }
    }

    /**
     * Clean up the PID file
     */
    private async cleanupPidFile(): Promise<void> {
        try {
            if (fs.existsSync(this.pidFile)) {
                fs.unlinkSync(this.pidFile);
            }
        } catch (error) {
            console.log('Error cleaning up PID file:', error);
        }
    }

    /**
     * Log a message to the log file
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}\n`;
        
        if (this.logFile) {
            try {
                fs.appendFileSync(this.logFile, logMessage);
            } catch (error) {
                console.error('Error writing to log file:', error);
            }
        }
    }

    /**
     * Start the server if it's not already running
     */
    public async ensureServerRunning(): Promise<boolean> {
        try {
            // First check if server is responding on the port
            if (await this.isServerRunning()) {
                this.log('Server is already running and responding');
                return true;
            }

            // Check if we have a stored PID and if that process is running
            const storedPid = await this.getStoredPid();
            if (storedPid && await this.isProcessRunning(storedPid)) {
                this.log(`Found running server process with PID ${storedPid}, but it's not responding on port. Waiting...`);
                // Wait a moment for the server to start listening
                await new Promise(resolve => setTimeout(resolve, 2000));
                if (await this.isServerRunning()) {
                    this.log('Server is now responding');
                    return true;
                }
            }

            // Clean up stale PID file
            await this.cleanupPidFile();

            // Start new server process
            this.log(`Starting new server process: node ${this.options.serverPath}`);
            return await this.startServer();
            
        } catch (error) {
            this.log(`Error ensuring server is running: ${error}`);
            vscode.window.showErrorMessage(`Failed to start HumanAgent MCP Server: ${error}`);
            return false;
        }
    }

    /**
     * Start the server as a truly independent detached process
     */
    private async startServer(): Promise<boolean> {
        try {
            // Spawn the server as a completely detached process
            const serverProcess = spawn('node', [this.options.serverPath], {
                detached: true,
                stdio: 'ignore', // Completely disconnect stdio to make it independent
                cwd: path.dirname(this.options.serverPath),
                env: {
                    ...process.env,
                    // Add any environment variables needed by the server
                }
            });

            // Store the PID but don't keep a reference to the process
            if (serverProcess.pid) {
                this.storePid(serverProcess.pid);
                this.log(`Started independent server with PID ${serverProcess.pid}`);
            } else {
                this.log('Failed to get server process PID');
                return false;
            }

            // Immediately detach and unreference the process for complete independence
            serverProcess.unref();
            
            this.log('Server process started as independent background process and immediately detached');

            // Return true immediately - the server will start independently
            // Actual server health will be verified by separate health checks later
            return true;

        } catch (error) {
            this.log(`Failed to start server: ${error}`);
            return false;
        }
    }

    /**
     * Stop the server if it's running
     */
    public async stopServer(): Promise<boolean> {
        try {
            const storedPid = await this.getStoredPid();
            
            if (storedPid) {
                if (await this.isProcessRunning(storedPid)) {
                    this.log(`Stopping independent server with PID ${storedPid}`);
                    process.kill(storedPid, 'SIGTERM');
                    
                    // Wait for graceful shutdown
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Force kill if still running
                    if (await this.isProcessRunning(storedPid)) {
                        this.log(`Force killing independent server with PID ${storedPid}`);
                        process.kill(storedPid, 'SIGKILL');
                        
                        // Wait a bit more and check again
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        if (await this.isProcessRunning(storedPid)) {
                            this.log(`Warning: Server process ${storedPid} may still be running`);
                        }
                    }
                } else {
                    this.log(`Server process ${storedPid} was not running`);
                }
                
                await this.cleanupPidFile();
            } else {
                this.log('No PID file found, server may not be running');
            }

            this.log('Server stop operation completed');
            return true;
            
        } catch (error) {
            this.log(`Error stopping server: ${error}`);
            return false;
        }
    }

    /**
     * Get server status information
     */
    public async getServerStatus(): Promise<{
        isRunning: boolean;
        pid?: number;
        port: number;
        host: string;
        serverPath: string;
    }> {
        const isRunning = await this.isServerRunning();
        const pid = await this.getStoredPid();
        
        return {
            isRunning,
            pid: pid && await this.isProcessRunning(pid) ? pid : undefined,
            port: this.options.port,
            host: this.options.host!,
            serverPath: this.options.serverPath
        };
    }

    /**
     * Clean up resources when the extension deactivates
     */
    public dispose(): void {
        // Note: We don't stop the server here because it should continue running
        // even if the extension is deactivated. The server will be stopped only
        // when explicitly requested or when VS Code completely closes.
        this.log('ServerManager disposed');
    }
}