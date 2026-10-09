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

/** JSON.parse's zero-based position for an invalid string offered as an array. */
export function invalidArrayJsonPosition(value: string): number | undefined {
  const text = value.trim();
  if (!text.startsWith('[')) return undefined;
  const parsed = parseJsonArray(text);
  return parsed.ok ? undefined : parsed.position;
}

function parseJsonArray(
  text: string,
): { ok: true; value: unknown[] } | { ok: false; position: number } {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? { ok: true, value: parsed } : { ok: false, position: 0 };
  } catch (error) {
    const position = /position (\d+)/u.exec(error instanceof Error ? error.message : '')?.[1];
    return { ok: false, position: position === undefined ? text.length : Number(position) };
  }
}
