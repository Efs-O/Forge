import type { ToolDefinition } from '../llm/types';
import type { WorkerRunRequest, WorkerRunResult } from '../workers/types';

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
  | 'delegate'
  | 'cloud-worker';

export interface ToolApprovalMetadata {
  dangerous?: boolean;
  detail?: string;
}

export interface ToolScope {
  allowedNames: ReadonlySet<string>;
  validate?: (tool: RegisteredTool, args: Record<string, unknown>) => void;
  validateMutationPaths?: (paths: readonly string[]) => void;
  transformResult?: (tool: RegisteredTool, result: string) => string;
  onResult?: (tool: RegisteredTool, args: Record<string, unknown>, result: string) => void;
}

export interface ToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool args are schema-validated at call site
  (args: Record<string, unknown>, context?: ToolHandlerContext): Promise<string>;
}

export interface ToolHandlerContext {
  beforeMutate(paths: string[]): void;
  /** Caller's AbortSignal, threaded through for long-running tools (e.g. ask_local_agent). */
  abortSignal?: AbortSignal;
  runWorkers?: (request: WorkerRunRequest) => Promise<WorkerRunResult>;
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
  approval?: (args: Record<string, unknown>) => ToolApprovalMetadata;
  /** When present, called during definitions() to suppress advertisement without removing the tool. */
  advertise?: () => boolean;
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

  definitions(allowed: Set<ToolPermission>, scope?: ToolScope): ToolDefinition[] {
    return [...this.tools.values()]
      .filter(
        (t) =>
          this.isAllowed(t, allowed) &&
          (!scope || scope.allowedNames.has(t.definition.function.name)) &&
          (t.advertise === undefined || t.advertise()),
      )
      .map((t) => t.definition);
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
    scope?: ToolScope,
    scopeAlreadyValidated = false,
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`ToolRegistry: unknown tool "${name}"`);
    if (scope && !scope.allowedNames.has(name)) {
      throw new Error(`ToolRegistry: tool "${name}" is outside the active tool scope`);
    }
    this.assertAllowed(tool, allowed, args);
    if (!scopeAlreadyValidated) scope?.validate?.(tool, args);
    const result = await tool.handler(args, context);
    return scope?.transformResult ? scope.transformResult(tool, result) : result;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
