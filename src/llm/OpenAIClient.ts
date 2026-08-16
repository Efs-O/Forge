import type { ChatCompletionRequest, StreamChunk, ToolCall } from './types';
import {
  ToolCallTruncatedError,
  argumentsAreIncomplete,
  isTruncationParseError,
  parseErrorColumn,
} from './ToolCallTruncatedError';
import { getLogger } from '../util/logger';

const log = getLogger();

export type TokenHandler = (token: string) => void;
export type ReasoningHandler = (token: string) => void;
export type DoneHandler = (finishReason: string | null) => void;
export type ErrorHandler = (err: Error) => void;
export type ToolCallsHandler = (calls: ToolCall[]) => void;
export type UsageHandler = (usage: NonNullable<StreamChunk['usage']>) => void;

export interface StreamHandlers {
  onToken: TokenHandler;
  onReasoning?: ReasoningHandler;
  onDone: DoneHandler;
  onError: ErrorHandler;
  /** Fired before onDone when streamed tool deltas completed (finish_reason tool_calls or stop). */
  onToolCalls?: ToolCallsHandler;
  /** Exact usage emitted by servers when stream_options.include_usage is enabled. */
  onUsage?: UsageHandler;
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
  apiKey?: string,
): Promise<void> {
  let response: Response;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
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
    const msg = `HTTP ${response.status}: ${body}`;
    log.error(`[OpenAIClient] ${baseUrl} — ${msg}`);
    // llama-server answers 500 when its chat parser chokes on output that
    // stopped mid-argument. That is a size problem, not a protocol problem —
    // hand the caller a typed truncation so it retries smaller instead of
    // deciding the model cannot do native tool calls.
    if (isTruncationParseError(body)) {
      const column = parseErrorColumn(body);
      handlers.onError(
        new ToolCallTruncatedError({
          finishReason: 'length',
          ...(column !== undefined ? { approxBytes: column } : {}),
          message: msg,
        }),
      );
      return;
    }
    handlers.onError(new Error(msg));
    return;
  }

  if (!response.body) {
    handlers.onError(new Error('Response body is null'));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalFinishReason: string | null = null;
  let toolCallsFlushed = false;
  // key = index, accumulates partial tool call fragments
  const toolAccum = new Map<number, { id: string; name: string; arguments: string }>();

  const flushAccumulatedToolCalls = (): void => {
    if (toolCallsFlushed) return;
    toolCallsFlushed = true;
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
        // llama-server reports a late failure as an SSE frame, sometimes on an
        // `error:` line rather than `data:`. Skipping those ended the turn in
        // silence — no tokens, no message, no error.
        const isErrorLine = trimmed.startsWith('error:');
        if (!trimmed.startsWith('data:') && !isErrorLine) continue;

        const data = trimmed.slice(isErrorLine ? 6 : 5).trim();
        if (data === '[DONE]') {
          // Some backends (notably Ollama OpenAI-compat) end streams here without a prior
          // finish_reason chunk carrying tool_calls — flush any accumulated deltas first.
          flushAccumulatedToolCalls();
          handlers.onDone(terminalFinishReason);
          return;
        }

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          continue;
        }

        // Error frames carry no `choices`, so the old `if (!choice) continue`
        // discarded them. Check before that guard, not after.
        const framed = (chunk as { error?: { message?: string; code?: number } }).error;
        if (framed) {
          const detail = framed.message ?? JSON.stringify(framed);
          log.error(`[OpenAIClient] ${baseUrl} — stream error frame: ${detail}`);
          if (isTruncationParseError(detail)) {
            const column = parseErrorColumn(detail);
            handlers.onError(
              new ToolCallTruncatedError({
                finishReason: 'length',
                ...(column !== undefined ? { approxBytes: column } : {}),
                message: detail,
              }),
            );
          } else {
            handlers.onError(new Error(detail));
          }
          return;
        }

        const usage = chunk.usage;
        if (
          usage &&
          Number.isFinite(usage.prompt_tokens) &&
          Number.isFinite(usage.completion_tokens) &&
          Number.isFinite(usage.total_tokens)
        ) {
          handlers.onUsage?.(usage);
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
        } else if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) {
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
          // A `length` finish with tool deltas still in flight means generation
          // hit the output ceiling mid-arguments. Flushing that dispatched a
          // half-written call — in practice `{}` — which the dispatcher then
          // reported as malformed, hiding the real cause. Raise it as
          // truncation instead. Args that still parse are complete and safe to
          // flush, whatever the finish reason says.
          const truncated =
            choice.finish_reason === 'length'
              ? [...toolAccum.values()].find((acc) => argumentsAreIncomplete(acc.arguments))
              : undefined;
          if (truncated) {
            handlers.onError(
              new ToolCallTruncatedError({
                toolName: truncated.name,
                toolCallId: truncated.id,
                partialArguments: truncated.arguments,
                finishReason: choice.finish_reason,
              }),
            );
            return;
          }
          // Ollama often emits finish_reason "stop" on the terminal chunk even when tool_calls
          // were streamed (OpenAI-style servers usually send "tool_calls"). Flush whenever we
          // have accumulated tool deltas so Forge can still dispatch native tools.
          flushAccumulatedToolCalls();
          terminalFinishReason = choice.finish_reason;
        }
      }
    }
    // Stream ended without [DONE] or a terminal finish_reason (server crash or
    // dropped connection) — settle anyway so the agent loop never hangs.
    flushAccumulatedToolCalls();
    handlers.onDone(terminalFinishReason);
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
