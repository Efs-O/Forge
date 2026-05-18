import type { ChatCompletionRequest, StreamChunk, ToolCall } from './types';

export type TokenHandler = (token: string) => void;
export type ReasoningHandler = (token: string) => void;
export type DoneHandler = (finishReason: string | null) => void;
export type ErrorHandler = (err: Error) => void;
export type ToolCallsHandler = (calls: ToolCall[]) => void;

export interface StreamHandlers {
  onToken: TokenHandler;
  onReasoning?: ReasoningHandler;
  onDone: DoneHandler;
  onError: ErrorHandler;
  /** Fired before onDone when streamed tool deltas completed (finish_reason tool_calls or stop). */
  onToolCalls?: ToolCallsHandler;
}

/** Some servers (including some Ollama OpenAI-compat paths) emit `finish_reason: ""` on interim chunks — must not terminate the stream. */
function hasTerminalFinishReason(finishReason: string | null | undefined): finishReason is string {
  return typeof finishReason === 'string' && finishReason.trim().length > 0;
}

/** Partial delta shape for a streamed tool call. index is stream-only. */
interface ToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

/**
 * Sends a streaming chat completion request to an OpenAI-compatible endpoint
 * and dispatches tokens via callbacks. Uses native fetch + ReadableStream — no
 * additional HTTP library needed.
 */
export async function streamChatCompletion(
  baseUrl: string,
  request: ChatCompletionRequest,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: signal ?? null,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      handlers.onDone('cancelled');
    } else {
      handlers.onError(err instanceof Error ? err : new Error(String(err)));
    }
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    handlers.onError(new Error(`HTTP ${response.status}: ${body}`));
    return;
  }

  if (!response.body) {
    handlers.onError(new Error('Response body is null'));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // key = index, accumulates partial tool call fragments
  const toolAccum = new Map<number, { id: string; name: string; arguments: string }>();

  const flushAccumulatedToolCalls = (): void => {
    if (!handlers.onToolCalls || toolAccum.size === 0) return;
    const calls: ToolCall[] = [...toolAccum.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, acc]) => ({
        id: acc.id,
        type: 'function' as const,
        function: { name: acc.name, arguments: acc.arguments },
      }));
    handlers.onToolCalls(calls);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') {
          // Some backends (notably Ollama OpenAI-compat) end streams here without a prior
          // finish_reason chunk carrying tool_calls — flush any accumulated deltas first.
          flushAccumulatedToolCalls();
          handlers.onDone(null);
          return;
        }

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        const content = delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          handlers.onToken(content);
        } else if (
          typeof delta?.reasoning_content === 'string' &&
          delta.reasoning_content.length > 0
        ) {
          if (handlers.onReasoning) handlers.onReasoning(delta.reasoning_content);
          else handlers.onToken(delta.reasoning_content);
        } else if (
          typeof delta?.reasoning === 'string' &&
          delta.reasoning.length > 0
        ) {
          if (handlers.onReasoning) handlers.onReasoning(delta.reasoning);
          else handlers.onToken(delta.reasoning);
        }

        // Accumulate streamed tool_call fragments by index.
        const deltaToolCalls = (choice.delta as { tool_calls?: ToolCallDelta[] }).tool_calls;
        if (deltaToolCalls) {
          for (const tc of deltaToolCalls) {
            const idx = tc.index ?? 0;
            if (!toolAccum.has(idx)) {
              toolAccum.set(idx, { id: '', name: '', arguments: '' });
            }
            const acc = toolAccum.get(idx)!;
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          }
        }

        if (hasTerminalFinishReason(choice.finish_reason)) {
          // Ollama often emits finish_reason "stop" on the terminal chunk even when tool_calls
          // were streamed (OpenAI-style servers usually send "tool_calls"). Flush whenever we
          // have accumulated tool deltas so Forge can still dispatch native tools.
          flushAccumulatedToolCalls();
          handlers.onDone(choice.finish_reason);
          return;
        }
      }
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      handlers.onDone('cancelled');
    } else {
      handlers.onError(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    reader.releaseLock();
  }
}
