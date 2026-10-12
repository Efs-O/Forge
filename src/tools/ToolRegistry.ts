import type { ChatMessage, ContentPart, ToolDefinition } from '../llm/types';
import type { PlanItem } from '../sidebar/sessionTypes';
import { recordNativeLazyTool } from './lazyToolGroups';
import { invalidArrayJsonPosition } from './argCoercion';
import type { ToolOutputLimits } from './toolOutputLimits';
import type { ConversationRuntime } from '../sidebar/sessionTypes';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';

export const ALL_TOOL_PERMISSIONS = [
  'read',
  'write',
  'delete',
  'terminal',
  'headless',
  'search',
  'fetch',
  'git-read',
  'git-write',
  'browser',
  'desktop',
  'delegate',
] as const;

export type ToolPermission = (typeof ALL_TOOL_PERMISSIONS)[number];

export interface ToolApprovalMetadata {
  dangerous?: boolean;
  detail?: string;
  /**
   * What the agent should do instead, shown back to it when the user declines.
   *
   * The shell classifier already knows the sanctioned alternative for every
   * rule it matches, and that string used to be shown only for `refused`
   * commands (`shellTool.ts`). A declined `dangerous` call came back as a bare
   * `User declined: shell`, so the agent retried the same command or invented
   * another one; the hint is what turns a refusal into a course change.
   */
  declineHint?: string;
}

export interface MultimodalToolResult {
  text: string;
  content: ContentPart[];
}

export type ToolHandlerResult = string | MultimodalToolResult;

export interface ToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool args are schema-validated at call site
  (args: Record<string, unknown>, context?: ToolHandlerContext): Promise<ToolHandlerResult>;
}

export interface ToolHandlerContext {
  beforeMutate(paths: string[]): void;
  /** Caller's AbortSignal, threaded through for long-running tools. */
  abortSignal?: AbortSignal;
  /** Conversation the call belongs to. */
  conversationId?: string;
  /** Current call id, used by shell spill files. */
  toolCallId?: string;
  /** Resolved model name, used by model-specific tool-group refusals. */
  modelName?: string;
  /** Whether the resolved model accepts image input. */
  isVisionModel?: boolean;
  /** Stable, configuration-derived output bounds for the selected model. */
  outputLimits?: ToolOutputLimits;
  /** Full raw transcript for the current conversation. Read-only tools may use
   * this to recover an earlier result without widening the model prompt. */
  conversationMessages?: readonly ChatMessage[];
  /**
   * Records the conversation's task plan (`update_plan`).
   *
   * A callback rather than a store handle, so `ToolDispatch` never gains one:
   * `ModelTurn` owns the live conversation and supplies this closure, exactly
   * as it already does for `recordFileDiff`. The host stamps the timestamp —
   * the tool supplies items only.
   */
  setPlan?: (items: PlanItem[]) => void;
  tellArrived?: (callback: () => void) => () => void;
  /** Active chat/checkpoint supplied by ModelTurn for session-scoped agent tools. */
  conversation?: ConversationRuntime;
  checkpoint?: CheckpointSession;
  persistConversation?: () => void;
}

export interface ToolMutation {
  /** Paths known from arguments/editor state before the handler executes. */
  paths(args: Record<string, unknown>): string[];
  /** Whether Forge should render file diffs for these paths. */
  showDiff?: boolean;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  permission: ToolPermission;
  additionalPermissions?: readonly ToolPermission[];
  /** Extra permissions derived only after validated call arguments exist. Never used for advertisement. */
  additionalPermissionsForArgs?: (args: Record<string, unknown>) => readonly ToolPermission[];
  handler: ToolHandler;
  mutation?: ToolMutation;
  /** Mutates VS Code workspace state, which has no file path for a checkpoint. */
  workspaceStateMutation?: boolean;
  approval?: (args: Record<string, unknown>) => ToolApprovalMetadata | undefined;
  /**
   * The handler's inputs and effects are structurally bounded enough to run
   * without the normal per-call confirmation. This must never be used for a
   * general shell or a mutable operation.
   */
  autoApprove?: boolean;
  /** Per-call auto approval for narrowly classified inputs such as read-only shell commands. */
  autoApproveIf?: (args: Record<string, unknown>) => boolean;
  /** When present, called during definitions() to suppress advertisement without removing the tool. */
  advertise?: () => boolean;
  /**
   * When present, called during definitions() to advertise a definition built
   * from current state instead of the static one — e.g. naming the delegation
   * targets in the current config.yaml. `definition` stays the canonical
   * literal (the tool-audit catalog extracts it statically), so this must
   * return the same tool name and schema shape.
   */
  describe?: () => ToolDefinition;
  /**
   * When present, the tool requires a vision projector (mmproj). Returns the
   * refusal message (naming the model) for a non-vision model. This is the
   * single source of truth for the vision gate: both the advertise filter and
   * the dispatch refusal derive from it, so the two halves cannot drift apart.
   */
  requiresVision?: (modelName: string) => string;
}

