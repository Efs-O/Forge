import { canonicalToolName } from './toolNameAliases';

/**
 * StructuredOutputParser - fallback parser for models that emit JSON-fenced
 * tool-call blocks or provider-specific tool markers instead of native
 * function-calling.
 *
 * Supported shapes inside a ```json block:
 *   { "tool": "tool_name",  "arguments": { ... } }
 *   The `name` and single-key forms are rejected with a tool-call error.
 *
 * Supported marker syntax used by some Ollama-hosted/cloud models:
 *   <｜tool▁call▁begin｜>tool_name<｜tool▁sep｜>{"arg":"value"}<｜tool▁call▁end｜>
 *
 * Hermes-style JSON inside <tool_call> tags, in that format's own envelope:
 *   <tool_call>{"name":"tool_name","arguments":{...}}</tool_call>
 * Qwen-family fine-tunes drift into this after a few native calls; llama-server
 * only parses the template's own `<function=...>` form, so without this the
 * call arrives as text and the turn ends.
 *
 * The template's own XML form, when llama-server's parser lets it through as
 * content (seen 2026-09-23 on Qwen3.8 Q6: two calls back to back):
 *   <tool_call><function=tool_name><parameter=key>value</parameter></function></tool_call>
 * Values arrive as raw strings; ToolCallFallback types them from the schema.
 */

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  error?: string;
}

/** A recognised call plus the span it was found in, kept only inside this file. */
interface PositionedCall extends ParsedToolCall {
  start: number;
  end: number;
}

/**
 * Which shapes count as a tool call in one round's text. See
 * `TextToolCallMode.textToolCallForms` for who chooses them and why.
 */
export interface StructuredOutputForms {
  /** Read ```json blocks as calls. Off when the round offered native tools. */
  jsonFence: boolean;
  /** Read the provider marker shapes (Ollama, Hermes/XML) as calls. */
  markers: boolean;
}

export const ALL_FORMS: StructuredOutputForms = { jsonFence: true, markers: true };
export const MARKER_FORMS: StructuredOutputForms = { jsonFence: false, markers: true };
export const NO_FORMS: StructuredOutputForms = { jsonFence: false, markers: false };

const PARSE_ERROR_TOOL = '__tool_call_error__';

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
const HERMES_OPEN = '<tool_call>';
const HERMES_CLOSE = '</tool_call>';
const STREAM_MARKERS = [...OLLAMA_TOOL_MARKERS, HERMES_OPEN, HERMES_CLOSE] as const;
type StreamMarker = (typeof STREAM_MARKERS)[number];

