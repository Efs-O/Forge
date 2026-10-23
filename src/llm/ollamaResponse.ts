import type { StreamHandlers } from './OpenAIClient';

export interface OllamaToolCallChunk {
  function?: {
    /** Ollama's own call slot. Unreliable: see `accumulateToolCalls`. */
    index?: number;
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

export interface OllamaStreamChunk {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: OllamaToolCallChunk[];
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
  /** Ollama's own token counters, present on the `done: true` frame. */
  prompt_eval_count?: number;
  eval_count?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  total_duration?: number;
}

export function safeResponseBody(body: string): string {
  return body
    .replace(/(authorization|api[_-]?key|token|secret)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[REDACTED]')
    .slice(0, 4_000);
}

/** Normalize Ollama's final counts into the shared OpenAI usage shape. */
export function reportOllamaUsage(
  chunk: OllamaStreamChunk,
  handlers: StreamHandlers,
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined {
  const prompt = chunk.prompt_eval_count;
  const completion = chunk.eval_count;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined;
  const usage = {
    prompt_tokens: prompt as number,
    completion_tokens: completion as number,
    total_tokens: (prompt as number) + (completion as number),
  };
  handlers.onUsage?.(usage);
  return usage;
}
