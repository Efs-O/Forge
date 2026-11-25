import { parseJsonArgumentText } from './jsonArgumentRepair';

/**
 * Repair an argument name that arrived mangled but unambiguous: leaked XML
 * close markup after a declared name, or a stray `=` before one. Both are
 * renames onto a declared argument that is not already in the call; anything
 * else is left alone so the ordinary unknown-argument refusal still fires.
 */
export function repairParameterMarkup(
  name: string,
  properties: unknown,
  present: Record<string, unknown>,
): string | undefined {
  if (typeof properties !== 'object' || properties === null) return undefined;
  for (const key of Object.keys(present)) {
    // A key that arrived as `=query` is the same argument with a stray `=` —
    // the shape a model writes when it renders `--query=` or `<parameter
    // name=query>` as text. Same rule as the markup repair below: rename only
    // when the rest is a declared argument and that argument is not already in
    // the call, so `=query` beside `query` stays a refusal.
    const equals = /^=(.+)$/u.exec(key);
    const equalsTarget = equals?.[1];
    if (
      equalsTarget &&
      Object.hasOwn(properties, equalsTarget) &&
      present[equalsTarget] === undefined
    ) {
      present[equalsTarget] = present[key];
      delete present[key];
      continue;
    }
    const match = /^(.+)<\/parameter>?$/u.exec(key);
    const argument = match?.[1];
    if (!argument || !Object.hasOwn(properties, argument)) continue;
    const value = present[key];
    if (
      typeof value === 'string' &&
      (value === '<parameter name>' || value.startsWith('<parameter name='))
    ) {
      return (
        name +
        ': argument "' +
        argument +
        '" arrived as tool-call markup (' +
        value +
        '), not a value. Send it again as plain JSON.'
      );
    }
    if (present[argument] !== undefined) continue;
    present[argument] = value;
    delete present[key];
  }
  return undefined;
}

/**
 * A parameter block the engine's parser folded into the value it was already
 * reading: the closing tag of one argument, then the opening tag of the next,
 * all inside a single JSON string. `isLeakedMarkupValue` refuses the shape, but
 * when the folded tag names a declared argument that is not in the call, there
 * is nothing to guess — the value in front of it belongs to that argument.
 * Splitting it back out runs the call instead of refusing it.
 *
 * Measured 2026-11-25 (session 22f64367, `read_file`): the model wrote
 * `<parameter numbered>` with a space instead of `=`, and the whole block landed
 * in `path`, so the read failed with ENOENT on `docs/CODING_TIPS.md\n</parameter>…`.
 */
const FOLDED_PARAMETER_BLOCK = /\n<\/parameter>\n<parameter(?:=| name=| )"?([A-Za-z0-9_.-]+)"?>\n/u;
const ONE_TRAILING_CLOSE = /\n<\/parameter>$/u;

/** Sentinel: this recovered text is not a value this argument's type accepts. */
const NO_VALUE = Symbol('no value');

export function recoverFoldedParameters(
  properties: unknown,
  present: Record<string, unknown>,
): void {
  if (typeof properties !== 'object' || properties === null) return;
  const declared = properties as Record<string, { type?: unknown }>;
  for (const [key, value] of Object.entries(present)) {
    if (typeof value !== 'string') continue;
    const first = FOLDED_PARAMETER_BLOCK.exec(value);
    const firstName = first?.[1];
    if (!first || !firstName) continue;
    const recovered = new Map<string, unknown>();
    const canTake = (argument: string): boolean =>
      argument !== key &&
      Object.hasOwn(declared, argument) &&
      present[argument] === undefined &&
      !recovered.has(argument);
    if (!canTake(firstName)) continue;
    let argument = firstName;
    let rest = value.slice(first.index + first[0].length);
    let complete = true;
    for (;;) {
      const next = FOLDED_PARAMETER_BLOCK.exec(rest);
      const head = next ? rest.slice(0, next.index) : rest;
      const text = head.replace(ONE_TRAILING_CLOSE, '');
      const converted = convertFoldedValue(declared[argument], text);
      if (converted === NO_VALUE) {
        complete = false;
        break;
      }
      recovered.set(argument, converted);
      if (!next) break;
      const nextName = next[1];
      if (!nextName || !canTake(nextName)) {
        complete = false;
        break;
      }
      argument = nextName;
      rest = rest.slice(next.index + next[0].length);
    }
    if (!complete) continue;
    // Only now, so a block this function cannot read is left for the leak refusal.
    present[key] = value.slice(0, first.index);
    for (const [recoveredName, recoveredValue] of recovered)
      present[recoveredName] = recoveredValue;
  }
}

/**
 * Read the recovered text as the type the schema declares. A value that does not
 * fit its type is left broken on purpose: the leak refusal names the real fault
 * (markup inside a value) better than a type error would.
 */
function convertFoldedValue(schema: { type?: unknown } | undefined, text: string): unknown {
  const type = typeof schema?.type === 'string' ? schema.type : undefined;
  const trimmed = text.trim();
  if (type === 'boolean') {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    return NO_VALUE;
  }
  if (type === 'integer') return /^-?\d+$/u.test(trimmed) ? Number(trimmed) : NO_VALUE;
  if (type === 'number') return /^-?\d+(\.\d+)?$/u.test(trimmed) ? Number(trimmed) : NO_VALUE;
  if (type === 'array' || type === 'object') {
    const parsed = parseJsonArgumentText(text);
    return parsed === undefined ? NO_VALUE : parsed.value;
  }
  return text;
}
