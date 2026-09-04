import type { ChatCompletionRequest, ChatMessage, StreamChunk, ToolCall } from './types';
import {
  ToolCallTruncatedError,
  argumentsAreIncomplete,
  isTruncationParseError,
  parseErrorColumn,
} from './ToolCallTruncatedError';
import { imageUnsupportedMessage, isImageUnsupportedError } from './imageUnsupportedError';
import { getLogger } from '../util/logger';

const log = getLogger();
let requestSequence = 0;

function requestTarget(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return '<invalid-url>';
  }
}

function messageStats(request: ChatCompletionRequest): {
  chars: number;
  imageParts: number;
  toolCalls: number;
} {
  let chars = 0;
  let imageParts = 0;
  let toolCalls = 0;
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      chars += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') chars += part.text.length;
        else imageParts += 1;
      }
    }
    toolCalls += message.tool_calls?.length ?? 0;
  }
  return { chars, imageParts, toolCalls };
}

/**
 * Reduce a ChatMessage to the fields the OpenAI chat-completions wire format
 * defines. `ChatMessage` also carries sidebar-only bookkeeping — `reasoning`,
 * `reasoningMs`, `toolMs`, `internal` — that Forge persists for its own UI and
 * agent loop but must never send upstream. llama-server and Ollama silently
 * drop unknown fields; strict validators (Cerebras) reject the whole request
 * with `wrong_api_format`, e.g. `messages.2.assistant.reasoningMs: property ...
 * is unsupported`. Whitelisting the wire fields keeps every provider happy.
 */
function toWireMessage(message: ChatMessage): ChatMessage {
  const wire: ChatMessage = { role: message.role, content: message.content };
  if (message.tool_call_id !== undefined) wire.tool_call_id = message.tool_call_id;
  if (message.name !== undefined) wire.name = message.name;
  if (message.tool_calls !== undefined) wire.tool_calls = message.tool_calls;
  return wire;
}

