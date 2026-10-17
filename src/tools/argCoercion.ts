import type { ToolDefinition } from '../llm/types';

type DeclaredProperty = { type?: unknown; items?: unknown };

/**
 * Lossless repair of the argument shapes local models most often send quoted:
 * `"true"`/`"False"` for a boolean, `"5"` for an integer, and `"[\"a\"]"` (a
 * JSON array inside a string) for an array. Each one used to cost a whole
 * refusal-and-resend round (three in one pilot task). Only conversions with
 * exactly one reading are made; anything else is left for `invalidArgs` to
 * refuse with its field-naming message, so this never guesses.
 */
export function coerceToolArgs(
  definition: ToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const properties = definition.function.parameters.properties;
  if (typeof args !== 'object' || args === null) return args;
  if (typeof properties !== 'object' || properties === null) return args;
  let result = args;
  for (const [key, schema] of Object.entries(properties as Record<string, DeclaredProperty>)) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const coerced = coerceValue(schema?.type, value);
    if (coerced === undefined) continue;
    if (result === args) result = { ...args };
    result[key] = coerced;
  }
  return result;
}

function coerceValue(type: unknown, value: string): unknown {
  const text = value.trim();
  switch (type) {
    case 'boolean':
      if (text === 'true' || text === 'True') return true;
      if (text === 'false' || text === 'False') return false;
      return undefined;
    case 'integer':
      return /^-?\d+$/u.test(text) ? Number(text) : undefined;
    case 'number':
      return /^-?\d+(?:\.\d+)?$/u.test(text) ? Number(text) : undefined;
    case 'array': {
      if (!text.startsWith('[')) return undefined;
      const parsed = parseJsonArray(text);
      return parsed.ok ? parsed.value : undefined;
    }
    default:
      return undefined;
  }
}

/** JSON.parse location and explanation for an invalid string offered as an array. */
export interface InvalidArrayJsonDiagnostic {
  position: number;
  excerpt: string;
  cause: string;
}

const ARRAY_BRACKET_CAUSE =
  'a closing bracket that does not match the open one (an array closes with ], an object with })';
const BAD_ESCAPE_CAUSE = 'a single backslash; write \\\\ (for example in Windows paths)';
const CUT_OFF_ARRAY_CAUSE = 'the array is cut off before it closes';
const EXCERPT_MARKER = '⟦HERE⟧';

/**
 * Parse diagnostics for a broken JSON string offered in place of an array.
 * Positions are relative to the trimmed JSON text, just as they are when the
 * argument is parsed for coercion.
 */
export function invalidArrayJsonDiagnostic(
  value: string,
  maxExcerptLength = Number.POSITIVE_INFINITY,
): InvalidArrayJsonDiagnostic | undefined {
  const text = value.trim();
  if (!text.startsWith('[')) return undefined;
  const parsed = parseJsonArray(text);
  if (parsed.ok) return undefined;
  return {
    position: parsed.position,
    excerpt: excerptAt(text, parsed.position, maxExcerptLength),
    cause: invalidArrayJsonCause(parsed.message, text, parsed.position),
  };
}

function parseJsonArray(
  text: string,
): { ok: true; value: unknown[] } | { ok: false; position: number; message: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? { ok: true, value: parsed }
      : { ok: false, position: 0, message: 'JSON value is not an array' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, position: jsonErrorPosition(message, text), message };
  }
}

function jsonErrorPosition(message: string, text: string): number {
  // V8 currently includes `position N`; retain the line/column route for Node
  // versions whose JSON.parse diagnostics report only that newer form.
  const position = /position (\d+)/iu.exec(message)?.[1];
  if (position !== undefined) return Math.min(Number(position), text.length);

  const lineColumn = /line (\d+) column (\d+)/iu.exec(message);
  if (lineColumn) {
    const line = Number(lineColumn[1]);
    const column = Number(lineColumn[2]);
    const lineStarts = [0];
    for (const match of text.matchAll(/\r\n|\r|\n/gu)) {
      lineStarts.push((match.index ?? 0) + match[0].length);
    }
    const lineStart = lineStarts[line - 1];
    if (lineStart !== undefined) return Math.min(lineStart + Math.max(0, column - 1), text.length);
  }
  return text.length;
}

function invalidArrayJsonCause(message: string, text: string, position: number): string {
  const character = text[position];
  if (character === '}' || character === ']') return ARRAY_BRACKET_CAUSE;
  if (/escape/iu.test(message)) return BAD_ESCAPE_CAUSE;
  if (
    position >= text.length ||
    /unterminated string|unexpected end|end of JSON input/iu.test(message)
  ) {
    return CUT_OFF_ARRAY_CAUSE;
  }
  return `JSON.parse says: ${message.replace(/\r\n|\r|\n/gu, '\\n')}`;
}

function excerptAt(text: string, position: number, maxLength: number): string {
  const before = text.slice(Math.max(0, position - 40), position).replace(/\r\n|\r|\n/gu, '\\n');
  const after = text.slice(position, position + 15).replace(/\r\n|\r|\n/gu, '\\n');
  const excerpt = `${before}${EXCERPT_MARKER}${after}`;
  if (excerpt.length <= maxLength) return excerpt;

  const contextLength = Math.max(0, maxLength - EXCERPT_MARKER.length);
  const beforeLength = Math.min(before.length, Math.ceil((contextLength * 40) / 55));
  const afterLength = Math.min(after.length, contextLength - beforeLength);
  const adjustedBeforeLength = Math.min(beforeLength, contextLength - afterLength);
  const clippedBefore = adjustedBeforeLength === 0 ? '' : before.slice(-adjustedBeforeLength);
  return `${clippedBefore}${EXCERPT_MARKER}${after.slice(0, afterLength)}`;
}
