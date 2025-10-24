import { ChatMessage } from './types';

interface SessionState {
    sessionId: string;
    messages: ChatMessage[];
    pendingRequests: Map<string, any>; // requestId -> request data
    lastActivity: number;
    isActive: boolean;
}

export class ChatManager {
    private sessions: Map<string, SessionState> = new Map();
    private readonly maxMessagesPerSession: number = 50;
    private readonly sessionTimeoutMs: number = 24 * 60 * 60 * 1000; // 24 hours
    private logger?: any; // DebugLogger instance

    constructor(logger?: any) {
        this.logger = logger;
        this.log('INFO', 'ChatManager initialized with max ' + this.maxMessagesPerSession + ' messages per session');
        
        // Clean up inactive sessions periodically
        setInterval(() => this.cleanupInactiveSessions(), 60 * 60 * 1000); // Every hour
    }

    private log(level: string, message: string, data?: any): void {
        if (this.logger) {
            this.logger.log('CHAT', `[${level}] ${message}`, data);
        }
    }

    /**
     * Get or create a session
     */
    getSession(sessionId: string): SessionState {
        if (!this.sessions.has(sessionId)) {
            this.sessions.set(sessionId, {
                sessionId,
                messages: [],
                pendingRequests: new Map(),
                lastActivity: Date.now(),
                isActive: true
            });
        }
        
        const session = this.sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        return session;
    }

    /**
     * Add a message to session history
     */
    addMessage(sessionId: string, message: ChatMessage): void {
        const session = this.getSession(sessionId);
        
        // Add message to history
        session.messages.push(message);
        this.log('INFO', `Added message to session ${sessionId}: ${message.sender} - ${message.content.substring(0, 50)}...`);
        
        // Enforce message limit - remove oldest messages if exceeded
        if (session.messages.length > this.maxMessagesPerSession) {
            const toRemove = session.messages.length - this.maxMessagesPerSession;
            session.messages.splice(0, toRemove);
            this.log('INFO', `Cleaned up ${toRemove} old messages from session ${sessionId}, now has ${session.messages.length} messages`);
        }
        
        session.lastActivity = Date.now();
    }

    /**
     * Get all messages for a session
     */
    getMessages(sessionId: string): ChatMessage[] {
        const session = this.getSession(sessionId);
        return [...session.messages]; // Return copy to prevent external modification
    }

    /**
     * Add a pending human agent request
     */
    addPendingRequest(sessionId: string, requestId: string, requestData: any): void {
        const session = this.getSession(sessionId);
        session.pendingRequests.set(requestId, requestData);
        session.lastActivity = Date.now();
        this.log('INFO', `Added pending request ${requestId} to session ${sessionId}`);
    }

    /**
     * Remove a pending request (when responded to)
     */
    removePendingRequest(sessionId: string, requestId: string): boolean {
        const session = this.getSession(sessionId);
        const removed = session.pendingRequests.delete(requestId);
        if (removed) {
            session.lastActivity = Date.now();
            this.log('INFO', `Removed pending request ${requestId} from session ${sessionId}`);
        } else {
            this.log('WARN', `Attempted to remove non-existent pending request ${requestId} from session ${sessionId}`);
        }
        return removed;
    }

    /**
     * Get all pending requests for a session
     */
    getPendingRequests(sessionId: string): Map<string, any> {
        const session = this.getSession(sessionId);
        return new Map(session.pendingRequests); // Return copy
    }

    /**
     * Check if a session has any pending requests
     */
    hasPendingRequests(sessionId: string): boolean {
        const session = this.getSession(sessionId);
        return session.pendingRequests.size > 0;
    }

    /**
     * Get the most recent pending request for a session
     */
    getLatestPendingRequest(sessionId: string): { requestId: string; data: any } | null {
        const session = this.getSession(sessionId);
        if (session.pendingRequests.size === 0) {
            return null;
        }
        
        // Get the most recent pending request (last one added)
        const entries = Array.from(session.pendingRequests.entries());
        const [requestId, data] = entries[entries.length - 1];
        return { requestId, data };
    }

    /**
     * Find a pending request by ID across all sessions
     */
    findPendingRequest(requestId: string): { sessionId: string; data: any } | null {
        for (const [sessionId, session] of this.sessions.entries()) {
            if (session.pendingRequests.has(requestId)) {
                return {
                    sessionId,
                    data: session.pendingRequests.get(requestId)
                };
            }
        }
        return null;
    }

    /**
     * Get session state summary
     */
    getSessionState(sessionId: string): {
        sessionId: string;
        messageCount: number;
        pendingRequestCount: number;
        lastActivity: number;
        isActive: boolean;
        latestPendingRequest?: { requestId: string; data: any };
    } {
        const session = this.getSession(sessionId);
        const result: any = {
            sessionId: session.sessionId,
            messageCount: session.messages.length,
            pendingRequestCount: session.pendingRequests.size,
            lastActivity: session.lastActivity,
            isActive: session.isActive
        };

        const latestRequest = this.getLatestPendingRequest(sessionId);
        if (latestRequest) {
            result.latestPendingRequest = latestRequest;
        }

        return result;
    }

    /**
     * Get all active sessions
     */
    getActiveSessions(): string[] {
        return Array.from(this.sessions.keys()).filter(sessionId => {
            const session = this.sessions.get(sessionId)!;
            return session.isActive;
        });
    }

    /**
     * Deactivate a session
     */
    deactivateSession(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.isActive = false;
            session.lastActivity = Date.now();
        }
    }

    /**
     * Clean up old inactive sessions
     */
    private cleanupInactiveSessions(): void {
        const now = Date.now();
        const sessionsToDelete: string[] = [];

        for (const [sessionId, session] of this.sessions) {
            if (!session.isActive && (now - session.lastActivity) > this.sessionTimeoutMs) {
                sessionsToDelete.push(sessionId);
            }
        }

        for (const sessionId of sessionsToDelete) {
            this.sessions.delete(sessionId);
            this.log('INFO', `Cleaned up expired session: ${sessionId}`);
        }
    }

    /**
     * Get memory usage statistics
     */
    getMemoryStats(): {
        totalSessions: number;
        activeSessions: number;
        totalMessages: number;
        totalPendingRequests: number;
    } {
        let totalMessages = 0;
        let totalPendingRequests = 0;
        let activeSessions = 0;

        for (const session of this.sessions.values()) {
            totalMessages += session.messages.length;
            totalPendingRequests += session.pendingRequests.size;
            if (session.isActive) {
                activeSessions++;
            }
        }

        return {
            totalSessions: this.sessions.size,
            activeSessions,
            totalMessages,
            totalPendingRequests
        };
    }
}