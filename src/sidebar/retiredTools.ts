import type { ToolBudget } from '../tools/ToolBudget';
import type { ToolPermission, ToolRegistry } from '../tools/ToolRegistry';
import { isLazyGroupActive, lazyGroupForTool, lazyGroupNames } from '../tools/lazyToolGroups';

/** Known tool names from saved conversations and the consolidated tools that replace them. */
export const RETIRED_TOOLS: Readonly<
  Record<string, { readonly tool: string; readonly note: string }>
> = {
  exec_command: { tool: 'shell', note: 'one command line in "command"' },
  append_file: { tool: 'write_file', note: 'mode: "append"' },
  create_directory: {
    tool: 'write_file',
    note: 'parents come with any write; shell mkdir for a bare folder',
  },
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
  // The two active-editor writers, retired 2026-11-13 (19 and 13 calls in the whole
  // archive, all of them harness probes). A model that still reaches for one is
  // sent to the tool that names the file it writes.
  replace_selection: { tool: 'edit_file', note: 'an explicit path and old_str/new_str' },
  insert_code: { tool: 'edit_file', note: 'an explicit path and old_str/new_str' },
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

const UNKNOWN_TOOL_HINT_MAX_CHARS = 200;
const UNKNOWN_TOOL_HINT_MIN_PREFIX_CHARS = 5;

/**
 * What the model is told when it calls a tool that is not there.
 *
 * Kept beside `retiredToolResult` because both answer the same question — "this
 * name is not a tool you can call, so what should the model do instead?" — and a
 * model that gets a bare `unknown tool` goes hunting for a workaround. When
 * exactly one live tool starts with the name it typed, that is the answer; when
 * the tool sits behind an unloaded group, the row has to say how to get it, or
 * the model retries the same blind call.
 */
export function unknownToolResult(
  name: string,
  registry: ToolRegistry,
  allowed: Set<ToolPermission>,
  budget: ToolBudget | undefined,
  convId: string | undefined,
  unavailableTools: ReadonlyMap<string, string> | undefined,
): string {
  const result = `Error: unknown tool "${name}"`;
  const retired = retiredToolResult(name, UNKNOWN_TOOL_HINT_MAX_CHARS, {
    registry,
    allowed,
    budget,
    convId,
    unavailableTools,
  });
  if (retired) return retired;
  if (name.length < UNKNOWN_TOOL_HINT_MIN_PREFIX_CHARS) return result;

  const definitions = registry
    .definitions(allowed)
    .filter((definition) => !unavailableTools?.has(definition.function.name));
  const eligible = budget?.filterDefinitions(definitions) ?? definitions;
  const matches = eligible.filter(
    (definition) => definition.function.name !== name && definition.function.name.startsWith(name),
  );
  if (matches.length !== 1) return result;

  const candidate = matches[0]?.function.name;
  if (!candidate) return result;
  const group = lazyGroupForTool(candidate);
  const groupUnloaded =
    group !== undefined &&
    (!convId || (!isLazyGroupActive(convId, group) && !budget?.isExplicitlyAllowed(candidate)));
  let hint: string;
  if (groupUnloaded && group) {
    const canLoadGroup =
      convId !== undefined &&
      lazyGroupNames().includes(group) &&
      eligible.some((definition) => definition.function.name === 'load_tool_group');
    if (!canLoadGroup) return result;
    hint = `; group "${group}" is unloaded; call load_tool_group with "${group}" first to use "${candidate}"`;
  } else {
    hint = `; did you mean "${candidate}"?`;
  }
  const withHint = `${result}${hint}`;
  return withHint.length <= UNKNOWN_TOOL_HINT_MAX_CHARS ? withHint : result;
}
