import type { ToolDefinition } from '../llm/types';
import { recordNativeLazyTool } from './lazyToolGroups';
import {
  advertisedValues,
  brokenJsonArgumentMismatch,
  cutOffArgumentMismatch,
  missingArgumentError,
} from './toolErrorText';
import { recoverFoldedParameters, repairParameterMarkup } from './toolArgumentMarkup';
import { applyArgumentRewrites, unknownArgumentRefusal } from './argumentAliases';
import { editFileStringError } from './editsJsonError';
import { repairDeclaredJsonArguments, type JsonArgumentRepairReport } from './jsonArgumentRepair';
/** The declarations live in `toolContract.ts`; re-exported from here so every
 *  consumer that has always imported them from the registry keeps working. */
export {
  ALL_TOOL_PERMISSIONS,
  type ToolPermission,
  type ToolApprovalMetadata,
  type MultimodalToolResult,
  type ToolHandlerResult,
  type ToolHandler,
  type ToolHandlerContext,
  type RegisteredTool,
} from './toolContract';
import {
  type ToolPermission,
  type ToolHandlerResult,
  type ToolHandlerContext,
  type RegisteredTool,
} from './toolContract';
/** A declared property, narrowed to the two fields the refusals read. */
type DeclaredProperty = {
  type?: unknown;
  items?: unknown;
  minimum?: unknown;
  maximum?: unknown;
  exclusiveMinimum?: unknown;
  exclusiveMaximum?: unknown;
};

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    default:
      return true;
  }
}

function jsonTypeExample(type: string, schema: DeclaredProperty): string | undefined {
  switch (type) {
    case 'array':
      return '[]';
    case 'object':
      return '{}';
    case 'integer':
      return String(typeof schema.minimum === 'number' ? schema.minimum : 1);
    case 'number':
      return String(
        typeof schema.minimum === 'number'
          ? schema.minimum
          : typeof schema.exclusiveMinimum === 'number'
            ? schema.exclusiveMinimum + 0.1
            : 0,
      );
    case 'boolean':
      // Naming one example value used to be a trap: a model that meant `true` read "Resend the
      // call with background as false" and obeyed it. One lab arm hit that four times and then
      // gave up on background jobs altogether (T2 arm A2).
      return 'true or false';
    case 'string':
      return '"text"';
    default:
      return undefined;
  }
}

function jsonTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/**
 * Refusal text when an array argument is well-formed at the top level but its
 * ELEMENTS are the wrong kind: `ask_user` takes `questions` as an array of
 * `{prompt, options}` objects, and an agent that had just been told to send "a
 * bare array" sent `["", ""]` — valid JSON, an array, and still useless to the
 * handler. The top-level array check alone cannot see it.
 *
 * Only the element TYPE is judged, never the keys inside an element: a
 * half-built OBJECT still reaches the handler, which owns the field-level
 * message (`apply_line_edits` names the operation and the missing field).
 * For an entry that is not an object at all, THIS refusal is the one the model
 * sees — `invalidArgs` runs before the handler (`ToolDispatch.ts:225`, handler
 * at `:293`) — and it is the better of the two: it names the field, the entry
 * index and the type, where the handler's own `operation N must be an object`
 * would name only the index. The handler keeps that branch for callers that
 * dispatch without this pre-check (`contactWebTools`, the benchmark tool host).
 * An earlier version of this comment claimed the opposite, which made the
 * ordering look like a bug when it is the intended precedence (audit F3,
 * 2026-10-03).
 */
function invalidArrayItems(
  name: string,
  declared: Array<[string, DeclaredProperty]>,
  present: Record<string, unknown>,
): string | undefined {
  for (const [key, schema] of declared) {
    if (schema?.type !== 'array') continue;
    const value = present[key];
    if (!Array.isArray(value)) continue;
    const itemSchema =
      schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)
        ? (schema.items as { type?: unknown })
        : undefined;
    if (itemSchema?.type !== 'object') continue;
    const bad = value
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item === null || typeof item !== 'object' || Array.isArray(item));
    if (bad.length === 0) continue;
    const where = bad
      .slice(0, 3)
      .map(
        ({ item, index }) =>
          `entry ${index + 1} (${item === null ? 'null' : Array.isArray(item) ? 'array' : typeof item})`,
      )
      .join(', ');
    const more = bad.length > 3 ? ` and ${bad.length - 3} more` : '';
    const message = `Error: ${name} "${key}" entries must be objects, not ${where}${more}. Resend each entry as an object with the fields the schema declares.`;
    if (message.length <= 200) return message;
    const shorter = `Error: ${name} "${key}" has entries that are not objects. Resend each entry as an object.`;
    // Same three-tier bound as the boolean refusal: name the field when it fits,
    // else a generic that still names the tool and the fix.
    return shorter.length <= 200
      ? shorter
      : 'Error: invalid array argument; its entries must be objects.';
  }
  return undefined;
}

