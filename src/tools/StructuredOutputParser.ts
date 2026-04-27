/**
 * StructuredOutputParser — fallback parser for models that emit JSON-fenced
 * tool-call blocks instead of native function-calling.
 *
 * Supported shapes inside a ```json block:
 *   { "tool": "tool_name",  "arguments": { ... } }
 *   { "name": "tool_name",  "arguments": { ... } }
 *   { "tool_name": { ... } }   (shorthand: single key whose value is an object)
 */

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// Matches ```json ... ``` blocks (non-greedy, case-insensitive fence)
const JSON_FENCE_RE = /```json\s*([\s\S]*?)```/gi;

/**
 * Scan `text` for ```json ... ``` blocks and attempt to parse each as a tool call.
 * Returns all valid tool calls found; silently skips malformed blocks.
 */
export function parseStructuredOutput(text: string): ParsedToolCall[] {
  const results: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;

  // Reset lastIndex before iterating (global flag keeps state)
  JSON_FENCE_RE.lastIndex = 0;

  while ((match = JSON_FENCE_RE.exec(text)) !== null) {
    const raw = match[1].trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime parse; validated below
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // malformed JSON — skip
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      continue; // not an object
    }

    const candidate = tryNormalize(parsed);
    if (candidate) {
      results.push(candidate);
    }
  }

  return results;
}

// ── Normalization ─────────────────────────────────────────────────────────────

/**
 * Try to extract a `{ name, arguments }` pair from a parsed JSON object.
 * Returns null if the object does not match any supported shape.
 */
function tryNormalize(obj: Record<string, unknown>): ParsedToolCall | null {
  // Shape 1: { "tool": "name", "arguments": { ... } }
  if (typeof obj['tool'] === 'string' && isPlainObject(obj['arguments'])) {
    const name = obj['tool'].trim();
    if (!name) return null;
    return { name, arguments: obj['arguments'] as Record<string, unknown> };
  }

  // Shape 2: { "name": "name", "arguments": { ... } }
  if (typeof obj['name'] === 'string' && isPlainObject(obj['arguments'])) {
    const name = obj['name'].trim();
    if (!name) return null;
    return { name, arguments: obj['arguments'] as Record<string, unknown> };
  }

  // Shape 3 (shorthand): single key whose value is a plain object
  // e.g. { "read_file": { "path": "src/foo.ts" } }
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
