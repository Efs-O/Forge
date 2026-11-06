/** Parse JSON exactly as sent; malformed input stays malformed. */
export type JsonParseResult = { ok: true; value: unknown } | { ok: false; error: unknown };

export function parseJson(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error };
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