function updatePlanFieldError(args: Record<string, unknown>): string | undefined {
  const unexpectedTopLevel = Object.keys(args).find((key) => key !== 'items');
  if (unexpectedTopLevel) {
    return `Error: update_plan has unexpected top-level field "${unexpectedTopLevel}"; remove it.`;
  }
  if (args['items'] === undefined) {
    return 'Error: update_plan is missing required "items" at the top level.';
  }
  if (!Array.isArray(args['items'])) return undefined;
  for (const [index, item] of args['items'].entries()) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const unexpected = Object.keys(entry).find((key) => key !== 'text' && key !== 'status');
    if (unexpected) {
      return `Error: update_plan has unexpected field "${unexpected}" at items[${index}]; remove it.`;
    }
    const missing = ['text', 'status'].filter((key) => entry[key] === undefined);
    if (missing.length > 0) {
      return `Error: update_plan is missing required field${missing.length > 1 ? 's' : ''} ${missing.map((key) => `"${key}"`).join(', ')} at items[${index}].`;
    }
  }
  return undefined;
}

function missingPathError(name: string): string {
  const shape =
    name === 'edit_file'
      ? 'Accepted shape: { "path": "...", "edits": [{ "old_str": "...", "new_str": "..." }] } or { "path": "...", "old_str": "...", "new_str": "..." }.'
      : `Accepted shape: { "path": "...", "content": "..." }.`;
  return `Error: missing required \`path\`. ${shape}`;
}

