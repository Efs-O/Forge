/**
 * StructuredOutputParser - fallback parser for models that emit JSON-fenced
 * tool-call blocks or provider-specific tool markers instead of native
 * function-calling.
 *
 * Supported shapes inside a ```json block:
 *   { "tool": "tool_name",  "arguments": { ... } }
 *   { "name": "tool_name",  "arguments": { ... } }
 *   { "tool_name": { ... } }   (shorthand: single key whose value is an object)
 *
 * Supported marker syntax used by some Ollama-hosted/cloud models:
 *   <｜tool▁call▁begin｜>tool_name<｜tool▁sep｜>{"arg":"value"}<｜tool▁call▁end｜>
 */

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

const OLLAMA_TOOL_CALL_BEGIN = '<｜tool▁call▁begin｜>';
const OLLAMA_TOOL_CALL_SEP = '<｜tool▁sep｜>';
const OLLAMA_TOOL_CALL_END = '<｜tool▁call▁end｜>';
const OLLAMA_TOOL_CALLS_BEGIN = '<｜tool▁calls▁begin｜>';
const OLLAMA_TOOL_CALLS_END = '<｜tool▁calls▁end｜>';
const OLLAMA_TOOL_MARKERS = [
  OLLAMA_TOOL_CALL_BEGIN,
  OLLAMA_TOOL_CALL_SEP,
  OLLAMA_TOOL_CALL_END,
  OLLAMA_TOOL_CALLS_BEGIN,
  OLLAMA_TOOL_CALLS_END,
] as const;

// Matches ```json ... ``` blocks (non-greedy, case-insensitive fence)
const JSON_FENCE_RE = /```json\s*([\s\S]*?)```/gi;
const OLLAMA_TOOL_CALL_RE = new RegExp(
  `${escapeRegExp(OLLAMA_TOOL_CALL_BEGIN)}\\s*([\\w.-]+)\\s*${escapeRegExp(OLLAMA_TOOL_CALL_SEP)}\\s*([\\s\\S]*?)\\s*${escapeRegExp(OLLAMA_TOOL_CALL_END)}`,
  'gu',
);
const OLLAMA_TOOL_WRAPPER_RE = new RegExp(
  `${escapeRegExp(OLLAMA_TOOL_CALLS_BEGIN)}|${escapeRegExp(OLLAMA_TOOL_CALLS_END)}`,
  'gu',
);

/**
 * Scan `text` for ```json ... ``` blocks and attempt to parse each as a tool call.
 * Returns all valid tool calls found; silently skips malformed blocks.
 */
export function parseStructuredOutput(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  collectJsonFenceToolCalls(text, results);
  collectOllamaMarkerToolCalls(text, results);
  return results;
}

/**
 * Removes streamed tool-call marker payloads from visible assistant text while
 * preserving surrounding prose. This is intentionally marker-only: JSON-fenced
 * blocks are handled after the full response is available so normal JSON/code
 * snippets are not hidden mid-stream.
 */
export class StructuredOutputStripper {
  private carry = '';
  private hiddenDepth = 0;

  push(raw: string): string {
    const [processed, nextCarry] = stripCarry(raw, this.carry);
    this.carry = nextCarry;
    return this.consume(processed);
  }

  flush(): string {
    this.carry = '';
    return '';
  }

  private consume(content: string): string {
    let rest = content;
    const visible: string[] = [];

    while (rest) {
      const next = findNextToolMarker(rest);
      if (!next) {
        if (this.hiddenDepth === 0) visible.push(rest);
        return visible.join('');
      }

      const [pos, marker] = next;
      if (pos > 0 && this.hiddenDepth === 0) {
        visible.push(rest.slice(0, pos));
      }

      rest = rest.slice(pos + marker.length);
      if (marker === OLLAMA_TOOL_CALL_BEGIN || marker === OLLAMA_TOOL_CALLS_BEGIN) {
        this.hiddenDepth += 1;
      } else if (marker === OLLAMA_TOOL_CALL_END || marker === OLLAMA_TOOL_CALLS_END) {
        this.hiddenDepth = Math.max(0, this.hiddenDepth - 1);
      }
    }

    return visible.join('');
  }
}

