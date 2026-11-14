import { z, type ZodIssue } from 'zod';
import { formatPathMiss } from './pathMissText';
import { WorkspacePathMissingError } from '../util/workspacePathMissingError';

/**
 * What a refused tool call says back, in one place.
 *
 * `ToolRegistry.ts` is the dispatch and permission owner and sits near its
 * 500-line cap (`max-lines`), so the wording of its refusals lives here instead
 * — which is also where the two shapes belong together: the refusal for a field
 * the model left out, and the refusal for a field it sent in the wrong shape.
 *
 * Both are written for the model that has to act on them, not for a developer:
 * the field is named, the accepted shape is named beside it, and the line says
 * what to resend. A model that gets `must be an array of objects` without the
 * example re-sends the same thing; the example is what stops the round-trip.
 */

/** Values the model was actually offered for one field, or undefined. */
export type AdvertisedValues = (key: string) => readonly string[] | undefined;

/**
 * The values this turn was offered for a field, or undefined when it has no
 * enum. Read from `describe()` when the tool has one, because that is the
 * definition the turn was actually shown: `message_chat`'s `new` and `steer`
 * exist only while their config switches are on, and offering a value the model
 * cannot use would be a second refusal for the price of the first.
 *
 * `describe()` is a cheap read of live config, called once per refusal — the
 * same call `definitions()` already made earlier in this turn, so the two agree
 * for as long as the turn lasts.
 */
export function advertisedValues(parameters: unknown): AdvertisedValues {
  const properties =
    parameters && typeof parameters === 'object'
      ? (parameters as { properties?: Record<string, { enum?: unknown }> }).properties
      : undefined;
  return (key) => {
    const declared = properties?.[key];
    return Array.isArray(declared?.enum) &&
      declared.enum.every((value) => typeof value === 'string')
      ? (declared.enum as string[])
      : undefined;
  };
}

/**
 * The refusal for required arguments the call left out.
 *
 * A field with an `enum` gets its values named, because the model that omitted
 * `action` usually means one of them and has to guess which without being told.
 * The values come from the caller as the *advertised* set — the enum in the
 * definition this turn was offered — so a value switched off in config is never
 * suggested, and a suggestion the model then sends is not a second refusal.
 */
export function missingArgumentError(
  name: string,
  missing: readonly string[],
  advertisedValues: AdvertisedValues,
): string {
  const named = missing.map((key) => {
    const values = advertisedValues(key);
    return `"${key}"${values && values.length > 0 ? ` (one of: ${values.join(', ')})` : ''}`;
  });
  const plural = missing.length > 1 ? 's' : '';
  const pronoun = missing.length > 1 ? 'them' : 'it';
  return (
    `Error: ${name} is missing required argument${plural} ${named.join(', ')}. ` +
    `Resend the call with ${pronoun} set.`
  );
}

/**
 * The refusal for an argument the schema declares as a number or boolean that
 * arrived holding the call's own markup: the parameter block was cut off
 * mid-write, so the value swallowed the tags that followed it.
 *
 * The type sentence alone sends the model off guessing. `read_file` refused
 * `end_line` this way on 2026-11-14 and suggested "as 1" — a number that was
 * never sent, while the one that was (237) sat inside the value it was being
 * refused for. So this quotes what actually arrived.
 */
export function cutOffArgumentMismatch(
  name: string,
  key: string,
  expected: string,
  range: string,
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Markup evidence, not a guess. A numeric or boolean argument never holds a
  // tag, so a `<` in one means the block ran past its end; a value that starts
  // with `[` or `{` is the separate stringified-array mistake, which has its
  // own better sentence and can legitimately contain a `<` inside a string.
  if (!value.includes('<')) return undefined;
  const trimmed = value.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return undefined;
  const shown = JSON.stringify(value.length > 120 ? `${value.slice(0, 117)}…` : value);
  return (
    `Error: ${name}: "${key}" must be a JSON ${expected}${range}, not a string. ` +
    `It received ${shown} — that is the call's own markup, so the block was cut off ` +
    `mid-write and the value swallowed the tags after it. Resend the call with every ` +
    `argument written out in full; the number you meant is inside the text quoted above.`
  );
}

/** One issue from a Zod refusal, narrowed to the fields the sentences read. */
interface ZodIssueLike {
  code?: unknown;
  path?: readonly (string | number)[];
  message?: unknown;
  expected?: unknown;
  maximum?: unknown;
  minimum?: unknown;
  origin?: unknown;
  keys?: readonly string[];
  values?: readonly unknown[];
  /** A union's own per-shape refusals (Zod 4 `invalid_union.errors`). */
  errors?: unknown;
  /** The field a discriminated union switches on. */
  discriminator?: unknown;
}