/**
 * Central catalog of available tools.
 * Tools are registered with a permission tier and a strict JSON Schema.
 * The unified Forge turn checks permission before dispatch.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private _lastJsonArgumentRepairs: JsonArgumentRepairReport = {
    replacedKeys: [],
    repairs: [],
    total: 0,
  };

  /** Read and clear the JSON-argument repairs recorded by the last `invalidArgs` call. */
  takeLastJsonArgumentRepairs(): JsonArgumentRepairReport {
    const r = this._lastJsonArgumentRepairs;
    this._lastJsonArgumentRepairs = { replacedKeys: [], repairs: [], total: 0 };
    return r;
  }

  register(tool: RegisteredTool): void {
    const name = tool.definition.function.name;
    if (this.tools.has(name)) {
      throw new Error(`ToolRegistry: duplicate tool name "${name}"`);
    }
    if (
      (tool.permission === 'write' || tool.permission === 'delete') &&
      !tool.mutation &&
      !tool.workspaceStateMutation
    ) {
      throw new Error(`ToolRegistry: mutating tool "${name}" must declare mutation metadata`);
    }
    if (tool.mutation && tool.workspaceStateMutation) {
      throw new Error(`ToolRegistry: tool "${name}" cannot mix file and workspace-state mutations`);
    }
    this.tools.set(name, tool);
    recordNativeLazyTool(name);
  }

  /**
   * Refusal text when `args` omits a property the tool's schema requires, or
   * sends a declared boolean or array as anything else; else undefined.
   * llama-server's grammar makes such a call impossible, but not every backend
   * constrains decoding. A missing required field can otherwise fail inside
   * the handler without naming the field. A malformed `background` boolean
   * also used to silently select the foreground path.
   */
  invalidArgs(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    context?: Pick<ToolHandlerContext, 'conversationId' | 'clankerMode'>,
  ): string | undefined {
    const { name, parameters } = tool.definition.function;
    // JSON.parse can hand back `null` for a call whose arguments were "null".
    const present: Record<string, unknown> = typeof args === 'object' && args !== null ? args : {};
    const markupError = repairParameterMarkup(name, parameters.properties, present);
    if (markupError) return markupError;
    recoverFoldedParameters(parameters.properties, present); // leftovers: the leak refusal
    // The advertised schema, not the static one: `describe()` is what the model
    // was shown this turn, so a rename must target an argument it could really
    // have used. The unknown-key refusal below reads the same object.
    const advertisedParameters = tool.describe ? tool.describe().function.parameters : parameters;
    applyArgumentRewrites(name, advertisedParameters.properties, present);
    // A quoted boolean is the largest single refusal class we measured (11 hits in one clean
    // window on `shell background` alone, and the same shape on `read_file numbered`), and it is
    // never ambiguous: its lowercase form is "true" or "false", and the property is declared
    // boolean. Coerce it here — `present` is the live `args` object, so the handler receives the
    // real boolean and the call simply works. Case is ignored because the 0.17.147 lab refused
    // `grep_search` `ignore_case: "True"` (Python's spelling) twice. Surrounding spaces are
    // stripped for the same reason: `"TRUE "` is the same claim as `"true"`, and the model that
    // emitted it meant the job to run in the background. Anything else ("yes", "1") stays a refusal.
    if (typeof parameters.properties === 'object' && parameters.properties !== null) {
      for (const [key, schema] of Object.entries(
        parameters.properties as Record<string, DeclaredProperty>,
      )) {
        if (schema?.type !== 'boolean') continue;
        const value = present[key];
        if (typeof value !== 'string') continue;
        const lowercase = value.trim().toLowerCase();
        if (lowercase === 'true') present[key] = true;
        else if (lowercase === 'false') present[key] = false;
      }
    }
    // An array or object argument that arrived as hand-written JSON text is the
    // same call with one slip in it. Repair the three escape slips whose meaning
    // is certain and re-read the text; the handler then gets the real value and
    // the call runs. Everything else stays a refusal, with the position named.
    // See `jsonArgumentRepair.ts` for the measurement and why the structural
    // slips are not repaired.
    this._lastJsonArgumentRepairs = repairDeclaredJsonArguments(parameters.properties, present);
    const preApproval = tool.refuseBeforeApproval?.(present, context);
    if (preApproval) return preApproval;
    if (name === 'edit_file') {
      const stringArrayError = editFileStringError(present);
      if (stringArrayError) return stringArrayError;
    }
    if (name === 'update_plan') {
      const fieldError = updatePlanFieldError(present);
      if (fieldError) return fieldError;
    }
    const advertisedProperties = advertisedParameters.properties;
    if (
      advertisedParameters.additionalProperties === false &&
      typeof advertisedProperties === 'object' &&
      advertisedProperties !== null
    ) {
      const declaredKeys = Object.keys(advertisedProperties);
      const unknown = Object.keys(present).filter(
        (key) => !Object.hasOwn(advertisedProperties, key) && present[key] !== undefined,
      );
      if (unknown.length > 0) {
        return unknownArgumentRefusal(
          name,
          unknown,
          declaredKeys,
          advertisedProperties as Record<string, unknown>,
          present,
        );
      }
    }
    const required = Array.isArray(parameters.required) ? parameters.required : [];
    const missing = required.filter(
      (key): key is string => typeof key === 'string' && present[key] === undefined,
    );
    if (missing.length > 0) {
      if (missing.includes('path') && ['edit_file', 'write_file'].includes(name)) {
        return missingPathError(name);
      }
      return missingArgumentError(
        name,
        missing,
        // The enum the model was shown this turn, not the one in the static
        // schema — `toolErrorText.ts` owns that lookup and the sentence.
        advertisedValues(
          tool.describe ? tool.describe().function.parameters : tool.definition.function.parameters,
        ),
      );
    }
    const properties = parameters.properties;
    if (typeof properties !== 'object' || properties === null) return undefined;
    const declared = Object.entries(properties as Record<string, DeclaredProperty>).filter(
      ([key]) => present[key] !== undefined,
    );
    for (const [key, schema] of declared) {
      const expected = schema?.type;
      const value = present[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        if (expected === 'integer' && !Number.isInteger(value)) {
          return `Error: ${name}: "${key}" must be an integer${numericRange(schema)}. Resend it in that range.`;
        }
        const min = typeof schema.minimum === 'number' ? schema.minimum : undefined;
        const max = typeof schema.maximum === 'number' ? schema.maximum : undefined;
        const exclusiveMin =
          typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : undefined;
        const exclusiveMax =
          typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : undefined;
        if (
          (min !== undefined && value < min) ||
          (max !== undefined && value > max) ||
          (exclusiveMin !== undefined && value <= exclusiveMin) ||
          (exclusiveMax !== undefined && value >= exclusiveMax)
        ) {
          return `Error: ${name}: "${key}" must be within ${numericRangeText(schema)}. Resend it in that range.`;
        }
      }
      // A union type (e.g. ["string","number"] for an HWND the model may send
      // either way): every listed type is checked, so a boolean or an object
      // cannot slip through a hole in the schema the way an unread type would.
      if (Array.isArray(expected)) {
        const list = expected.filter((t): t is string => typeof t === 'string');
        if (list.length === 0 || list.some((t) => matchesJsonType(present[key], t))) continue;
        return (
          `Error: ${name}: "${key}" must be a JSON ${list.join(' or ')}, not ` +
          `${jsonTypeName(present[key])}. Resend the call with ${key} as ` +
          `${jsonTypeExample(list[0], schema) ?? 'a value of one of those types'}.`
        );
      }
      if (typeof expected !== 'string' || matchesJsonType(present[key], expected)) continue;
      const example = jsonTypeExample(expected, schema);
      if (example) {
        const range =
          (expected === 'integer' || expected === 'number') &&
          (typeof schema.minimum === 'number' ||
            typeof schema.maximum === 'number' ||
            typeof schema.exclusiveMinimum === 'number' ||
            typeof schema.exclusiveMaximum === 'number')
            ? ` in range ${numericRangeText(schema)}`
            : '';
        const cutOff = cutOffArgumentMismatch(name, key, expected, range, present[key]);
        if (cutOff) return cutOff;
        const broken = brokenJsonArgumentMismatch(name, key, expected, present[key]);
        if (broken) return broken;
        return (
          `Error: ${name}: "${key}" must be a JSON ${expected}${range}, not ${jsonTypeName(present[key])}. ` +
          `Resend the call with ${key} as ${example}.`
        );
      }
    }
    return invalidArrayItems(name, declared, present);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Returns definitions for all tools the current permission set allows and that pass their advertise predicate. */
  requiredPermissions(
    tool: RegisteredTool,
    args?: Record<string, unknown>,
  ): readonly ToolPermission[] {
    return [
      ...new Set([
        tool.permission,
        ...(tool.additionalPermissions ?? []),
        ...(args ? (tool.additionalPermissionsForArgs?.(args) ?? []) : []),
      ]),
    ];
  }

  isAllowed(tool: RegisteredTool, allowed: ReadonlySet<ToolPermission>): boolean {
    return this.requiredPermissions(tool).every((permission) => allowed.has(permission));
  }

  assertAllowed(
    tool: RegisteredTool,
    allowed: ReadonlySet<ToolPermission>,
    args?: Record<string, unknown>,
  ): void {
    const basePermissions = [tool.permission, ...(tool.additionalPermissions ?? [])];
    const missingBase = basePermissions.filter((permission) => !allowed.has(permission));
    const argumentPermissions = args ? (tool.additionalPermissionsForArgs?.(args) ?? []) : [];
    const missingFromArgs = argumentPermissions.filter((permission) => !allowed.has(permission));
    if (missingBase.length === 0 && missingFromArgs.length === 0) return;
    const name = tool.definition.function.name;
    if (missingBase.length === 0 && args && missingFromArgs.length > 0) {
      const action = args['action'];
      const permissionText = missingFromArgs.map((permission) => `"${permission}"`).join(', ');
      if (typeof action === 'string') {
        throw new Error(
          `ToolRegistry: ${name} action "${action}" needs the ${permissionText} permission, ` +
            `which this conversation does not have.`,
        );
      }
      throw new Error(
        `ToolRegistry: ${name} arguments need the ${permissionText} permission, ` +
          `which this conversation does not have.`,
      );
    }
    const alternative = name.startsWith('browser_')
      ? ' Use render_html_to_image with mode: "preview".'
      : '';
    throw new Error(
      `ToolRegistry: tool "${name}" is not available in this conversation.${alternative}`,
    );
  }

  definitions(allowed: Set<ToolPermission>): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => this.isAllowed(t, allowed) && (t.advertise === undefined || t.advertise()))
      .map((t) => (t.describe ? t.describe() : t.definition));
  }

  /**
   * Dispatches a tool call by name. Throws if the tool is unknown or
   * the required permission is not in the allowed set.
   */
  async dispatch(
    name: string,
    args: Record<string, unknown>,
    allowed: Set<ToolPermission>,
    context?: ToolHandlerContext,
  ): Promise<ToolHandlerResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`ToolRegistry: unknown tool "${name}"`);
    this.assertAllowed(tool, allowed, args);
    return tool.handler(args, context);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Tools flagged `requiresVision`, keyed by name → refusal-message builder.
   * The single source of truth for the vision gate (B8): ModelTurn derives
   * both the advertise filter and the dispatch refusal map from this, so the
   * two halves cannot drift apart.
   */
  visionGated(): ReadonlyMap<string, (modelName: string) => string> {
    const map = new Map<string, (modelName: string) => string>();
    for (const tool of this.tools.values()) {
      if (tool.requiresVision) map.set(tool.definition.function.name, tool.requiresVision);
    }
    return map;
  }
}

function numericRange(schema: DeclaredProperty): string {
  const text = numericRangeText(schema);
  return text ? ` from ${text}` : '';
}

function numericRangeText(schema: DeclaredProperty): string {
  const min = typeof schema.minimum === 'number' ? schema.minimum : undefined;
  const max = typeof schema.maximum === 'number' ? schema.maximum : undefined;
  const exclusiveMin =
    typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum : undefined;
  const exclusiveMax =
    typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum : undefined;
  if (min !== undefined && max !== undefined) return `${min} to ${max}`;
  if (min !== undefined) return `at least ${min}`;
  if (max !== undefined) return `at most ${max}`;
  if (exclusiveMin !== undefined) return `greater than ${exclusiveMin}`;
  if (exclusiveMax !== undefined) return `less than ${exclusiveMax}`;
  return 'the declared range';
}
