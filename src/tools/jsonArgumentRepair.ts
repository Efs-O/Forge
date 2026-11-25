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
 * slips that have exactly one reading each — any backslash that does not start
 * a valid JSON escape (the model meant a literal backslash: `\'`, `\d`, `\`
 * before a real line break, 21 cases), and a raw control character inside a
 * string (216 across the 60). This module repairs only those, because they are
 * the only ones whose meaning is certain: a backslash JSON cannot read was
 * typed by the model as source text, so it stays a backslash; a raw control
 * character is the same character either way. The structural slips keep the
 * existing refusal, which names the character position — a tolerant reader that
 * guesses where a string ends would fix them too, but it can silently mis-parse
 * a long list of edits and write wrong code, and a refusal cannot.
 *
 * Nothing here runs unless the value is a string that starts like the shape the
 * schema declares, and it changes nothing unless the repaired text parses.
 */

/** A repaired argument's value, plus what was changed, for the refusal-free path. */
export interface RepairedJsonArgument {
  value: unknown;
  /** What was repaired, in short phrases; capped, and empty when the text parsed as it stood. */
  repairs: string[];
  /** Total repair count, including those beyond the reporting cap. */
  total: number;
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
  if (direct !== undefined) return { value: direct, repairs: [], total: 0 };
  const repaired = repairJsonStringEscapes(text);
  if (repaired === undefined) return undefined;
  const value = tryParse(repaired.text);
  if (value === undefined) return undefined;
  return { value, repairs: repaired.repairs, total: repaired.total };
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
  total: number;
}

/**
 * Rewrite the inside of JSON strings only; everything outside a string is
 * copied through, so the structure the caller checks is never touched.
 *
 * - A backslash not followed by one of `" \ / b f n r t u` becomes `\\` (a
 *   literal backslash). The next character is processed normally: a real line
 *   break after it is then escaped by the control-character rule, a single
 *   quote passes through, a regex escape like `\d` keeps its backslash.
 * - A raw control character inside a string → its escape. The decoded text is
 *   the same character either way; this is what lets the strict re-read pass.
 *
 * Valid JSON escapes are passed through unchanged.
 */
export function repairJsonStringEscapes(text: string): RepairResult | undefined {
  const out: string[] = [];
  const repairs: string[] = [];
  let total = 0;
  let inString = false;
  let at = 0;
  const note = (message: string, offset: number): void => {
    total += 1;
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
      if (next !== '' && '"\\/bfnrtu'.includes(next)) {
        out.push('\\', next);
        at += 2;
        continue;
      }
      // Any other character (including a real line break, a single quote, or
      // end-of-text): the model meant a literal backslash. Double it so JSON
      // sees one; the next character is then processed normally.
      out.push('\\', '\\');
      note('a backslash with no valid escape was kept as a literal backslash', at);
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
  if (total === 0) return undefined;
  return { text: out.join(''), repairs, total };
}

/**
 * Repair every declared array or object argument that arrived as text, in place
 * on the live `args` object, so the handler receives the real value. Only keys
 * the tool declares with `type: 'array'` or `'object'` are touched, and only
 * when the string starts with the bracket that shape opens — a plain string
 * value is never a candidate. Returns the keys it replaced, the repair phrases,
 * and the total repair count.
 */
export interface JsonArgumentRepairReport {
  replacedKeys: string[];
  repairs: string[];
  total: number;
}

export function repairDeclaredJsonArguments(
  properties: unknown,
  present: Record<string, unknown>,
): JsonArgumentRepairReport {
  if (typeof properties !== 'object' || properties === null)
    return { replacedKeys: [], repairs: [], total: 0 };
  const replacedKeys: string[] = [];
  const allRepairs: string[] = [];
  let total = 0;
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
    replacedKeys.push(key);
    allRepairs.push(...parsed.repairs);
    total += parsed.total;
  }
  return { replacedKeys, repairs: allRepairs, total };
}

/**
 * The one-line note the model reads when a repair replaced a value.
 * Returns undefined when nothing was replaced.
 */
export function jsonArgumentRepairNote(report: JsonArgumentRepairReport): string | undefined {
  if (report.replacedKeys.length === 0) return undefined;
  const keys = report.replacedKeys.join(', ');
  const count = report.total;
  const phrases =
    report.repairs.length > 0 ? report.repairs.join(', ') : 'the text was re-read as JSON';
  return `Note: ${keys} arrived as JSON text with ${count} escape slip${count === 1 ? '' : 's'}; read as: ${phrases}`;
}
