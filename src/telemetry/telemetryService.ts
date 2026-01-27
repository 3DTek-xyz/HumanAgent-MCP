import * as vscode from 'vscode';
import * as crypto from 'crypto';

/**
 * Telemetry service for tracking anonymous usage metrics via Google Analytics 4
 */
export class TelemetryService {
    private readonly GA_MEASUREMENT_ID = 'G-87BY4Y6NMK';
    private readonly GA_API_SECRET = '_5nnRhGLTdKkllpkf88wsA';
    private readonly GA_ENDPOINT = 'https://www.google-analytics.com/mp/collect';
    
    private clientId: string;
    private installDate: string;
    private context: vscode.ExtensionContext;
    
    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        
        // Get or create persistent client ID
        let storedClientId = context.globalState.get<string>('telemetry_client_id');
        if (!storedClientId) {
            storedClientId = crypto.randomUUID();
            context.globalState.update('telemetry_client_id', storedClientId);
            
            // Store install date
            const installDate = new Date().toISOString();
            context.globalState.update('telemetry_install_date', installDate);
        }
        
        this.clientId = storedClientId;
        this.installDate = context.globalState.get<string>('telemetry_install_date') || new Date().toISOString();
    }
    
    /**
     * Check if telemetry is enabled (respects VS Code's telemetry setting)
     */
    private isTelemetryEnabled(): boolean {
        return vscode.env.isTelemetryEnabled;
    }
    
    /**
     * Calculate days since installation
     */
    private getDaysSinceInstall(): number {
        const install = new Date(this.installDate);
        const now = new Date();
        const diffTime = Math.abs(now.getTime() - install.getTime());
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        return diffDays;
    }
    
    /**
     * Get common event parameters included in all events
     */
    private getCommonParams(): Record<string, any> {
        const packageJson = this.context.extension.packageJSON;
        
        // Get timezone and region info
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const locale = vscode.env.language || 'en';
        
        return {
            extension_version: packageJson.version,
            vscode_version: vscode.version,
            platform: process.platform,
            install_date: this.installDate.split('T')[0], // Just the date part
            days_since_install: this.getDaysSinceInstall(),
            timezone: timezone,
            locale: locale,
            region: this.getRegionFromTimezone(timezone)
        };
    }
    
    /**
     * Infer region from timezone (privacy-friendly geographic data)
     */
    private getRegionFromTimezone(timezone: string): string {
        // Map common timezones to regions
        const regionMap: Record<string, string> = {
            // North America
            'America/New_York': 'North America',
            'America/Chicago': 'North America', 
            'America/Denver': 'North America',
            'America/Los_Angeles': 'North America',
            'America/Toronto': 'North America',
            'America/Vancouver': 'North America',
            
            // Europe
            'Europe/London': 'Europe',
            'Europe/Paris': 'Europe',
            'Europe/Berlin': 'Europe',
            'Europe/Rome': 'Europe',
            'Europe/Madrid': 'Europe',
            'Europe/Amsterdam': 'Europe',
            'Europe/Stockholm': 'Europe',
            'Europe/Zurich': 'Europe',
            
            // Asia Pacific
            'Asia/Tokyo': 'Asia Pacific',
            'Asia/Shanghai': 'Asia Pacific',
            'Asia/Singapore': 'Asia Pacific',
            'Asia/Seoul': 'Asia Pacific',
            'Asia/Mumbai': 'Asia Pacific',
            'Australia/Sydney': 'Asia Pacific',
            'Australia/Melbourne': 'Asia Pacific',
            
            // Other regions
            'Africa/Cairo': 'Africa/Middle East',
            'Asia/Dubai': 'Africa/Middle East',
            'America/Sao_Paulo': 'South America',
            'America/Mexico_City': 'North America'
        };
        
        // Try exact match first
        if (regionMap[timezone]) {
            return regionMap[timezone];
        }
        
        // Try continent-based matching
        if (timezone.startsWith('America/')) return 'Americas';
        if (timezone.startsWith('Europe/')) return 'Europe';
        if (timezone.startsWith('Asia/')) return 'Asia Pacific';
        if (timezone.startsWith('Australia/')) return 'Asia Pacific';
        if (timezone.startsWith('Africa/')) return 'Africa/Middle East';
        
        return 'Other';
    }
    
    /**
     * Send an event to GA4
     */
    private async sendEvent(eventName: string, eventParams: Record<string, any> = {}): Promise<void> {
        if (!this.isTelemetryEnabled()) {
            return; // Respect user's privacy settings
        }
        
        try {
            const payload = {
                client_id: this.clientId,
                events: [{
                    name: eventName,
                    params: {
                        ...this.getCommonParams(),
                        ...eventParams
                    }
                }]
            };
            
            const url = `${this.GA_ENDPOINT}?measurement_id=${this.GA_MEASUREMENT_ID}&api_secret=${this.GA_API_SECRET}`;
            
            await fetch(url, {
                method: 'POST',
                body: JSON.stringify(payload),
                headers: {
                    'Content-Type': 'application/json'
                }
            });
        } catch (error) {
            // Silently fail - don't interrupt user experience for telemetry failures
            console.error('Telemetry error:', error);
        }
    }
    
    // Extension lifecycle events
    async trackExtensionActivated(): Promise<void> {
        await this.sendEvent('extension_activated', {
            // Additional geographic context
            is_new_install: this.getDaysSinceInstall() === 0,
            architecture: process.arch,
            node_version: process.version
        });
    }
    
    // New install tracking (first activation only)
    async trackFirstTimeUser(): Promise<void> {
        if (this.getDaysSinceInstall() === 0) {
            await this.sendEvent('first_time_user', {
                install_timestamp: this.installDate
            });
        }
    }
    
    async trackExtensionDeactivated(): Promise<void> {
        await this.sendEvent('extension_deactivated');
    }
    
    // Chat events
    async trackChatOpened(source: 'tree_view' | 'command_palette' | 'other'): Promise<void> {
        await this.sendEvent('chat_opened', { source });
    }
    
    async trackMessageSent(messageLength: number, sessionId: string): Promise<void> {
        await this.sendEvent('message_sent', { 
            message_length: messageLength,
            session_id: sessionId 
        });
    }
    
    async trackMessageReceived(messageLength: number, sessionId: string): Promise<void> {
        await this.sendEvent('message_received', { 
            message_length: messageLength,
            session_id: sessionId 
        });
    }
    
    // MCP tool events
    async trackToolCalled(toolName: string, sessionId: string): Promise<void> {
        await this.sendEvent('tool_called', { 
            tool_name: toolName,
            session_id: sessionId 
        });
    }
    
    // Error events
    async trackError(errorType: 'server_error' | 'connection_error' | 'other', errorMessage: string): Promise<void> {
        // Only send error type and sanitized message (no sensitive data)
        const sanitizedMessage = errorMessage.substring(0, 100); // Truncate
        await this.sendEvent('error_occurred', { 
            error_type: errorType,
            error_message: sanitizedMessage
        });
    }
    
    // Session events
    async trackSessionStarted(sessionId: string): Promise<void> {
        await this.sendEvent('session_started', { session_id: sessionId });
    }
    
    async trackSessionEnded(sessionId: string, messageCount: number, durationMs: number): Promise<void> {
        await this.sendEvent('session_ended', { 
            session_id: sessionId,
            message_count: messageCount,
            duration_seconds: Math.floor(durationMs / 1000)
        });
    }
    
    // Weekly usage tracking (for better retention analysis)
    async trackWeeklyActive(): Promise<void> {
        const weekKey = `weekly_active_${Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000))}`;
        const hasTrackedThisWeek = this.context.globalState.get<boolean>(weekKey);
        
        if (!hasTrackedThisWeek) {
            await this.sendEvent('weekly_active_user');
            this.context.globalState.update(weekKey, true);
        }
    }
    
    // Daily usage summary (aggregated stats)
    async trackDailyUsage(sessionsCount: number, totalMessages: number): Promise<void> {
        await this.sendEvent('daily_usage_summary', {
            sessions_today: sessionsCount,
            messages_today: totalMessages,
            week_of_year: Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000))
        });
    }
}
