export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  /** null only on assistant messages that carry tool_calls instead of text. */
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatDelta {
  role?: Role;
  content?: string | null;
  tool_calls?: ToolCall[];
}

export interface StreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  choices: Array<{
    index: number;
    delta: ChatDelta;
    finish_reason: string | null;
  }>;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  max_tokens?: number;
  seed?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  repeat_penalty?: number;
  tools?: ToolDefinition[];
  chat_template_kwargs?: Record<string, unknown>;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type Mode = 'ask' | 'plan' | 'execute';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
