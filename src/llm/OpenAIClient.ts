import type { ChatCompletionRequest, StreamChunk, ToolCall } from './types';
import {
  ToolCallTruncatedError,
  isTruncationParseError,
  parseErrorColumn,
} from './ToolCallTruncatedError';
import { StreamedToolCallAccumulator, type ToolCallDelta } from './StreamedToolCallAccumulator';
import { imageUnsupportedMessage, isImageUnsupportedError } from './imageUnsupportedError';
import { getLogger } from '../util/logger';
import { withDescribedCause } from '../util/describeError';
import { StreamWatchdog } from './streamWatchdog';
import { createStallProbe } from './stallProbe';
import { toWireRequest } from './wireRequest';
import {
  createRequestClientClock,
  createRequestStatsReporter,
  type RequestStatsHandler,
} from '../sessions/requestStats';

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

type TokenHandler = (token: string) => void;
type ReasoningHandler = (token: string) => void;
type DoneHandler = (finishReason: string | null) => void;
type ErrorHandler = (err: Error) => void;
type ToolCallsHandler = (calls: ToolCall[]) => void;
export interface ToolCallProgress {
  index: number;
  id: string;
  name: string;
  argChars: number;
  argDeltas: number;
  arguments: string;
}
export type ToolCallProgressHandler = (progress: ToolCallProgress) => void;
export type UsageHandler = (usage: NonNullable<StreamChunk['usage']>) => void;

export interface StreamHandlers {
  onToken: TokenHandler;
  onReasoning?: ReasoningHandler;
  onDone: DoneHandler;
  onError: ErrorHandler;
  /** Fired before onDone when streamed tool deltas completed (finish_reason tool_calls or stop). */
  onToolCalls?: ToolCallsHandler;
  /** Argument-fragment progress, throttled per call with a final event on close. */
  onToolCallProgress?: ToolCallProgressHandler;
  /** Exact usage emitted by servers when stream_options.include_usage is enabled. */
  onUsage?: UsageHandler;
  /** Numbers-only request stats plus the exact body already sent to fetch. */
  onRequestStats?: RequestStatsHandler;
}