/** A declared property, narrowed to the two fields the refusals read. */
type DeclaredProperty = { type?: unknown; items?: unknown };

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

function editFileStringArrayError(args: Record<string, unknown>): string | undefined {
  if (typeof args['edits'] !== 'string') return undefined;
  let invalidJson = false;
  try {
    JSON.parse(args['edits']);
  } catch {
    invalidJson = true;
  }
  const pathMissing = args['path'] === undefined;
  const pathIssue = pathMissing ? 'missing required `path`. ' : '';
  const jsonIssue = invalidJson ? ' and is not valid JSON' : '';
  const shape = pathMissing
    ? ' Accepted shape: { "path": "...", "edits": [{ "old_str": "...", "new_str": "..." }] }.'
    : ' Send `edits` as a JSON array of { "old_str": "...", "new_str": "..." } objects.';
  return `Error: ${pathIssue}\`edits\` arrived as a string, not an array${jsonIssue}.${shape}`;
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
  invalidArgs(tool: RegisteredTool, args: Record<string, unknown>): string | undefined {
    const { name, parameters } = tool.definition.function;
    // JSON.parse can hand back `null` for a call whose arguments were "null".
    const present: Record<string, unknown> = typeof args === 'object' && args !== null ? args : {};
    if (name === 'edit_file') {
      const stringArrayError = editFileStringArrayError(present);
      if (stringArrayError) return stringArrayError;
    }
    if (name === 'update_plan') {
      const fieldError = updatePlanFieldError(present);
      if (fieldError) return fieldError;
    }
    const required = Array.isArray(parameters.required) ? parameters.required : [];
    const missing = required.filter(
      (key): key is string => typeof key === 'string' && present[key] === undefined,
    );
    if (missing.length > 0) {
      if (missing.includes('path') && ['append_file', 'edit_file', 'write_file'].includes(name)) {
        return missingPathError(name);
      }
      const names = missing.map((key) => `"${key}"`).join(', ');
      return `Error: ${name} is missing required argument${missing.length > 1 ? 's' : ''} ${names}. Resend the call with ${missing.length > 1 ? 'them' : 'it'} set.`;
    }
    const properties = parameters.properties;
    if (typeof properties !== 'object' || properties === null) return undefined;
    const declared = Object.entries(properties as Record<string, DeclaredProperty>).filter(
      ([key]) => present[key] !== undefined,
    );
    const notBoolean = declared
      .filter(([key, schema]) => schema?.type === 'boolean' && typeof present[key] !== 'boolean')
      .map(([key]) => {
        const value = present[key];
        // "True"/"False" are the observed Python-style spellings: show the
        // unquoted JSON boolean beside the field so the retry is unambiguous.
        const unquoted = value === 'True' ? 'true' : value === 'False' ? 'false' : undefined;
        const correction =
          unquoted !== undefined ? `use ${unquoted}` : 'use true or false without quotes';
        return `${key}=${JSON.stringify(value)}: ${correction}`;
      });
    if (notBoolean.length > 0) {
      const message = `Error: ${name} ${notBoolean.join(', ')}`;
      // Hard 200-char cap on the refusal; a pathological field list falls back
      // to a short generic that still names the tool and the fix.
      if (message.length <= 200) return message;
      const fallback = `Error: ${name} needs JSON true or false, not a string or number. Resend with bare booleans.`;
      return fallback.length <= 200
        ? fallback
        : 'Error: invalid boolean argument; use unquoted JSON true or false.';
    }
    // Structured arguments must arrive as arrays, not a JSON string inside one.
    const notArray = declared
      .filter(([key, schema]) => schema?.type === 'array' && !Array.isArray(present[key]))
      .map(([key]) => `"${key}" (got ${typeof present[key]})`);
    if (notArray.length > 0) {
      for (const [key, schema] of declared) {
        if (schema?.type !== 'array' || typeof present[key] !== 'string') continue;
        const position = invalidArrayJsonPosition(present[key]);
        if (position !== undefined) {
          return `Error: ${name} "${key}" is invalid JSON at position ${position}; correct the JSON array syntax.`;
        }
      }
      return `Error: ${name} needs a JSON array for ${notArray.join(', ')}, not a string holding one. Resend it as a bare array, e.g. ["a", "b"].`;
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