function toWireRequest(request: ChatCompletionRequest): ChatCompletionRequest {
  return { ...request, messages: request.messages.map(toWireMessage) };
}

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
  const requestId = ++requestSequence;
  const startedAt = Date.now();
  const stats = messageStats(request);
  const target = requestTarget(baseUrl);
  log.info(
    `[OpenAIClient] request start id=${requestId} target=${target} model=${request.model} ` +
      `messages=${request.messages.length} message_chars=${stats.chars} ` +
      `image_parts=${stats.imageParts} prior_tool_calls=${stats.toolCalls} ` +
      `tools=${request.tools?.length ?? 0} max_tokens=${request.max_tokens ?? '?'} ` +
      `reasoning_effort=${request.reasoning_effort ?? '?'}`,
  );
  let response: Response;
  const headerWatchdog = setTimeout(() => {
    log.warn(
      `[OpenAIClient] request still waiting for response headers id=${requestId} ` +
        `target=${target} elapsed_ms=${Date.now() - startedAt}`,
    );
  }, 15_000);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(toWireRequest(request)),
      signal: signal ?? null,
    });
  } catch (err) {
    clearTimeout(headerWatchdog);
    if ((err as Error)?.name === 'AbortError') {
      log.info(
        `[OpenAIClient] request aborted id=${requestId} elapsed_ms=${Date.now() - startedAt}`,
      );
      handlers.onDone('cancelled');
    } else {
      log.error(
        `[OpenAIClient] request transport failure id=${requestId} ` +
          `elapsed_ms=${Date.now() - startedAt}`,
        err,
      );
      handlers.onError(err instanceof Error ? err : new Error(String(err)));
    }
    return;
  }
  clearTimeout(headerWatchdog);

  log.info(
    `[OpenAIClient] response headers id=${requestId} status=${response.status} ` +
      `content_type=${response.headers.get('content-type') ?? '?'} ` +
      `elapsed_ms=${Date.now() - startedAt}`,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const boundedBody = body.length > 4_000 ? `${body.slice(0, 4_000)}…` : body;
    const msg = `HTTP ${response.status}: ${boundedBody}`;
    log.error(`[OpenAIClient] request failed id=${requestId} target=${target} — ${msg}`);
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
    // Same server, same 500, different cause: no mmproj. Nothing to retry.
    if (isImageUnsupportedError(body)) {
      handlers.onError(new Error(imageUnsupportedMessage(request.model, response.status)));
      return;
    }
    handlers.onError(new Error(msg));
    return;
  }

  if (!response.body) {
    log.error(`[OpenAIClient] response body missing id=${requestId}`);
    handlers.onError(new Error('Response body is null'));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalFinishReason: string | null = null;
  let toolCallsFlushed = false;
  let readCount = 0;
  let sseFrameCount = 0;
  let bytesRead = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let toolDeltaCount = 0;
  let firstByteAt: number | null = null;
  let lastActivityAt = Date.now();
  let streamStallWarned = false;
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const idleMs = now - lastActivityAt;
    const heartbeatLine =
      `[OpenAIClient] stream heartbeat id=${requestId} elapsed_ms=${now - startedAt} ` +
      `idle_ms=${idleMs} reads=${readCount} sse_frames=${sseFrameCount} ` +
      `bytes=${bytesRead} text_chars=${textChars} reasoning_chars=${reasoningChars} ` +
      `tool_deltas=${toolDeltaCount}`;
    if (idleMs >= 15_000 && !streamStallWarned) {
      streamStallWarned = true;
      log.warn(heartbeatLine);
    } else {
      log.debug(heartbeatLine);
    }
  }, 15_000);
  const streamSummary = (): string =>
    `id=${requestId} elapsed_ms=${Date.now() - startedAt} ` +
    `ttfb_ms=${firstByteAt === null ? '?' : firstByteAt - startedAt} reads=${readCount} ` +
    `sse_frames=${sseFrameCount} bytes=${bytesRead} text_chars=${textChars} ` +
    `reasoning_chars=${reasoningChars} tool_deltas=${toolDeltaCount} ` +
    `finish_reason=${terminalFinishReason ?? '?'}`;
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
      readCount += 1;
      bytesRead += value.byteLength;
      lastActivityAt = Date.now();
      streamStallWarned = false;
      firstByteAt ??= lastActivityAt;

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
        sseFrameCount += 1;
        if (data === '[DONE]') {
          // Some backends (notably Ollama OpenAI-compat) end streams here without a prior
          // finish_reason chunk carrying tool_calls — flush any accumulated deltas first.
          flushAccumulatedToolCalls();
          log.info(`[OpenAIClient] stream done ${streamSummary()}`);
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
          log.error(`[OpenAIClient] stream error frame ${streamSummary()} — ${detail}`);
          if (isTruncationParseError(detail)) {
            const column = parseErrorColumn(detail);
            handlers.onError(
              new ToolCallTruncatedError({
                finishReason: 'length',
                ...(column !== undefined ? { approxBytes: column } : {}),
                message: detail,
              }),
            );
          } else if (isImageUnsupportedError(detail)) {
            // No status: the stream is already HTTP 200 and the frame carries none.
            handlers.onError(new Error(imageUnsupportedMessage(request.model)));
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
          textChars += content.length;
          handlers.onToken(content);
        } else if (
          typeof delta?.reasoning_content === 'string' &&
          delta.reasoning_content.length > 0
        ) {
          reasoningChars += delta.reasoning_content.length;
          if (handlers.onReasoning) handlers.onReasoning(delta.reasoning_content);
          else handlers.onToken(delta.reasoning_content);
        } else if (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) {
          reasoningChars += delta.reasoning.length;
          if (handlers.onReasoning) handlers.onReasoning(delta.reasoning);
          else handlers.onToken(delta.reasoning);
        }

        // Accumulate streamed tool_call fragments by index.
        const deltaToolCalls = (choice.delta as { tool_calls?: ToolCallDelta[] }).tool_calls;
        if (deltaToolCalls) {
          for (const tc of deltaToolCalls) {
            toolDeltaCount += 1;
            const idx = tc.index ?? 0;
            if (!toolAccum.has(idx)) {
              toolAccum.set(idx, { id: '', name: '', arguments: '' });
            }
            const acc = toolAccum.get(idx)!;
            if (tc.id) acc.id = tc.id;
            // Only `arguments` is streamed in fragments; the name arrives whole
            // in the delta that opens the call. Appending every name delta
            // assumed otherwise, so a provider that repeats the name on each
            // chunk produced "search_codesearch_code" — an unknown tool, and a
            // wasted round, every single time (measured on gemma4:31b-cloud).
            // Genuine fragmentation still concatenates: only a repeat of what
            // is already accumulated is dropped.
            const incomingName = tc.function?.name;
            if (incomingName && !acc.name.includes(incomingName)) acc.name += incomingName;
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
            log.warn(
              `[OpenAIClient] truncated tool call ${streamSummary()} ` +
                `tool=${truncated.name || '?'} approx_arg_chars=${truncated.arguments.length}`,
            );
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
    log.warn(`[OpenAIClient] stream ended without terminal frame ${streamSummary()}`);
    handlers.onDone(terminalFinishReason);
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      log.info(`[OpenAIClient] stream aborted ${streamSummary()}`);
      handlers.onDone('cancelled');
    } else {
      log.error(`[OpenAIClient] stream failure ${streamSummary()}`, err);
      handlers.onError(err instanceof Error ? err : new Error(String(err)));
    }
  } finally {
    clearInterval(heartbeat);
    reader.releaseLock();
  }
}
