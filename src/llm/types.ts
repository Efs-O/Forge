export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ContentPartText {
  type: 'text';
  text: string;
}
export interface ContentPartImage {
  type: 'image_url';
  image_url: { url: string };
}
export type ContentPart = ContentPartText | ContentPartImage;

export interface ChatMessage {
  role: Role;
  /** May be null on assistant messages that carry tool_calls without text. */
  content: string | ContentPart[] | null;
  /** Optional reasoning/thinking text shown in the sidebar but never sent back to the model. */
  reasoning?: string;
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
  /** OpenAI-compat reasoning models sometimes stream assistant text here instead of `content`. */
  reasoning_content?: string | null;
  /** Ollama cloud models may stream reasoning here instead of `reasoning_content`. */
  reasoning?: string | null;
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
  /** Present in the final stream frame when stream_options.include_usage is enabled. */
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
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
  repeat_last_n?: number;
  stop?: string | string[];
  reasoning_effort?: 'high' | 'medium' | 'low' | 'none';
  tools?: ToolDefinition[];
  chat_template_kwargs?: Record<string, unknown>;
  stream_options?: { include_usage?: boolean };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