/** Issues that get their own line before the rest are only counted. */
const ISSUES_PER_REFUSAL = 8;

/**
 * The result string for a tool call that threw: one plain line per rejected
 * argument, never the JSON block Zod prints by itself.
 *
 * Zod's own `error.message` is a pretty-printed array of issues — hundreds of
 * characters of braces and quotes for a call that got one field wrong — and a
 * model reads that as data rather than as an instruction, so it re-sends the
 * same shape (ask_user and message_chat both did, audited 2026-10-27). Each line
 * here names the argument path, what is wrong with it, the limit, and what to
 * resend.
 *
 * `args` is the call as the registry handed it to the handler, so a length is
 * measured from the value rather than guessed: `is 312 characters; the limit is
 * 200` tells the model how much to cut, where `too big` leaves that to it.
 */
export function toolErrorText(
  name: string,
  error: unknown,
  args?: Record<string, unknown>,
): string {
  if (error instanceof WorkspacePathMissingError) {
    return `Error: ${formatPathMiss(name, error.requestedPath, error, error.workspaceRoot)}`;
  }
  if (error instanceof Error && error.name === 'GitDiscoveryError') {
    return `Error: ${name}: ${error.message}`;
  }
  if (!(error instanceof z.ZodError)) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return describeToolIssues(name, error.issues, args).join('\n');
}

/** The issue lines shared by thrown tool errors and tools with extra prefixes. */
export function describeToolIssues(
  name: string,
  issues: readonly ZodIssue[],
  args?: Record<string, unknown>,
): string[] {
  const lines = issues
    .slice(0, ISSUES_PER_REFUSAL)
    .map((issue) => `Error: ${name} ${describeIssue(issue as unknown as ZodIssueLike, args)}`);
  const rest = issues.length - lines.length;
  if (rest > 0) lines.push(`Error: ${name} has ${rest} more argument problem(s).`);
  if (lines.length > 1) lines.push('Resend the call with these fixed.');
  return lines;
}

/** One issue as the sentence the model can act on. */
function describeIssue(issue: ZodIssueLike, args?: Record<string, unknown>): string {
  const path = Array.isArray(issue.path) ? issue.path : [];
  const named = argumentPath(path);
  const at = named ? `${named} ` : '';
  const value = valueAt(args, path);
  switch (issue.code) {
    case 'too_big':
      return tooBigError(at, issue, value);
    case 'too_small':
      return tooSmallError(at, issue, value);
    case 'invalid_value': {
      const values = Array.isArray(issue.values) ? issue.values : [];
      return `${at}must be one of ${values.map(issueValueText).join(', ')}; received ${issueValueText(value)}.`;
    }
    case 'invalid_type':
      return value === undefined
        ? `${at}is missing; the schema wants ${typeNoun(issue.expected)}.`
        : `${at}is ${shapeOf(value)}, not ${typeNoun(issue.expected)}. Resend it in the shape the schema declares.`;
    case 'unrecognized_keys': {
      const keys = Array.isArray(issue.keys) ? issue.keys : [];
      const listed = keys.map((key) => `"${key}"`).join(', ');
      return keys.length === 1
        ? `${at}has a field it did not declare: ${listed}. Remove it and resend.`
        : `${at}has fields it did not declare: ${listed}. Remove them and resend.`;
    }
    case 'invalid_union':
      return unionError(at, named, issue, args, path);
    default:
      // A custom refine ("A single-select question can recommend only one
      // option") already states the rule and the fix, so its message is used
      // as written: rewording it is how the advice gets lost.
      return `${at}${issue.message ?? 'was refused'}`;
  }
}

function issueValueText(value: unknown): string {
  if (value === undefined) return '<missing>';
  return JSON.stringify(value) ?? String(value);
}

/**
 * The refusal for a value that matched none of a union's shapes.
 *
 * A discriminated union given an unknown `kind` reports `invalid_union` with no
 * values at all ("No matching discriminator"), so `manage_jobs` answered a bad
 * schedule with `schedule.kind Invalid input` and the model guessed again (lab
 * run U3a, 2026-11-09). Where the schema is one this repo owns, the accepted
 * kinds are already in the message the schema wrote for itself (see
 * `kindUnionError` in `jobs/jobSchema.ts`), and a message that is not Zod's
 * placeholder is used as written. A plain union carries its per-shape refusals,
 * so its literals are gathered here instead.
 */
