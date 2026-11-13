/**
 * The provider-facing boundary for tools an external MCP server advertises.
 *
 * Before this existed `mcpBridge.ts` handed the server's own name and schema
 * straight to the registry, so `vendor.tool.with.dots` was advertised verbatim.
 * Every OpenAI-compatible backend Forge speaks to rejects a function name
 * outside `[A-Za-z0-9_-]{1,64}` — and it rejects the whole request, not just
 * that tool, so one server's naming style could take every tool down with it.
 * A schema is the same story one level down: a construct the engine's
 * constrained decoding does not implement is silently dropped, so the model may
 * send anything there.
 *
 * Names can be fixed here: an unsafe name is mapped to a safe one and the
 * handler still calls the server with the name the server gave. A schema cannot
 * be repaired without changing what the tool accepts, so the constructs are
 * reported in the log, naming the tool and the construct, and never renamed.
 */

/** The shape every backend Forge speaks to accepts. OpenAI states this pattern
 *  for function names; llama.cpp derives its grammar rule name from the same
 *  class plus `-`, and Forge's own tools already fit it. */
const PROVIDER_SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The shortest ceiling any of them states. */
const MAX_NAME_LENGTH = 64;

/** One bridged tool's names: what the model is told, and what the server wants. */
export interface McpToolName {
  /** The name Forge advertises to the model. */
  readonly advertised: string;
  /** The name the server called its tool. `callTool` must send this one. */
  readonly external: string;
  /** True when the two differ, so the bridge can log the mapping once. */
  readonly mapped: boolean;
}

/**
 * A safe advertised name for one external tool.
 *
 * An already-safe name is kept exactly as the server wrote it — Forge does not
 * rename other people's tools to imitate its own. A name only changes when the
 * pattern would reject it, or when another registered tool already answers to
 * it (two servers both exporting `search`): then a suffix is added, because
 * `ToolRegistry.register` refuses a duplicate and the tool would disappear.
 *
 * `isTaken` is asked about every candidate, so the answer is unique in the
 * registry the caller registers into. The mapping is one-way by string but
 * reversible by record: the handler closes over `external`.
 */
export function forgeMcpToolName(
  externalName: string,
  isTaken: (candidate: string) => boolean = () => false,
): McpToolName {
  const safe = PROVIDER_SAFE_NAME.test(externalName);
  const base = safe
    ? externalName
    : externalName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'mcp_tool';
  let candidate = fit(base, '');
  for (let n = 2; isTaken(candidate); n += 1) candidate = fit(base, `_${n}`);
  return { advertised: candidate, external: externalName, mapped: candidate !== externalName };
}

/** Trim the base, never the suffix, so each attempt is still distinguishable. */
function fit(base: string, suffix: string): string {
  const budget = MAX_NAME_LENGTH - suffix.length;
  return `${base.length > budget ? base.slice(0, budget) : base}${suffix}`;
}

/**
 * JSON Schema keywords llama.cpp's converter has no rule for, measured against
 * `common/json-schema-to-grammar.cpp` at master (fetched 2026-11-13): it builds
 * rules for `allOf`, `anyOf`, `enum`, `const`, bounds and `pattern` (warning
 * "JSON schema conversion was incomplete" when a pattern is beyond GBNF), and
 * nothing else here. A dropped keyword means the constraint is not enforced,
 * so the model can violate it and the tool must cope with whatever arrives.
 */
const UNIMPLEMENTED_KEYWORDS: readonly string[] = [
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'patternProperties',
  'nullable',
  'uniqueItems',
  'multipleOf',
  'prefixItems',
  'dependentSchemas',
  'contentEncoding',
];

/** The formats it has rules for (`date`, `time`, `date-time`, `uuid`); it
 *  ignores every other `format`, so a `format: "email"` is a comment only. */
const IMPLEMENTED_FORMATS: ReadonlySet<string> = new Set(['date', 'time', 'date-time', 'uuid']);

/**
 * Where a subschema can sit inside a schema node. Only these positions are
 * walked: an MCP server's schema may carry annotation data (`x-ui: {...}`,
 * a legacy `dependencies` map, a `default` value), and treating any object as a
 * schema turns a property merely NAMED `oneOf` into the `oneOf` keyword.
 */
const SUBSCHEMA_MAP_KEYS: readonly string[] = [
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
];

/** Keywords whose value is one subschema (or, for `items`, an array of them). */
const SUBSCHEMA_KEYS: readonly string[] = [
  'items',
  'additionalItems',
  'additionalProperties',
  'contains',
  'propertyNames',
  'if',
  'then',
  'else',
  'not',
];

/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYS: readonly string[] = ['allOf', 'anyOf', 'oneOf'];

/**
 * The constructs in one external schema that constrained decoding will drop, as
 * short labels for the log: `$: oneOf`, `properties.where: format "email"`.
 * Empty means every constraint in the schema is one the engine can enforce.
 */
export function mcpSchemaGaps(schema: unknown): string[] {
  const gaps: string[] = [];
  visitSchema(schema, '', gaps);
  return gaps;
}

function visitSchema(node: unknown, path: string, gaps: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => visitSchema(item, `${path}[${index}]`, gaps));
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const here = path || '$';
  for (const keyword of UNIMPLEMENTED_KEYWORDS) {
    if (keyword in record) gaps.push(`${here}: ${keyword}`);
  }
  const format = record['format'];
  if (typeof format === 'string' && !IMPLEMENTED_FORMATS.has(format)) {
    gaps.push(`${here}: format "${format}"`);
  }
  const child = (key: string): string => (path ? `${path}.${key}` : key);
  for (const key of SUBSCHEMA_MAP_KEYS) {
    const map = record[key];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [name, subschema] of Object.entries(map as Record<string, unknown>)) {
      visitSchema(subschema, `${child(key)}.${name}`, gaps);
    }
  }
  for (const key of SUBSCHEMA_KEYS) {
    if (!(key in record)) continue;
    const value = record[key];
    if (Array.isArray(value)) {
      value.forEach((item, index) => visitSchema(item, `${child(key)}[${index}]`, gaps));
    } else {
      visitSchema(value, child(key), gaps);
    }
  }
  for (const key of SUBSCHEMA_LIST_KEYS) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    list.forEach((item, index) => visitSchema(item, `${child(key)}[${index}]`, gaps));
  }
}
