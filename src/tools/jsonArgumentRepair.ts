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
 * a long list of edits and write wrong code, and a refusal cannot. One structural
 * shape is read after all, because nothing is guessed there: the value before the
 * tail is complete, valid JSON, and the tail is the end of the whole tool call the
 * model was still writing (`]}` or `], "path": "x"}`) — see `readCallTail`.
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
 * The end of the tool call, written inside the value: the model finished the
 * array and went on writing the call around it. Measured 9 times in the session
 * archive — `apply_line_edits` `operations` with `], "path": "…"}` after the
 * array (2c3d8f4c ×2, 571eaf46, and `path` was absent from the call, so the
 * model had nowhere else to put it), and `ask_user` `questions` with one extra
 * `}` — the call object's own brace (6 calls). Only these two tails are read:
 * the head must parse as JSON on its own, every key the tail carries must be a
 * declared parameter the call lacks, and any other tail is refused as before.
 */
const CALL_TAIL_REPAIR =
  "the end of the tool call, written inside this value, was read as the call's own arguments";

/**
 * Index of the bracket that closes the JSON value starting at `from`, or -1 when
 * the brackets never close. Strings are skipped (a `"` toggles, a `\` inside a
 * string skips the next character), so a bracket inside a string is not a bracket.
 */
function firstJsonValueEnd(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at++) {
    const char = text[at];
    if (char === '"') {
      at += 1;
      while (at < text.length) {
        if (text[at] === '\\') {
          at += 2;
          continue;
        }
        if (text[at] === '"') break;
        at += 1;
      }
      continue;
    }
    if (char === '[' || char === '{') {
      depth += 1;
      continue;
    }
    if (char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return at;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Read `value` as the declared argument plus the end of the call that followed
 * it. Returns undefined for every other tail, so the caller leaves the argument
 * alone and the existing refusal names the position.
 */
function readCallTail(
  value: string,
  key: string,
  declared: Record<string, { type?: unknown }>,
  present: Record<string, unknown>,
): { parsed: RepairedJsonArgument; extra: Record<string, unknown> } | undefined {
  const end = firstJsonValueEnd(value, value.length - value.trimStart().length);
  if (end < 0) return undefined;
  const head = value.slice(0, end + 1);
  const parsed = parseJsonArgumentText(head);
  if (parsed === undefined) return undefined;
  const rest = value.slice(end + 1).trim();
  if (rest === '}') return { parsed, extra: {} };
  if (!rest.startsWith(',') || !rest.endsWith('}')) return undefined;
  let tail: unknown;
  try {
    tail = JSON.parse('{' + rest.slice(1)) as unknown;
  } catch {
    return undefined;
  }
  if (tail === null || typeof tail !== 'object' || Array.isArray(tail)) return undefined;
  const extra: Record<string, unknown> = {};
  for (const [extraKey, extraValue] of Object.entries(tail as Record<string, unknown>)) {
    const usable =
      extraKey !== key &&
      Object.hasOwn(declared, extraKey) &&
      present[extraKey] === undefined &&
      extraValue !== undefined;
    if (!usable) return undefined;
    extra[extraKey] = extraValue;
  }
  return { parsed, extra };
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
  const declared = properties as Record<string, { type?: unknown }>;
  const replacedKeys: string[] = [];
  const allRepairs: string[] = [];
  let total = 0;
  for (const [key, schema] of Object.entries(declared)) {
    const expected = schema?.type;
    if (expected !== 'array' && expected !== 'object') continue;
    const value = present[key];
    if (typeof value !== 'string') continue;
    const opens = expected === 'array' ? '[' : '{';
    if (!value.trimStart().startsWith(opens)) continue;
    let repaired = parseJsonArgumentText(value);
    let callTail: Record<string, unknown> | undefined;
    if (repaired === undefined) {
      // The text did not parse as it stands. Before giving up, look for the end
      // of the call written after a complete value.
      const tail = readCallTail(value, key, declared, present);
      if (tail === undefined) continue;
      repaired = tail.parsed;
      callTail = tail.extra;
    }
    present[key] = repaired.value;
    replacedKeys.push(key);
    allRepairs.push(...repaired.repairs);
    total += repaired.total;
    if (callTail !== undefined) {
      for (const [extraKey, extraValue] of Object.entries(callTail)) {
        present[extraKey] = extraValue;
        replacedKeys.push(extraKey);
      }
      allRepairs.push(CALL_TAIL_REPAIR);
      total += 1;
    }
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
  // "slip", not "escape slip": the call-tail repair is a structural one.
  return `Note: ${keys} arrived as JSON text with ${count} slip${count === 1 ? '' : 's'}; read as: ${phrases}`;
}
