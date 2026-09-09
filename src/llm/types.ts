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

/** A file a prompt carried, stored on disk by `ChatAttachmentStore`. */
export interface ChatAttachmentRef {
  name: string;
  mediaType: string;
  bytes: number;
  /** POSIX-joined `<conversationId>/<file>`, relative to the store root. */
  relativePath: string;
}

export interface ChatMessage {
  role: Role;
  /** May be null on assistant messages that carry tool_calls without text. */
  content: string | ContentPart[] | null;
  /** Optional reasoning/thinking text shown in the sidebar but never sent back to the model. */
  reasoning?: string;
  /**
   * How long the reasoning stream ran, and how long a tool call took. Measured
   * by the host, which is the only side that sees both ends: the webview's own
   * stamps are live-only and are erased the moment a session sync rebuilds the
   * transcript from disk.
   */
  reasoningMs?: number;
  toolMs?: number;
  /**
   * Wall-clock time a tool result was produced, epoch ms. Set once at creation
   * so the model-facing clock stamp derived from it never changes under the KV
   * cache -- see `stampToolResultClocks`.
   */
  stampedAt?: number;
  /**
   * Files this user turn carried, as on-disk references (see
   * `ChatAttachmentStore`). Forge-only, like `reasoning`: no provider
   * serializer reads it, and it holds no bytes, so it is safe to persist.
   */
  attachments?: ChatAttachmentRef[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
  /** Retained for model context and persistence, but not rendered in the sidebar. */
  internal?: boolean;
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
