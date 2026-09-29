import type { ChatMessage, ContentPart, ToolDefinition } from '../llm/types';
import type { PlanItem } from '../sidebar/sessionTypes';

export type ToolPermission =
  | 'read'
  | 'write'
  | 'delete'
  | 'terminal'
  | 'headless'
  | 'search'
  | 'fetch'
  | 'git-read'
  | 'git-write'
  | 'browser'
  | 'desktop'
  | 'delegate';

export interface ToolApprovalMetadata {
  dangerous?: boolean;
  detail?: string;
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
  /** Caller's AbortSignal, threaded through for long-running tools (e.g. ask_local_agent). */
  abortSignal?: AbortSignal;
  /** Conversation the call belongs to. ask_local_agent keys warm CLI agent
   *  sessions on it so repeat delegations reuse one process. */
  conversationId?: string;
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
  approval?: (args: Record<string, unknown>) => ToolApprovalMetadata | undefined;
  /**
   * The handler's inputs and effects are structurally bounded enough to run
   * without the normal per-call confirmation. This must never be used for a
   * general shell or a mutable operation.
   */
  autoApprove?: boolean;
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
    if ((tool.permission === 'write' || tool.permission === 'delete') && !tool.mutation) {
      throw new Error(`ToolRegistry: mutating tool "${name}" must declare mutation metadata`);
    }
    this.tools.set(name, tool);
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
    const missing = this.requiredPermissions(tool, args).filter(
      (permission) => !allowed.has(permission),
    );
    if (missing.length === 0) return;
    const requirement =
      missing.length === 1
        ? `permission "${missing[0]}"`
        : `permissions ${missing.map((permission) => `"${permission}"`).join(', ')}`;
    throw new Error(
      `ToolRegistry: tool "${tool.definition.function.name}" requires ${requirement} which is not granted for this Forge turn`,
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
