import type { ToolDefinition } from '../llm/types';

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
  | 'delegate';

export interface ToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool args are schema-validated at call site
  (args: Record<string, unknown>, context?: ToolHandlerContext): Promise<string>;
}

export interface ToolHandlerContext {
  beforeMutate(paths: string[]): void;
  /** Caller's AbortSignal, threaded through for long-running tools (e.g. ask_local_agent). */
  abortSignal?: AbortSignal;
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
  handler: ToolHandler;
  mutation?: ToolMutation;
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
  definitions(allowed: Set<ToolPermission>): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => allowed.has(t.permission) && (t.advertise === undefined || t.advertise()))
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
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`ToolRegistry: unknown tool "${name}"`);
    if (!allowed.has(tool.permission)) {
      throw new Error(
        `ToolRegistry: tool "${name}" requires permission "${tool.permission}" which is not granted for this Forge turn`,
      );
    }
    return tool.handler(args, context);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
