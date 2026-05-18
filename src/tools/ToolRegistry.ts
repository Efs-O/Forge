import type { ToolDefinition } from '../llm/types';

export type ToolPermission = 'read' | 'write' | 'delete' | 'terminal' | 'search' | 'git';

export interface ToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool args are schema-validated at call site
  (args: Record<string, unknown>): Promise<string>;
}

export interface RegisteredTool {
  definition: ToolDefinition;
  permission: ToolPermission;
  handler: ToolHandler;
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
    this.tools.set(name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Returns definitions for all tools the current permission set allows. */
  definitions(allowed: Set<ToolPermission>): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => allowed.has(t.permission))
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
  ): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`ToolRegistry: unknown tool "${name}"`);
    if (!allowed.has(tool.permission)) {
      throw new Error(`ToolRegistry: tool "${name}" requires permission "${tool.permission}" which is not granted for this Forge turn`);
    }
    return tool.handler(args);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}

export const FORGE_PERMISSIONS = new Set<ToolPermission>([
  'read',
  'write',
  'delete',
  'terminal',
  'search',
  'git',
]);
