export interface McpMessage {
  id: string;
  type: 'request' | 'response' | 'notification';
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'agent';
  content: string;
  timestamp: Date;
  type: 'text' | 'system';
}

export interface McpServerConfig {
  name: string;
  description: string;
  version: string;
  capabilities: {
    chat: boolean;
    tools: boolean;
    resources: boolean;
  };
}

export interface HumanAgentSession {
  id: string;
  name: string;
  isActive: boolean;
  lastActivity: Date;
  messages: ChatMessage[];
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface HumanAgentChatToolParams {
  message: string;
  context?: string;
  sessionId?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  timeout?: number;
}

export interface HumanAgentChatToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
}