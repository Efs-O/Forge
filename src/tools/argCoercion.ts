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
      try {
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : undefined;
      } catch {
        // Not a JSON array: invalidArgs names the field and the expected shape.
        return undefined;
      }
    }
    default:
      return undefined;
  }
}
