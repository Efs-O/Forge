/**
 * The bounded repair for an array or object argument that arrived as hand-written
 * JSON text instead of the parsed value.
 *
 * **Who writes the arguments.** The model does not write JSON for a tool call.
 * Strata's chat template (`N:/Strata/serve/chat_template.jinja:83`) has it write
 * `<function=NAME>` / `<parameter=NAME>value</parameter>` blocks, and the engine
 * builds the JSON itself (`N:/Strata/serve/frontend.py:1503` emits the parameter
 * name as `json.dumps(pname) + ":"` — no space after the colon, which is what
 * every failing call's `raw_arguments` shows; `:1541` escapes a declared string
 * value with `json.dumps`; `:1552-1554` sends every other type through
 * `coerce_value` first). So a top-level string argument arrives exactly as the
 * model wrote it, escapes and all, and never needs a repair.
 *
 * An array or object argument is the one place the model must hand-write JSON:
 * its text goes through `coerce_value` (`frontend.py:1097`), which tries
 * `json.loads(..., strict=False)` and then `lenient_json`, and when both fail
 * returns the text unchanged — so Forge receives a string where the schema says
 * array. Measured across the whole session archive (rows deduped): 8,171
 * `edit_file` calls sent a real array and 36 sent a broken one;
 * `apply_line_edits`: 362 real, 21 broken. Not one of the 60 strings was valid
 * JSON, so every one of them is a genuine slip, not a quoting accident.
 *
 * **What the slips are** (counted inside the strings of those 60): an
 * unescaped double quote from the code the model is quoting (the largest class,
 * 19+), a wrong nesting brace (5), a value left unquoted (3), and three escape
 * slips that have exactly one reading each — a backslash before a single quote
 * (`\'`, 13), a backslash standing right before a real line break (8), and a
 * raw control character inside a string (216 across the 60). This module repairs
 * only those last three, because they are the only ones whose meaning is
 * certain: the escape classes become what the model's own refusal says they
 * mean, and a raw line break becomes a line break either way. The structural
 * slips keep the existing refusal, which names the character position — a
 * tolerant reader that guesses where a string ends would fix them too, but it
 * can silently mis-parse a long list of edits and write wrong code, and a
 * refusal cannot.
 *
 * Nothing here runs unless the value is a string that starts like the shape the
 * schema declares, and it changes nothing unless the repaired text parses.
 */

/** A repaired argument's value, plus what was changed, for the refusal-free path. */
export interface RepairedJsonArgument {
  value: unknown;
  /** What was repaired, in short phrases; capped, and empty when the text parsed as it stood. */
  repairs: string[];
}

/** The most repair positions one call may report. */
const MAX_REPORTED_REPAIRS = 5;

/** The JSON escapes for the control characters a model writes for real. */
const CONTROL_ESCAPES = new Map([
  ['\b', '\\b'],
  ['\f', '\\f'],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

/**
 * Read `text` as the JSON value it was meant to be: parse it first, and only if
 * that fails apply the bounded repair and parse again. Returns undefined when
 * neither works, so the caller's existing refusal still runs. `strict` JSON is
 * used for the second read as well — a value Forge accepts must be a value the
 * handler can trust, not one a lenient reader stretched.
 */
export function parseJsonArgumentText(text: string): RepairedJsonArgument | undefined {
  const direct = tryParse(text);
  if (direct !== undefined) return { value: direct, repairs: [] };
  const repaired = repairJsonStringEscapes(text);
  if (repaired === undefined) return undefined;
  const value = tryParse(repaired.text);
  if (value === undefined) return undefined;
  return { value, repairs: repaired.repairs };
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface RepairResult {
  text: string;
  repairs: string[];
}

/**
 * Rewrite the inside of JSON strings only; everything outside a string is
 * copied through, so the structure the caller checks is never touched.
 *
 * - `\` before a real line break → `\n` (or `\r`): the model wrote the break
 *   for real where JSON wants its escape.
 * - `\` before a single quote → `'`: JSON has no `\'`; the model carried the
 *   JavaScript spelling into the argument.
 * - a raw control character inside a string → its escape. The decoded text is
 *   the same character either way; this is what lets the strict re-read pass.
 *
 * Any other invalid escape is left alone, which keeps the result unparseable and
 * the refusal honest.
 */
export function repairJsonStringEscapes(text: string): RepairResult | undefined {
  const out: string[] = [];
  const repairs: string[] = [];
  let inString = false;
  let at = 0;
  const note = (message: string, offset: number): void => {
    if (repairs.length >= MAX_REPORTED_REPAIRS) return;
    repairs.push(`${message} at character ${offset + 1}`);
  };
  while (at < text.length) {
    const char = text[at];
    if (!inString) {
      if (char === '"') inString = true;
      out.push(char);
      at += 1;
      continue;
    }
    if (char === '\\') {
      const next = at + 1 < text.length ? text[at + 1] : '';
      if (next === '\n') {
        out.push('\\n');
        note('a line break written after a backslash became \\n', at);
        at += 2;
        continue;
      }
      if (next === '\r') {
        out.push('\\r');
        note('a carriage return written after a backslash became \\r', at);
        at += 2;
        continue;
      }
      if (next === "'") {
        out.push("'");
        note('a backslash before a single quote was dropped', at);
        at += 2;
        continue;
      }
      if (next !== '' && '"\\/bfnrtu'.includes(next)) {
        out.push('\\', next);
        at += 2;
        continue;
      }
      out.push('\\');
      at += 1;
      continue;
    }
    if (char === '"') {
      inString = false;
      out.push(char);
      at += 1;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20) {
      const named = CONTROL_ESCAPES.get(char);
      out.push(named ?? `\\u${code.toString(16).padStart(4, '0')}`);
      note('a raw control character inside a string was escaped', at);
      at += 1;
      continue;
    }
    out.push(char);
    at += 1;
  }
  if (repairs.length === 0) return undefined;
  return { text: out.join(''), repairs };
}

/**
 * Repair every declared array or object argument that arrived as text, in place
 * on the live `args` object, so the handler receives the real value. Only keys
 * the tool declares with `type: 'array'` or `'object'` are touched, and only
 * when the string starts with the bracket that shape opens — a plain string
 * value is never a candidate. Returns the keys it replaced, in declaration order.
 */
export function repairDeclaredJsonArguments(
  properties: unknown,
  present: Record<string, unknown>,
): string[] {
  if (typeof properties !== 'object' || properties === null) return [];
  const replaced: string[] = [];
  for (const [key, schema] of Object.entries(properties as Record<string, { type?: unknown }>)) {
    const expected = schema?.type;
    if (expected !== 'array' && expected !== 'object') continue;
    const value = present[key];
    if (typeof value !== 'string') continue;
    const opens = expected === 'array' ? '[' : '{';
    if (!value.trimStart().startsWith(opens)) continue;
    const parsed = parseJsonArgumentText(value);
    if (parsed === undefined) continue;
    present[key] = parsed.value;
    replaced.push(key);
  }
  return replaced;
}
