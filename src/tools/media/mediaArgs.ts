/**
 * Argument reading for the two media tools.
 *
 * The plan's rule is strict, structured schemas with no blob argument, so
 * every value is read by name, bounded, and refused with the field named and
 * the fix stated. `ToolRegistry.invalidArgs` already catches a missing
 * required field and a boolean sent as a string before the handler runs
 * (`ToolDispatch.ts:225`); this module owns the ranges the JSON Schema
 * cannot state for a local engine — an engine's `max_seconds`, an ACE caption
 * of 512 characters, a duration whose frame count the adapter will reject.
 */
const MAX_NAME_CHARS = 120;

export function textArg(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
  maxLength: number,
  { required = false } = {},
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`${toolName}: "${name}" is required and must be a string.`);
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${toolName}: "${name}" must be a string, not ${typeof value}.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${toolName}: "${name}" must not be empty.`);
  }
  if (trimmed.length > maxLength) {
    throw new Error(
      `${toolName}: "${name}" is ${trimmed.length} characters, over the ${maxLength} the engine ` +
        `accepts. Shorten it; the tool will not silently cut your text.`,
    );
  }
  return trimmed;
}

export function numberArg(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
  { min, max, integer = false }: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${toolName}: "${name}" must be a number.`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`${toolName}: "${name}" must be a whole number.`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${toolName}: "${name}" must be at least ${min}.`);
  }
  if (max !== undefined && value > max) {
    throw new Error(`${toolName}: "${name}" must be at most ${max}.`);
  }
  return value;
}

export function booleanArg(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${toolName}: "${name}" must be true or false.`);
  }
  return value;
}

export function enumArg(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
  allowed: readonly string[],
  { required = false }: { required?: boolean } = {},
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`${toolName}: "${name}" is required; send one of ${allowed.join(', ')}.`);
    }
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(
      `${toolName}: "${name}" must be one of ${allowed.join(', ')}` +
        `(got ${typeof value === 'string' ? JSON.stringify(value) : typeof value}).`,
    );
  }
  return value;
}

/** A file argument: workspace-relative or absolute, never a name that wanders. */
export function pathArg(
  args: Record<string, unknown>,
  name: string,
  toolName: string,
  { required = false }: { required?: boolean } = {},
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`${toolName}: "${name}" is required and must be a workspace path.`);
    }
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${toolName}: "${name}" must be a non-empty workspace path string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_NAME_CHARS * 8) {
    throw new Error(`${toolName}: "${name}" is too long to be a path.`);
  }
  return trimmed;
}