export function stripStructuredOutputFromFullText(text: string): string {
  const withoutMarkers = text
    .replace(OLLAMA_TOOL_CALL_RE, '')
    .replace(OLLAMA_TOOL_WRAPPER_RE, '');

  return withoutMarkers.replace(JSON_FENCE_RE, (match, body: string) => (
    parseJsonToolObject(body.trim()) ? '' : match
  ));
}

function collectJsonFenceToolCalls(text: string, results: ParsedToolCall[]): void {
  let match: RegExpExecArray | null;
  JSON_FENCE_RE.lastIndex = 0;

  while ((match = JSON_FENCE_RE.exec(text)) !== null) {
    const candidate = parseJsonToolObject(match[1].trim());
    if (candidate) {
      results.push(candidate);
    }
  }
}

function collectOllamaMarkerToolCalls(text: string, results: ParsedToolCall[]): void {
  let match: RegExpExecArray | null;
  OLLAMA_TOOL_CALL_RE.lastIndex = 0;

  while ((match = OLLAMA_TOOL_CALL_RE.exec(text)) !== null) {
    const name = match[1]?.trim();
    if (!name) continue;
    const parsedArgs = parseJsonArguments(match[2]?.trim() ?? '');
    if (!parsedArgs) continue;
    results.push({ name, arguments: parsedArgs });
  }
}

function parseJsonToolObject(raw: string): ParsedToolCall | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  return tryNormalize(parsed);
}

function parseJsonArguments(raw: string): Record<string, unknown> | null {
  const parsed = parseJsonObject(raw);
  return isPlainObject(parsed) ? parsed : null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime parse; validated below
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPlainObject(parsed)) {
    return null;
  }
  return parsed;
}

/**
 * Try to extract a `{ name, arguments }` pair from a parsed JSON object.
 * Returns null if the object does not match any supported shape.
 */
function tryNormalize(obj: Record<string, unknown>): ParsedToolCall | null {
  if (typeof obj.tool === 'string' && isPlainObject(obj.arguments)) {
    const name = obj.tool.trim();
    if (!name) return null;
    return { name, arguments: obj.arguments as Record<string, unknown> };
  }

  if (typeof obj.name === 'string' && isPlainObject(obj.arguments)) {
    const name = obj.name.trim();
    if (!name) return null;
    return { name, arguments: obj.arguments as Record<string, unknown> };
  }

  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const [key] = keys;
    if (isPlainObject(obj[key])) {
      const name = key.trim();
      if (!name) return null;
      return { name, arguments: obj[key] as Record<string, unknown> };
    }
  }

  return null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findNextToolMarker(content: string): [number, (typeof OLLAMA_TOOL_MARKERS)[number]] | null {
  let best: [number, (typeof OLLAMA_TOOL_MARKERS)[number]] | null = null;
  for (const marker of OLLAMA_TOOL_MARKERS) {
    const pos = content.indexOf(marker);
    if (pos === -1) continue;
    if (best === null || pos < best[0] || (pos === best[0] && marker.length < best[1].length)) {
      best = [pos, marker];
    }
  }
  return best;
}

function stripCarry(raw: string, carry: string): [string, string] {
  const content = `${carry}${raw}`;
  let bestCarry = '';

  for (const marker of OLLAMA_TOOL_MARKERS) {
    const maxPartial = Math.min(content.length, marker.length - 1);
    for (let i = 1; i <= maxPartial; i++) {
      const candidate = marker.slice(0, i);
      if (content.endsWith(candidate) && candidate.length > bestCarry.length) {
        bestCarry = candidate;
      }
    }
  }

  if (!bestCarry) return [content, ''];
  return [
    content.slice(0, content.length - bestCarry.length),
    content.slice(content.length - bestCarry.length),
  ];
}
