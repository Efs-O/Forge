/**
 * Argument names a model reaches for that the tool it called does not declare.
 *
 * Two kinds, and they are treated differently, because guessing wrong about one
 * of them runs the wrong thing.
 *
 * A name that means exactly a declared argument, and carries the same shape of
 * value, is rewritten before validation and the call simply runs — the same
 * precedent as the quoted-boolean coercion in `ToolRegistry.invalidArgs`. The
 * session log still records the raw arguments, so the habit stays measurable
 * after the refusal disappears.
 *
 * A name whose value could not be that argument — an array of command names
 * where a command string is wanted, a label where a path is wanted — is never
 * rewritten. The refusal just names the argument the model meant, and stays
 * silent when that argument is already in the call.
 *
 * Measured 2026-11-16: 9 of the day's 21 tool refusals were a wrong argument
 * name, and every one of them cost a round.
 */

/** Declared argument a wrong name stands for, per tool. */
const ARG_REWRITES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // `path` is what every other Forge file tool names its target and `glob` is
  // ripgrep's own flag; both carry exactly what `include` carries — a glob, a
  // file or a folder. `include` accepts a path outside the workspace too, so a
  // rewrite cannot mean something the tool would not otherwise have done.
  grep_search: { path: 'include', glob: 'include' },
};

/** The arguments a wrong key was reaching for, per tool and wrong key. Never rewrites. */
const ARG_HINTS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  // Claude Code's Bash tool fields: `command_names` is an array of names and
  // `subject` is a label, so neither can become `command`.
  shell: { command_names: ['command'], subject: ['command'] },
  // read_file has no length argument at all; a caller wanting one wants a
  // range, so both ends are named. A hint that reads as one quoted key is one
  // a weak model sends back verbatim, and the round is spent again.
  read_file: { max_chars: ['start_line', 'end_line'] },
};

/** `"a"`, or `"a" or "b"` — the arguments a refusal points at, quoted. */
function quoteAlternatives(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  if (quoted.length < 3) return quoted.join(' or ');
  return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

/**
 * Rename every wrong-but-equivalent key onto its declared argument, in place on
 * the live `args` object, so the handler and the schema checks both see the real
 * name. A key is rewritten only when its value is a string, the target is a
 * declared argument, and the target is absent: a call that sends both `include`
 * and `path` is ambiguous, and stays a refusal.
 */
export function applyArgumentRewrites(
  name: string,
  properties: unknown,
  present: Record<string, unknown>,
): void {
  const rewrites = ARG_REWRITES[name];
  if (!rewrites || typeof properties !== 'object' || properties === null) return;
  for (const [wrong, target] of Object.entries(rewrites)) {
    const value = present[wrong];
    if (typeof value !== 'string') continue;
    if (!Object.hasOwn(properties, target)) continue;
    if (present[target] !== undefined) continue;
    present[target] = value;
    delete present[wrong];
  }
}

/** The arguments this wrong key was reaching for, unless the first is already in the call. */
function intendedArguments(
  name: string,
  key: string,
  present: Record<string, unknown>,
): readonly string[] | undefined {
  const hint = ARG_HINTS[name]?.[key];
  if (!hint) return undefined;
  const first = hint[0];
  if (!first || present[first] !== undefined) return undefined;
  return hint;
}

/** True only for a plain object — never an array or a class instance. */
function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The refusal for keys this tool does not declare.
 *
 * Three answers, in the order the model needs them. A single unknown key whose
 * value is the tool's own arguments wrapped in an object says where they belong;
 * a single unknown key the model was reaching for something else with names that
 * something; anything else lists the declared keys and says nothing ran.
 */
export function unknownArgumentRefusal(
  name: string,
  unknown: readonly string[],
  declaredKeys: readonly string[],
  advertisedProperties: Record<string, unknown>,
  present: Record<string, unknown>,
): string {
  const takes = `this tool takes: ${declaredKeys.join(', ')}.`;
  if (unknown.length === 1) {
    const key = unknown[0];
    const value = present[key];
    if (plainObject(value)) {
      const innerKeys = Object.keys(value);
      if (
        innerKeys.length > 0 &&
        innerKeys.every((innerKey) => Object.hasOwn(advertisedProperties, innerKey)) &&
        innerKeys.every((innerKey) => !Object.hasOwn(present, innerKey))
      ) {
        const inner = innerKeys.join(', ');
        return (
          `Error: ${name}: unknown argument "${key}"; its value holds this tool's own arguments (${inner}), ` +
          `which go at the top level, not inside "${key}". This tool takes: ${declaredKeys.join(', ')}. ` +
          `Nothing ran. Resend the call with ${inner} moved out of "${key}".`
        );
      }
    }
    const intended = intendedArguments(name, key, present);
    if (intended) {
      const named = quoteAlternatives(intended);
      return (
        `Error: ${name}: unknown argument "${key}"; did you mean ${named}? ${takes} ` +
        `Nothing ran. Resend the call with ${named} instead.`
      );
    }
    return (
      `Error: ${name}: unknown argument "${key}"; ${takes} Nothing ran. ` +
      'Resend the call without it, or use the argument that means what you intended.'
    );
  }
  const quoted = unknown.map((key) => `"${key}"`).join(', ');
  return (
    `Error: ${name}: unknown arguments ${quoted}; ${takes} Nothing ran. ` +
    'Resend the call without them, or use the arguments that mean what you intended.'
  );
}
