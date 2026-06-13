import type * as http from 'http';
import type { ChatMessage, ToolDefinition } from '../llm/types';
import { ProxyError, type ChatProxyFn } from '../llm/ControlChatProxy';

const MAX_BODY_BYTES = 64 * 1024;

/** Small HTTP/serialization helpers for the control server (kept out of
 *  ControlServer.ts so the route/lifecycle logic stays within the file budget). */

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function requireModel(body: Record<string, unknown>): string | null {
  const model = typeof body['model'] === 'string' ? body['model'].trim() : '';
  return model || null;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toOpenAiBase(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(u) ? u : `${u}/v1`;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Upper bound for POST /chat bodies — worker prompts carry large context. */
export const CHAT_BODY_BYTES = 1024 * 1024;

export interface ParsedChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_effort?: 'high' | 'medium' | 'low' | 'none';
  stop?: string | string[];
  tools?: ToolDefinition[];
}

const REASONING_EFFORTS = ['high', 'medium', 'low', 'none'] as const;

/** Minimal structural check — tools must be function-typed with a name, never a
 *  free-form blob (CLAUDE.md hard stop). Unknown-shaped entries reject the body. */
function isToolDefinitionArray(value: unknown): value is ToolDefinition[] {
  return (
    Array.isArray(value) &&
    value.every((t) => {
      if (typeof t !== 'object' || t === null) return false;
      const fn = (t as { type?: unknown; function?: unknown }).function;
      return (
        (t as { type?: unknown }).type === 'function' &&
        typeof fn === 'object' &&
        fn !== null &&
        typeof (fn as { name?: unknown }).name === 'string'
      );
    })
  );
}

/** Validate a POST /chat body. Returns the parsed request or an error string
 *  (caller maps to 400). Strict — unknown fields are ignored, never blobbed. */
export function parseChatRequest(body: Record<string, unknown>): ParsedChatRequest | string {
  const model = requireModel(body);
  if (!model) return 'model is required';
  const messages = body['messages'];
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  const out: ParsedChatRequest = { model, messages: messages as ChatMessage[] };
  for (const k of ['temperature', 'top_p', 'max_tokens'] as const) {
    if (typeof body[k] === 'number') out[k] = body[k] as number;
  }
  const effort = body['reasoning_effort'];
  if (typeof effort === 'string' && (REASONING_EFFORTS as readonly string[]).includes(effort)) {
    out.reasoning_effort = effort as 'high' | 'medium' | 'low' | 'none';
  }
  const stop = body['stop'];
  if (typeof stop === 'string' || (Array.isArray(stop) && stop.every((s) => typeof s === 'string'))) {
    out.stop = stop as string | string[];
  }
  const tools = body['tools'];
  if (tools !== undefined) {
    if (!isToolDefinitionArray(tools)) return 'tools must be an array of function tool definitions';
    out.tools = tools;
  }
  return out;
}

/** Run a POST /chat body through the proxy, mapping every outcome to an HTTP
 *  status. Kept here so ControlServer.ts stays within its file-size budget. */
export async function handleChat(
  proxy: ChatProxyFn | undefined,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!proxy) return { status: 501, body: { error: 'chat proxy not configured' } };
  const parsed = parseChatRequest(body);
  if (typeof parsed === 'string') return { status: 400, body: { error: parsed } };
  try {
    const out = await proxy(parsed);
    // OpenAI-compatible response shape so Relay reuses its `postChat` parsing
    // (choices[0].message.tool_calls) verbatim for cloud agentic workers.
    return {
      status: 200,
      body: {
        model: parsed.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: out.content,
              reasoning: out.reasoning,
              ...(out.toolCalls ? { tool_calls: out.toolCalls } : {}),
            },
            finish_reason: out.finishReason,
          },
        ],
      },
    };
  } catch (err) {
    if (err instanceof ProxyError) return { status: err.status, body: { error: err.message } };
    return { status: 502, body: { error: errText(err) } };
  }
}

export function readJson(
  req: http.IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      data += chunk.toString();
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