// Matches ```json ... ``` blocks (non-greedy, case-insensitive fence)
const JSON_FENCE_RE = /```json\s*([\s\S]*?)```/gi;
const HERMES_TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const XML_FUNCTION_RE = /^<function=([\w.-]+)>([\s\S]*?)<\/function>$/;
const XML_PARAMETER_RE = /<parameter=([\w.-]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
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
 * Returns every valid call found, IN THE ORDER THE MODEL WROTE THEM, and skips
 * malformed blocks. Ordering is not cosmetic: calls run in the order they are
 * dispatched, and collecting fence-by-fence then marker-by-marker ran a later
 * Hermes call before an earlier fenced one.
 *
 * `toolNames`, when given, limits ```json blocks to calls of those tools. A
 * fence is also how a model shows ordinary JSON, and the single-key shorthand
 * reads `{"compilerOptions": {...}}` as a call to a tool named compilerOptions.
 * The marker and `<tool_call>` forms are unambiguous and are not limited.
 */
export function parseStructuredOutput(
  text: string,
  toolNames?: ReadonlySet<string>,
  forms: StructuredOutputForms = ALL_FORMS,
): ParsedToolCall[] {
  const found: PositionedCall[] = [];
  if (forms.jsonFence) collectJsonFenceToolCalls(text, found, toolNames);
  if (forms.markers) {
    collectOllamaMarkerToolCalls(text, found);
    collectHermesToolCalls(text, found);
  }
  found.sort((a, b) => a.start - b.start);

  // A span that starts inside one already accepted is the same call seen twice
  // — a fenced block inside a `<tool_call>` body, say — and running it twice
  // would write the file twice.
  const accepted: ParsedToolCall[] = [];
  let lastEnd = -1;
  for (const call of found) {
    if (call.start < lastEnd) continue;
    // The span is bookkeeping for this function; the caller gets a call.
    accepted.push({
      name: call.name,
      arguments: call.arguments,
      ...(call.error !== undefined ? { error: call.error } : {}),
    });
    lastEnd = Math.max(lastEnd, call.end);
  }
  return accepted;
}

/**
 * Removes streamed tool-call marker payloads from visible assistant text while
 * preserving surrounding prose. This is intentionally marker-only: JSON-fenced
 * blocks are handled after the full response is available so normal JSON/code
 * snippets are not hidden mid-stream.
 *
 * A `<tool_call>` span is held until it closes, then hidden only if it parses
 * as a call — the same rule stripStructuredOutputFromFullText applies. Without
 * this, Qwen's `<tool_call><function=...>` text streamed into the sidebar and
 * stayed there after the call ran.
 */
export class StructuredOutputStripper {
  private carry = '';
  private hiddenDepth = 0;
  /** Body of an open `<tool_call>` span, or null outside one. */
  private hermesBody: string | null = null;
  private readonly forms: StructuredOutputForms;

  /** `forms.markers` off: nothing in this text is a call, so nothing is hidden. */
  constructor(forms: StructuredOutputForms = ALL_FORMS) {
    this.forms = forms;
  }

  push(raw: string): string {
    if (!this.forms.markers) return raw;
    const [processed, nextCarry] = stripCarry(raw, this.carry);
    this.carry = nextCarry;
    return this.consume(processed);
  }

  /** The held tail was only the start of a marker if more text followed; it is text. */
  flush(): string {
    if (!this.forms.markers) return '';
    // An unclosed <tool_call> is not a call; the full-text pass keeps it too.
    const tail =
      this.hermesBody !== null
        ? HERMES_OPEN + this.hermesBody + this.carry
        : this.hiddenDepth === 0
          ? this.carry
          : '';
    this.carry = '';
    this.hermesBody = null;
    return tail;
  }

  private consume(content: string): string {
    let rest = content;
    const visible: string[] = [];

    while (rest) {
      if (this.hermesBody !== null) {
        const end = rest.indexOf(HERMES_CLOSE);
        if (end === -1) {
          this.hermesBody += rest;
          break;
        }
        const body = this.hermesBody + rest.slice(0, end);
        this.hermesBody = null;
        rest = rest.slice(end + HERMES_CLOSE.length);
        if (!isHermesCall(body)) visible.push(HERMES_OPEN + body + HERMES_CLOSE);
        continue;
      }

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
      if (marker === HERMES_OPEN) {
        if (this.hiddenDepth === 0) this.hermesBody = '';
      } else if (marker === HERMES_CLOSE) {
        // A stray close tag is prose; the full-text pass leaves it as well.
        if (this.hiddenDepth === 0) visible.push(marker);
      } else if (marker === OLLAMA_TOOL_CALL_BEGIN || marker === OLLAMA_TOOL_CALLS_BEGIN) {
        this.hiddenDepth += 1;
      } else if (marker === OLLAMA_TOOL_CALL_END || marker === OLLAMA_TOOL_CALLS_END) {
        this.hiddenDepth = Math.max(0, this.hiddenDepth - 1);
      }
    }

    return visible.join('');
  }
}

/** `toolNames` as for parseStructuredOutput: a ```json block that is not a call stays visible. */
export function stripStructuredOutputFromFullText(
  text: string,
  toolNames?: ReadonlySet<string>,
  forms: StructuredOutputForms = ALL_FORMS,
): string {
  const hasRejectedMarkerCall = parseStructuredOutput(text, undefined, forms).some(
    (call) => call.error !== undefined,
  );
  const withoutMarkers =
    !forms.markers || hasRejectedMarkerCall
      ? text
      : text.replace(OLLAMA_TOOL_CALL_RE, '').replace(OLLAMA_TOOL_WRAPPER_RE, '');

  const isFenceCall = (match: string, body: string): string => {
    const call = fenceCall(body, toolNames);
    return call !== null && call.error === undefined ? '' : match;
  };
  const isCall = (match: string, body: string): string => (isHermesCall(body) ? '' : match);
  const withoutFences = forms.jsonFence
    ? withoutMarkers.replace(JSON_FENCE_RE, isFenceCall)
    : withoutMarkers;
  return forms.markers ? withoutFences.replace(HERMES_TOOL_CALL_RE, isCall) : withoutFences;
}

function fenceCall(body: string, toolNames?: ReadonlySet<string>): ParsedToolCall | null {
  const candidate = parseJsonToolObject(body.trim(), 'fence');
  if (!candidate || !toolNames) return candidate;
  // A refused envelope still counts as a call only when it names a real tool,
  // so an ordinary JSON snippet in the answer is left alone.
  const named = candidate.error === undefined ? candidate.name : candidate.arguments['__tool'];
  return typeof named === 'string' &&
    (toolNames.has(named) || canonicalToolName(named) !== undefined)
    ? candidate
    : null;
}

function collectJsonFenceToolCalls(
  text: string,
  results: PositionedCall[],
  toolNames?: ReadonlySet<string>,
): void {
  let match: RegExpExecArray | null;
  JSON_FENCE_RE.lastIndex = 0;

  while ((match = JSON_FENCE_RE.exec(text)) !== null) {
    const candidate = fenceCall(match[1], toolNames);
    if (candidate) {
      results.push({ ...candidate, start: match.index, end: match.index + match[0].length });
    }
  }
}

function collectOllamaMarkerToolCalls(text: string, results: PositionedCall[]): void {
  let match: RegExpExecArray | null;
  OLLAMA_TOOL_CALL_RE.lastIndex = 0;

  while ((match = OLLAMA_TOOL_CALL_RE.exec(text)) !== null) {
    const name = match[1]?.trim();
    if (!name) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    const raw = match[2]?.trim() ?? '';
    const parsedArgs = parseJsonArguments(raw);
    if (!parsedArgs.ok) {
      results.push({
        ...span,
        name: PARSE_ERROR_TOOL,
        arguments: {},
        error: `malformed tool call: its arguments are not valid JSON (${parsedArgs.message}), so no tool ran. Resend it.`,
      });
      continue;
    }
    results.push({ ...span, name, arguments: parsedArgs.value });
  }
}

function collectHermesToolCalls(text: string, results: PositionedCall[]): void {
  for (const match of text.matchAll(HERMES_TOOL_CALL_RE)) {
    const body = match[1] ?? '';
    const candidate = parseJsonToolObject(body, 'hermes') ?? parseXmlFunction(body);
    if (candidate) {
      const start = match.index ?? 0;
      results.push({ ...candidate, start, end: start + match[0].length });
    }
  }
}

function isHermesCall(body: string): boolean {
  const candidate = parseJsonToolObject(body.trim(), 'hermes') ?? parseXmlFunction(body);
  return candidate !== null && candidate.error === undefined;
}

function parseXmlFunction(body: string): ParsedToolCall | null {
  const fn = XML_FUNCTION_RE.exec(body.trim());
  if (!fn) return null;
  const args: Record<string, unknown> = {};
  for (const param of fn[2].matchAll(XML_PARAMETER_RE)) args[param[1]] = param[2];
  return { name: fn[1], arguments: args };
}

/**
 * `fence`: a ```json block, where Forge's fallback prompt teaches `tool` and
 * nothing else. `hermes`: inside `<tool_call>` tags, where `name` is that
 * format's own envelope (the one Qwen-family models are trained on).
 */
type Envelope = 'fence' | 'hermes';

function parseJsonToolObject(raw: string, envelope: Envelope): ParsedToolCall | null {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  return tryNormalize(parsed, envelope);
}

function parseJsonArguments(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, message: 'the JSON value is not an object' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
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
function tryNormalize(obj: Record<string, unknown>, envelope: Envelope): ParsedToolCall | null {
  if (typeof obj.tool === 'string' && isPlainObject(obj.arguments)) {
    const name = obj.tool.trim();
    if (!name) return null;
    return { name, arguments: obj.arguments as Record<string, unknown> };
  }

  if (typeof obj.name === 'string' && isPlainObject(obj.arguments)) {
    if (envelope === 'fence') return invalidEnvelope('name', obj.name);
    const name = obj.name.trim();
    if (!name) return null;
    return { name, arguments: obj.arguments as Record<string, unknown> };
  }

  const keys = Object.keys(obj);
  if (keys.length === 1) {
    const [key] = keys;
    if (isPlainObject(obj[key])) {
      return invalidEnvelope('single-key', key);
    }
  }

  return null;
}

function invalidEnvelope(shape: string, toolName: unknown): ParsedToolCall {
  return {
    name: PARSE_ERROR_TOOL,
    arguments: { __tool: toolName },
    error: `tool call: use {"tool": "<name>", "arguments": {...}}; the "${shape}" form is not accepted.`,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findNextToolMarker(content: string): [number, StreamMarker] | null {
  let best: [number, StreamMarker] | null = null;
  for (const marker of STREAM_MARKERS) {
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

  for (const marker of STREAM_MARKERS) {
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