/** Some servers (including some Ollama OpenAI-compat paths) emit `finish_reason: ""` on interim chunks — must not terminate the stream. */
function hasTerminalFinishReason(finishReason: string | null | undefined): finishReason is string {
  return typeof finishReason === 'string' && finishReason.trim().length > 0;
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
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const requestId = ++requestSequence;
  const startedAt = Date.now();
  const stats = messageStats(request);
  const target = requestTarget(baseUrl);
  const requestUrl = `${baseUrl}/v1/chat/completions`;
  const requestBody = JSON.stringify(toWireRequest(request));
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
  const sentAtMs = Date.now();
  const clientClock = createRequestClientClock();
  let terminalFinishReason: string | null = null;
  const reporter = createRequestStatsReporter({
    body: requestBody,
    url: requestUrl,
    model: request.model,
    sentAtMs,
    clientClock,
    handler: handlers.onRequestStats,
    isAborted: () => Boolean(signal?.aborted),
    onCallbackError: (error) =>
      log.warn(
        `[OpenAIClient] request stats callback failed id=${requestId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  const complete = (finishReason: string | null): void => {
    if (finishReason) terminalFinishReason = finishReason;
    reporter.complete(finishReason);
    handlers.onDone(finishReason);
  };
  const fail = (error: Error): void => {
    reporter.fail(error);
    handlers.onError(error);
  };
  try {
    response = await fetchImpl(requestUrl, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: signal ?? null,
    });
  } catch (err) {
    clearTimeout(headerWatchdog);
    if ((err as Error)?.name === 'AbortError') {
      log.info(
        `[OpenAIClient] request aborted id=${requestId} elapsed_ms=${Date.now() - startedAt}`,
      );
      complete('cancelled');
    } else {
      log.error(
        `[OpenAIClient] request transport failure id=${requestId} ` +
          `elapsed_ms=${Date.now() - startedAt}`,
        err,
      );
      fail(withDescribedCause(err));
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
      fail(
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
      fail(new Error(imageUnsupportedMessage(request.model, response.status)));
      return;
    }
    fail(new Error(msg));
    return;
  }

  if (!response.body) {
    log.error(`[OpenAIClient] response body missing id=${requestId}`);
    fail(new Error('Response body is null'));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let readCount = 0;
  let sseFrameCount = 0;
  let bytesRead = 0;
  let textChars = 0;
  let reasoningChars = 0;
  const streamSummary = (): string =>
    `id=${requestId} elapsed_ms=${Date.now() - startedAt} ` +
    `ttfb_ms=${watchdog.ttfbMs ?? '?'} reads=${readCount} ` +
    `sse_frames=${sseFrameCount} bytes=${bytesRead} text_chars=${textChars} ` +
    `reasoning_chars=${reasoningChars} tool_deltas=${toolCalls.deltas} ` +
    `finish_reason=${terminalFinishReason ?? '?'}`;
  const watchdog = new StreamWatchdog(
    '[OpenAIClient]',
    startedAt,
    streamSummary,
    () => void reader.cancel().catch(() => undefined),
    fail,
    createStallProbe(baseUrl, fetchImpl),
  );
  // key = index, accumulates partial tool call fragments
  const toolCalls = new StreamedToolCallAccumulator(
    handlers.onToolCallProgress,
    handlers.onToolCalls,
  );

  /**
   * Turn an accumulated call that cannot have arrived whole into the typed
   * recovery, whichever frame ended the stream — `[DONE]`, a terminal
   * `finish_reason`, or the connection simply closing. `strict` is a `length`
   * finish; see `StreamedToolCallAccumulator.incompleteCall`.
   */
  const raiseIncompleteCall = (reason: string | null, strict: boolean): boolean => {
    const cut = toolCalls.incompleteCall(strict);
    if (!cut) return false;
    log.warn(
      `[OpenAIClient] truncated tool call ${streamSummary()} ` +
        `tool=${cut.name || '?'} approx_arg_chars=${cut.arguments.length}`,
    );
    fail(
      new ToolCallTruncatedError({
        toolName: cut.name,
        toolCallId: cut.id,
        partialArguments: cut.arguments,
        ...(reason ? { finishReason: reason } : {}),
      }),
    );
    return true;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > 0) clientClock.firstByte();
      readCount += 1;
      bytesRead += value.byteLength;
      watchdog.activity();

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
        clientClock.chunk();
        if (data === '[DONE]') {
          // Some backends (notably Ollama OpenAI-compat) end streams here without a prior
          // finish_reason chunk carrying tool_calls — flush any accumulated deltas first.
          if (raiseIncompleteCall(terminalFinishReason, false)) return;
          toolCalls.flush();
          log.info(`[OpenAIClient] stream done ${streamSummary()}`);
          complete(terminalFinishReason);
          return;
        }

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          fail(
            new Error(
              `OpenAI-compatible stream sent malformed JSON (${data.slice(0, 200)}); the reply was stopped there.`,
            ),
          );
          return;
        }

        // Error frames carry no `choices`, so the old `if (!choice) continue`
        // discarded them. Check before that guard, not after.
        const framed = (chunk as { error?: { message?: string; code?: number } }).error;
        if (framed) {
          const detail = framed.message ?? JSON.stringify(framed);
          log.error(`[OpenAIClient] stream error frame ${streamSummary()} — ${detail}`);
          if (isTruncationParseError(detail)) {
            const column = parseErrorColumn(detail);
            fail(
              new ToolCallTruncatedError({
                finishReason: 'length',
                ...(column !== undefined ? { approxBytes: column } : {}),
                message: detail,
              }),
            );
          } else if (isImageUnsupportedError(detail)) {
            // No status: the stream is already HTTP 200 and the frame carries none.
            fail(new Error(imageUnsupportedMessage(request.model)));
          } else {
            fail(new Error(detail));
          }
          return;
        }

        const usage = chunk.usage;
        if (usage !== undefined) reporter.setUsage(usage);
        if (chunk.timings !== undefined) reporter.setTimings(chunk.timings);
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
        const content = typeof delta?.content === 'string' ? delta.content : '';
        if (content.length > 0) {
          watchdog.delta('content');
          clientClock.firstToken();
          textChars += content.length;
          handlers.onToken(content);
        }
        // Content and reasoning are separate channels, so a single delta can
        // carry both; the old `if / else if` dropped the reasoning half of the
        // pair. The two reasoning spellings are alternatives, never both, so
        // one provider's text is never counted or emitted twice.
        const reasoning =
          typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0
            ? delta.reasoning_content
            : typeof delta?.reasoning === 'string' && delta.reasoning.length > 0
              ? delta.reasoning
              : '';
        if (reasoning.length > 0) {
          watchdog.delta('reasoning');
          clientClock.firstToken();
          reasoningChars += reasoning.length;
          if (handlers.onReasoning) handlers.onReasoning(reasoning);
          else handlers.onToken(reasoning);
        }

        // Accumulate streamed tool_call fragments by index.
        const deltaToolCalls = (choice.delta as { tool_calls?: ToolCallDelta[] }).tool_calls;
        if (deltaToolCalls) {
          if (StreamedToolCallAccumulator.carriesArguments(deltaToolCalls)) {
            watchdog.delta('tool_args');
          }
          toolCalls.apply(deltaToolCalls);
        }

        if (hasTerminalFinishReason(choice.finish_reason)) {
          // A `length` finish with tool deltas still in flight means generation
          // hit the output ceiling mid-arguments. Flushing that dispatched a
          // half-written call — in practice `{}` — which the dispatcher then
          // reported as malformed, hiding the real cause. Args that still parse
          // are complete and safe to flush, whatever the finish reason says.
          if (raiseIncompleteCall(choice.finish_reason, choice.finish_reason === 'length')) {
            return;
          }
          // Ollama often emits finish_reason "stop" on the terminal chunk even when tool_calls
          // were streamed (OpenAI-style servers usually send "tool_calls"). Flush whenever we
          // have accumulated tool deltas so Forge can still dispatch native tools.
          toolCalls.flush();
          terminalFinishReason = choice.finish_reason;
        }
      }
    }
    if (watchdog.stalled) return;
    // Stream ended without [DONE] or a terminal finish_reason (server crash or
    // dropped connection) — settle anyway so the agent loop never hangs.
    if (raiseIncompleteCall(terminalFinishReason, false)) return;
    toolCalls.flush();
    log.warn(`[OpenAIClient] stream ended without terminal frame ${streamSummary()}`);
    complete(terminalFinishReason);
  } catch (err) {
    if (watchdog.stalled) return;
    if ((err as Error)?.name === 'AbortError') {
      log.info(`[OpenAIClient] stream aborted ${streamSummary()}`);
      complete('cancelled');
    } else {
      log.error(`[OpenAIClient] stream failure ${streamSummary()}`, err);
      fail(withDescribedCause(err));
    }
  } finally {
    watchdog.stop();
    reader.releaseLock();
  }
}
