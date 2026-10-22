import type { ToolBudget } from '../tools/ToolBudget';
import type { ToolPermission, ToolRegistry } from '../tools/ToolRegistry';
import { isLazyGroupActive, lazyGroupForTool, lazyGroupNames } from '../tools/lazyToolGroups';

/** Known tool names from saved conversations and the consolidated tools that replace them. */
export const RETIRED_TOOLS: Readonly<
  Record<string, { readonly tool: string; readonly note: string }>
> = {
  exec_command: { tool: 'shell', note: 'one command line in "command"' },
  run_terminal: { tool: 'shell', note: 'one command line in "command"' },
  query_powershell: { tool: 'shell', note: 'one command line in "command"' },
  run_tests: { tool: 'shell', note: 'one command line in "command"' },
  run_build: { tool: 'shell', note: 'one command line in "command"' },
  git_status: { tool: 'git_read', note: 'operation="status"' },
  git_log: { tool: 'git_read', note: 'operation="log"' },
  git_diff: { tool: 'git_read', note: 'operation="diff"' },
  git_blame: { tool: 'git_read', note: 'operation="blame"' },
  git_show: { tool: 'git_read', note: 'operation="show"' },
  get_code_actions: { tool: 'code_intel', note: 'operation="code_actions"' },
  get_diagnostics: { tool: 'code_intel', note: 'operation="diagnostics"' },
  get_document_symbols: { tool: 'code_intel', note: 'operation="document_symbols"' },
  get_workspace_symbols: { tool: 'code_intel', note: 'operation="workspace_symbols"' },
  get_hover: { tool: 'code_intel', note: 'operation="hover"' },
  go_to_definition: { tool: 'code_intel', note: 'operation="definition"' },
  find_references: { tool: 'code_intel', note: 'operation="references"' },
  find_implementations: { tool: 'code_intel', note: 'operation="implementations"' },
};

export function retiredToolResult(
  name: string,
  maxChars: number,
  context: {
    registry: ToolRegistry;
    allowed: Set<ToolPermission>;
    budget: ToolBudget | undefined;
    convId: string | undefined;
    unavailableTools: ReadonlyMap<string, string> | undefined;
  },
): string | undefined {
  const retired = Object.hasOwn(RETIRED_TOOLS, name) ? RETIRED_TOOLS[name] : undefined;
  if (!retired) return undefined;

  const result = `Error: unknown tool "${name}"`;
  const group = lazyGroupForTool(retired.tool);
  const groupUnloaded =
    group !== undefined &&
    (!context.convId ||
      (!isLazyGroupActive(context.convId, group) &&
        !context.budget?.isExplicitlyAllowed(retired.tool)));
  const definitions = context.registry
    .definitions(context.allowed)
    .filter((definition) => !context.unavailableTools?.has(definition.function.name));
  const eligible = context.budget?.filterDefinitions(definitions) ?? definitions;
  const canLoadGroup =
    group !== undefined &&
    groupUnloaded &&
    context.convId !== undefined &&
    lazyGroupNames().includes(group) &&
    eligible.some((definition) => definition.function.name === 'load_tool_group');
  const groupHint = canLoadGroup
    ? `; group "${group}" is unloaded; call load_tool_group with "${group}"`
    : '';
  const withHint = `${result}; it was replaced by "${retired.tool}" (${retired.note})${groupHint}.`;
  return withHint.length <= maxChars ? withHint : result;
}
