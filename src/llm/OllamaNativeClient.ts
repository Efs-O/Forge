import type { ModelConfig } from '../config/types';
import { getLogger } from '../util/logger';
import type { ChatCompletionRequest, ChatMessage, ContentPart, ToolCall } from './types';
import type { StreamHandlers } from './OpenAIClient';

interface OllamaToolCallChunk {
  function?: {
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
  if (message.tool_calls?.length) {
    return {
      role: message.role,
      content: typeof message.content === 'string' ? message.content : '',
      tool_calls: message.tool_calls.map((call) => ({
        function: {
          name: call.function.name,
          arguments: parseToolArguments(call.function.arguments),
        },
      })),
    };
  }
  if (message.role === 'tool') {
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
    content: typeof message.content === 'string' ? message.content : '',
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

function accumulateToolCalls(
  chunks: OllamaToolCallChunk[] | undefined,
  toolAccum: Map<number, { name: string; arguments: string }>,
): void {
  if (!chunks?.length) return;
  chunks.forEach((toolCall, index) => {
    if (!toolAccum.has(index)) {
      toolAccum.set(index, { name: '', arguments: '' });
    }
    const acc = toolAccum.get(index)!;
    if (toolCall.function?.name) acc.name += toolCall.function.name;
    if (toolCall.function?.arguments !== undefined) {
      acc.arguments +=
        typeof toolCall.function.arguments === 'string'
          ? toolCall.function.arguments
          : JSON.stringify(toolCall.function.arguments);
    }
  });
}

function flushToolCalls(
  toolAccum: Map<number, { name: string; arguments: string }>,
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
  const toolAccum = new Map<number, { name: string; arguments: string }>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
          if (handlers.onReasoning) handlers.onReasoning(chunk.message.thinking);
          else handlers.onToken(chunk.message.thinking);
        }
        if (typeof chunk.message?.content === 'string' && chunk.message.content.length > 0) {
          handlers.onToken(chunk.message.content);
        }
        accumulateToolCalls(chunk.message?.tool_calls, toolAccum);

        if (chunk.done) {
          flushToolCalls(toolAccum, handlers.onToolCalls);
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
          if (handlers.onReasoning) handlers.onReasoning(trailing.message.thinking);
          else handlers.onToken(trailing.message.thinking);
        }
        if (typeof trailing.message?.content === 'string' && trailing.message.content.length > 0) {
          handlers.onToken(trailing.message.content);
        }
        accumulateToolCalls(trailing.message?.tool_calls, toolAccum);
        if (trailing.done) {
          flushToolCalls(toolAccum, handlers.onToolCalls);
          handlers.onDone(trailing.done_reason ?? null);
          return;
        }
      } catch {
        // ignore malformed trailing bytes
      }
    }
    flushToolCalls(toolAccum, handlers.onToolCalls);
    handlers.onDone(null);
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