function unionError(
  at: string,
  named: string,
  issue: ZodIssueLike,
  args: Record<string, unknown> | undefined,
  path: readonly (string | number)[],
): string {
  const message = typeof issue.message === 'string' ? issue.message : '';
  if (message && message !== 'Invalid input') {
    // The schema wrote this refusal itself, accepted values and no: rewording
    // it is how the advice gets lost.
    return `${at}${message}`;
  }
  const gathered = gatherUnionValues(issue);
  if (gathered.values.length === 0) {
    // Nothing was learned about the accepted set: say what is known, not nothing.
    return `${at}is not one of the shapes this field accepts. Check this tool's description for the shapes it takes.`;
  }
  const key = typeof issue.discriminator === 'string' ? issue.discriminator : gathered.key;
  const last = path[path.length - 1];
  const listed = [...new Set(gathered.values)].map(issueValueText).join(', ');
  const where = key !== undefined && last !== key ? (named ? `${named}.${key} ` : `${key} `) : at;
  const received =
    key !== undefined && last !== key ? valueAt(args, [...path, key]) : valueAt(args, path);
  return (
    `${where}must be one of ${listed}` +
    `${received === undefined ? '' : `; received ${issueValueText(received)}`}.`
  );
}

/**
 * The literals a union's own refusals name, and the single field they all
 * disagree on (`kind` for a union of `{kind: …}` shapes, undefined when they
 * disagree on more than one field, which is a shape problem rather than a value).
 */
function gatherUnionValues(issue: ZodIssueLike): { key?: string; values: string[] } {
  const found: { key?: string; values: string[] } = { values: [] };
  const keys = new Set<string>();
  const visit = (raw: unknown, path: readonly (string | number)[] = []) => {
    if (raw === null || typeof raw !== 'object') return;
    const node = raw as ZodIssueLike;
    const here = Array.isArray(node.path) ? [...path, ...node.path] : path;
    if (node.code === 'invalid_value' && Array.isArray(node.values)) {
      for (const value of node.values) found.values.push(String(value));
      const leaf = here[here.length - 1];
      if (typeof leaf === 'string') keys.add(leaf);
    }
    if (Array.isArray(node.errors)) {
      for (const group of node.errors) {
        if (Array.isArray(group)) group.forEach((inner) => visit(inner, here));
        else visit(group, here);
      }
    }
  };
  visit(issue);
  found.values = [...new Set(found.values)];
  if (keys.size === 1) found.key = [...keys][0];
  return found;
}

function tooBigError(at: string, issue: ZodIssueLike, value: unknown): string {
  const limit = issue.maximum;
  switch (issue.origin) {
    case 'string':
      return typeof value === 'string'
        ? `${at}is ${value.length} characters; the limit is ${limit}. Shorten it and resend.`
        : `${at}is longer than the limit of ${limit} characters. Shorten it and resend.`;
    case 'array':
      return Array.isArray(value)
        ? `${at}has ${value.length} entries; the limit is ${limit}. Trim it and resend.`
        : `${at}has more than the limit of ${limit} entries. Trim it and resend.`;
    default:
      return typeof value === 'number'
        ? `${at}is ${value}; the limit is ${limit}. Lower it and resend.`
        : `${at}is above the limit of ${limit}. Lower it and resend.`;
  }
}

function tooSmallError(at: string, issue: ZodIssueLike, value: unknown): string {
  const floor = issue.minimum;
  switch (issue.origin) {
    case 'string':
      return typeof value === 'string'
        ? `${at}is ${value.length} characters; the minimum is ${floor}. Lengthen it and resend.`
        : `${at}is shorter than the minimum of ${floor} characters. Lengthen it and resend.`;
    case 'array':
      return Array.isArray(value)
        ? `${at}has ${value.length} entries; the minimum is ${floor}. Add entries and resend.`
        : `${at}has fewer than the minimum of ${floor} entries. Add entries and resend.`;
    default:
      return typeof value === 'number'
        ? `${at}is ${value}; the minimum is ${floor}. Raise it and resend.`
        : `${at}is below the minimum of ${floor}. Raise it and resend.`;
  }
}

/** `questions[0].options[0].description`, or '' for a top-level issue. */
function argumentPath(path: readonly (string | number)[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') {
      out += `[${part}]`;
      continue;
    }
    out += out ? `.${part}` : part;
  }
  return out;
}

/** The value the call actually sent at this path, so a limit can be measured. */
function valueAt(source: unknown, path: readonly (string | number)[]): unknown {
  let current = source;
  for (const part of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[String(part)];
  }
  return current;
}

/** "array" becomes "an array": the article is what makes the line read as English. */
function typeNoun(expected: unknown): string {
  const text = typeof expected === 'string' && expected.length > 0 ? expected : 'the declared type';
  return /^[aeiou]/u.test(text) ? `an ${text}` : `a ${text}`;
}

/** "a string", "an array", "null" — what the call sent, in the model's words. */
function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}
