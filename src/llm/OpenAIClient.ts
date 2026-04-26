import type { ChatCompletionRequest, StreamChunk, ToolCall } from './types';

export type TokenHandler = (token: string) => void;
export type DoneHandler = (finishReason: string | null) => void;
export type ErrorHandler = (err: Error) => void;
export type ToolCallsHandler = (calls: ToolCall[]) => void;

export interface StreamHandlers {
  onToken: TokenHandler;
  onDone: DoneHandler;
  onError: ErrorHandler;
  /** Fired just before onDone when finish_reason is "tool_calls". */
  onToolCalls?: ToolCallsHandler;
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

        const content = choice.delta?.content;
        if (content) handlers.onToken(content);

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

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          if (choice.finish_reason === 'tool_calls' && handlers.onToolCalls && toolAccum.size > 0) {
            const calls: ToolCall[] = [...toolAccum.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, acc]) => ({
                id: acc.id,
                type: 'function' as const,
                function: { name: acc.name, arguments: acc.arguments },
              }));
            handlers.onToolCalls(calls);
          }
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
