import type { ModelConfig } from '../config/types';
import { getLogger } from '../util/logger';
import type { ChatCompletionRequest, ChatMessage, ContentPart, ToolCall } from './types';
import { wireMessageContent, type StreamHandlers } from './OpenAIClient';
import { StreamWatchdog } from './streamWatchdog';
import { withDescribedCause } from '../util/describeError';

interface OllamaToolCallChunk {
  function?: {
    /** Ollama's own call slot. Unreliable: see `accumulateToolCalls`. */
    index?: number;
    name?: string;
    arguments?: Record<string, unknown> | string;
  };
}

const log = getLogger();

function safeResponseBody(body: string): string {
  return body
    .replace(/(authorization|api[_-]?key|token|secret)(["'\s:=]+)[^\s,"'}]+/gi, '$1$2[REDACTED]')
    .slice(0, 4_000);
}

interface OllamaStreamChunk {
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
}

/**
 * Forward Ollama's token counters in the OpenAI `usage` shape.
 *
 * Ollama has no `stream_options.include_usage`; it puts the counts on the final
 * frame instead. Without this every context display — token bar, status bar,
 * HalluMeter bridge — and the auto-compaction trigger read 0 forever on an
 * Ollama model, because all of them refuse to substitute an estimate.
 */
function reportUsage(chunk: OllamaStreamChunk, handlers: StreamHandlers): void {
  const prompt = chunk.prompt_eval_count;
  const completion = chunk.eval_count;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return;
  handlers.onUsage?.({
    prompt_tokens: prompt as number,
    completion_tokens: completion as number,
    total_tokens: (prompt as number) + (completion as number),
  });
}

interface OllamaChatMessage {
  role: ChatMessage['role'];
  content: string;
  images?: string[];
  tool_name?: string;
  tool_calls?: Array<{
    function: {
      name: string;
      arguments: Record<string, unknown>;
    };
  }>;
}

function toOllamaThink(model: ModelConfig): boolean | 'high' | 'medium' | 'low' | undefined {
  if (model.think === false || model.reasoning_effort === 'none') return false;
  if (model.think === true) {
    if (
      model.reasoning_effort === 'high' ||
      model.reasoning_effort === 'medium' ||
      model.reasoning_effort === 'low'
    ) {
      return model.reasoning_effort;
    }
    return true;
  }
  return undefined;
}

function parseDataUrlImage(url: string): string | null {
  const match = /^data:image\/[^;]+;base64,(.+)$/i.exec(url);
  return match?.[1] ?? null;
}

function contentPartsToOllama(parts: ContentPart[]): { content: string; images?: string[] } {
  const textParts: string[] = [];
  const images: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      textParts.push(part.text);
      continue;
    }
    const image = parseDataUrlImage(part.image_url.url);
    if (image) {
      images.push(image);
    } else {
      textParts.push(`[image omitted: unsupported URL source ${part.image_url.url}]`);
    }
  }
  return {
    content: textParts.join('\n').trim(),
    ...(images.length > 0 ? { images } : {}),
  };
}

function parseToolArguments(argumentsJson: string): Record<string, unknown> {
  if (!argumentsJson.trim()) return {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to empty object so a malformed prior tool call does not break the request.
  }
  return {};
}

function toOllamaMessage(message: ChatMessage): OllamaChatMessage {
  const wireContent = wireMessageContent(message);
  if (message.tool_calls?.length) {
    return {
      role: message.role,
      content: typeof wireContent === 'string' ? wireContent : '',
      tool_calls: message.tool_calls.map((call) => ({
        function: {
          name: call.function.name,
          arguments: parseToolArguments(call.function.arguments),
        },
      })),
    };
  }
  if (message.role === 'tool') {
    if (Array.isArray(message.content)) {
      return {
        role: 'tool',
        ...contentPartsToOllama(message.content),
        ...(message.name ? { tool_name: message.name } : {}),
      };
    }
    return {
      role: 'tool',
      content: typeof message.content === 'string' ? message.content : '',
      ...(message.name ? { tool_name: message.name } : {}),
    };
  }
  if (Array.isArray(message.content)) {
    return { role: message.role, ...contentPartsToOllama(message.content) };
  }
  return {
    role: message.role,
    content: typeof wireContent === 'string' ? wireContent : '',
  };
}

function buildOllamaOptions(
  request: ChatCompletionRequest,
  model: ModelConfig,
): Record<string, unknown> | undefined {
  const repeatPenalty = request.repeat_penalty ?? request.repetition_penalty;
  const stop = Array.isArray(request.stop)
    ? request.stop
    : request.stop !== undefined
      ? [request.stop]
      : undefined;
  const options = {
    ...(model.num_ctx !== undefined ? { num_ctx: model.num_ctx } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.top_k !== undefined ? { top_k: request.top_k } : {}),
    ...(request.min_p !== undefined ? { min_p: request.min_p } : {}),
    ...(request.max_tokens !== undefined ? { num_predict: request.max_tokens } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
    ...(request.presence_penalty !== undefined
      ? { presence_penalty: request.presence_penalty }
      : {}),
    ...(request.frequency_penalty !== undefined
      ? { frequency_penalty: request.frequency_penalty }
      : {}),
    ...(repeatPenalty !== undefined ? { repeat_penalty: repeatPenalty } : {}),
    ...(request.repeat_last_n !== undefined ? { repeat_last_n: request.repeat_last_n } : {}),
    ...(stop !== undefined ? { stop } : {}),
  };
  return Object.keys(options).length > 0 ? options : undefined;
}

/** One tool call being rebuilt from stream frames. */
interface OllamaToolCallAccumulator {
  name: string;
  arguments: string;
}

/**
 * True when `value` is a whole argument object rather than a text fragment.
 *
 * Ollama's native API hands back parsed arguments (`map[string]any` in its own
 * `api.ToolCallFunction`), so an object means "this frame carries whole
 * arguments", while a string is what a fragmenting provider sends. That
 * difference is what makes a repeated tool name tellable apart from a new call.
 */
function argumentsAreWhole(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/** True when accumulated text is a complete, non-empty argument object. */
function argumentsAreComplete(argumentsText: string): boolean {
  if (!argumentsText || argumentsText === '{}') return false;
  try {
    JSON.parse(argumentsText);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when a frame opens a SECOND call in a slot that already holds one.
 *
 * Ollama's `function.index` cannot be trusted to separate calls: multiple tool
 * calls in one stream have been reported at index 0 (ollama/ollama#15457,
 * #16212). Keying on index alone merged them into one call whose arguments were
 * the two payloads concatenated — an unparseable call, and the second call
 * never ran. A different name, or a whole argument object that differs from the
 * complete one already in the slot, is a new call; a name arriving over an empty
 * or partial slot is the same call's header arriving again.
 */
function opensNewCall(
  acc: OllamaToolCallAccumulator,
  incomingName: string | undefined,
  incomingArguments: unknown,
): boolean {
  if (incomingName && acc.name && acc.name !== incomingName) return true;
  return (
    argumentsAreWhole(incomingArguments) &&
    argumentsAreComplete(acc.arguments) &&
    JSON.stringify(incomingArguments) !== acc.arguments
  );
}

/** Next slot key past `from` that no accumulated call occupies. */
function freeSlotKey(toolAccum: Map<number, OllamaToolCallAccumulator>, from: number): number {
  let key = from;
  while (toolAccum.has(key)) key += 1;
  return key;
}

function accumulateToolCalls(
  chunks: OllamaToolCallChunk[] | undefined,
  toolAccum: Map<number, OllamaToolCallAccumulator>,
): void {
  if (!chunks?.length) return;
  chunks.forEach((toolCall, position) => {
    const incomingName = toolCall.function?.name;
    const incomingArguments = toolCall.function?.arguments;
    const declaredIndex = toolCall.function?.index ?? position;
    let key = declaredIndex;
    const current = toolAccum.get(key);
    if (current && opensNewCall(current, incomingName, incomingArguments)) {
      key = freeSlotKey(toolAccum, declaredIndex);
    }
    if (!toolAccum.has(key)) {
      toolAccum.set(key, { name: '', arguments: '' });
    }
    const acc = toolAccum.get(key)!;
    // Only `arguments` fragments across frames; the name arrives whole in the
    // frame that opens the call. Appending every name frame assumed otherwise,
    // so a provider that repeats the name produced "search_codesearch_code" —
    // an unknown tool, every time. Genuine fragmentation still concatenates:
    // only a repeat of what is already accumulated is dropped.
    if (incomingName && !acc.name.includes(incomingName)) acc.name += incomingName;
    if (incomingArguments !== undefined) {
      if (typeof incomingArguments === 'string') {
        acc.arguments += incomingArguments;
      } else {
        // Whole-object arguments repair or confirm the slot, never concatenate:
        // two `{...}` payloads glued together are not parseable JSON.
        const incomingText = JSON.stringify(incomingArguments);
        if (!argumentsAreComplete(acc.arguments) || incomingText === acc.arguments) {
          acc.arguments = incomingText;
        }
      }
    }
  });
}

function flushToolCalls(
  toolAccum: Map<number, OllamaToolCallAccumulator>,
  onToolCalls: StreamHandlers['onToolCalls'],
): void {
  if (!onToolCalls || toolAccum.size === 0) return;
  const calls: ToolCall[] = [...toolAccum.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, acc]) => ({
      id: `call_ollama_${index}`,
      type: 'function',
      function: {
        name: acc.name,
        arguments: acc.arguments,
      },
    }));
  onToolCalls(calls);
}

export async function streamOllamaChatCompletion(
  baseUrl: string,
  request: ChatCompletionRequest,
  model: ModelConfig,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const options = buildOllamaOptions(request, model);
  const think = toOllamaThink(model);
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(toOllamaMessage),
        stream: true,
        ...(request.tools ? { tools: request.tools } : {}),
        ...(options ? { options } : {}),
        ...(think !== undefined ? { think } : {}),
      }),
      signal: signal ?? null,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      handlers.onDone('cancelled');
    } else {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(
        `[OllamaNativeClient] request failed endpoint=${baseUrl}/api/chat model=${request.model}: ${error.message}`,
      );
      handlers.onError(error);
    }
    return;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const safeBody = safeResponseBody(body);
    const message = `HTTP ${response.status}: ${safeBody}`;
    log.error(
      `[OllamaNativeClient] request failed endpoint=${baseUrl}/api/chat model=${request.model}: ${message}`,
    );
    handlers.onError(new Error(message));
    return;
  }

  if (!response.body) {
    handlers.onError(new Error('Response body is null'));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolAccum = new Map<number, OllamaToolCallAccumulator>();
  let readCount = 0;
  let bytesRead = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let toolDeltaCount = 0;
  // Same idle budget as the OpenAI route (FIRST_BYTE_STALL_TIMEOUT_MS /
  // STREAM_STALL_TIMEOUT_MS, owned by streamWatchdog). Without it a model that
  // wedged after its headers left the turn hanging: no tokens, no error, no
  // way out but a restart.
  const streamSummary = (): string =>
    `[OllamaNativeClient] model=${request.model} elapsed_ms=${Date.now() - startedAt} ` +
    `ttfb_ms=${watchdog.ttfbMs ?? '?'} reads=${readCount} bytes=${bytesRead} ` +
    `text_chars=${textChars} reasoning_chars=${reasoningChars} tool_deltas=${toolDeltaCount}`;
  const watchdog = new StreamWatchdog(
    '[OllamaNativeClient]',
    startedAt,
    streamSummary,
    () => void reader.cancel().catch(() => undefined),
    (err) => handlers.onError(err),
  );

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      readCount += 1;
      bytesRead += value.byteLength;
      watchdog.activity();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let chunk: OllamaStreamChunk;
        try {
          chunk = JSON.parse(trimmed) as OllamaStreamChunk;
        } catch {
          continue;
        }

        if (chunk.error) {
          handlers.onError(new Error(chunk.error));
          return;
        }

        if (typeof chunk.message?.thinking === 'string' && chunk.message.thinking.length > 0) {
          reasoningChars += chunk.message.thinking.length;
          if (handlers.onReasoning) handlers.onReasoning(chunk.message.thinking);
          else handlers.onToken(chunk.message.thinking);
        }
        if (typeof chunk.message?.content === 'string' && chunk.message.content.length > 0) {
          textChars += chunk.message.content.length;
          handlers.onToken(chunk.message.content);
        }
        toolDeltaCount += chunk.message?.tool_calls?.length ?? 0;
        accumulateToolCalls(chunk.message?.tool_calls, toolAccum);

        if (chunk.done) {
          flushToolCalls(toolAccum, handlers.onToolCalls);
          reportUsage(chunk, handlers);
          handlers.onDone(chunk.done_reason ?? null);
          return;
        }
      }
    }

    if (buffer.trim()) {
      try {
        const trailing = JSON.parse(buffer.trim()) as OllamaStreamChunk;
        if (
          typeof trailing.message?.thinking === 'string' &&
          trailing.message.thinking.length > 0
        ) {
          reasoningChars += trailing.message.thinking.length;
          if (handlers.onReasoning) handlers.onReasoning(trailing.message.thinking);
          else handlers.onToken(trailing.message.thinking);
        }
        if (typeof trailing.message?.content === 'string' && trailing.message.content.length > 0) {
          textChars += trailing.message.content.length;
          handlers.onToken(trailing.message.content);
        }
        toolDeltaCount += trailing.message?.tool_calls?.length ?? 0;
        accumulateToolCalls(trailing.message?.tool_calls, toolAccum);
        if (trailing.done) {
          flushToolCalls(toolAccum, handlers.onToolCalls);
          reportUsage(trailing, handlers);
          handlers.onDone(trailing.done_reason ?? null);
          return;
        }
      } catch {
        // ignore malformed trailing bytes
      }
    }
    if (watchdog.stalled) return;
    flushToolCalls(toolAccum, handlers.onToolCalls);
    handlers.onDone(null);
  } catch (err) {
    if (watchdog.stalled) return;
    if ((err as Error)?.name === 'AbortError') {
      handlers.onDone('cancelled');
    } else {
      handlers.onError(withDescribedCause(err));
    }
  } finally {
    watchdog.stop();
    reader.releaseLock();
  }
}
