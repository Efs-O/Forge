/**
 * Demand-loaded groups. Tools stay registered and dispatchable; this module
 * controls only which schemas are advertised in each conversation.
 */

/** MCP server name -> lazy group name. Unlisted servers remain eager. */
const LAZY_GROUP_BY_SERVER: ReadonlyMap<string, string> = new Map([['halluscribe', 'halluscribe']]);

/**
 * Membership follows the 2026-09-30 audit of 15,676 Qwen calls across 86+
 * sessions: first use of a grouped tool costs a full conversation re-read
 * (~100 s at 70K). Counts: ask_agent 152, manage_jobs 73, notify_user
 * 67, ask_local_agent 56, ask_user 34,
 * list_delegation_targets 14, get_system_status 11. The agent tools among them
 * are grouped anyway, in `agents`, because they matter to remote-control
 * conversations, not coding ones: a profile that uses them keeps them eager
 * through `tool_groups.eager: [agents]` instead of every coding turn paying
 * their schemas. ask_user is ungrouped. view_image (17) is the exception: it stays in media because it works only on
 * vision models and most calls came from image-review sessions. delete_file
 * joined the eager set on 2026-10-07: the most-called grouped tool since 09-30
 * (79 calls, 25 of 127 sessions), and the alternative every rm / Remove-Item
 * refusal names, so hiding it made the refusal point at a tool the model could
 * not see. git_read joined it the same day: 70 calls in 25 sessions, as often
 * as delete_file, and the read side of every git question. Other grouped
 * tools each had at most 7 calls. Rare tools stay grouped to avoid paying their
 * schema cost on every conversation.
 *
 * Count calls only while offered; a never-offered tool is unmeasured, not 0.
 * Shell workarounds count as demand for hidden tools. Exclude cases ruled out
 * by the tool's own description. See src/sessions/toolUsage.ts.
 */
const NATIVE_GROUP_BY_TOOL: ReadonlyMap<string, string> = new Map([
  ...[
    'browser_open',
    'browser_close',
    'browser_navigate',
    'browser_tabs',
    'browser_select_tab',
    'browser_new_tab',
    'browser_close_tab',
    'browser_click',
    'browser_drag',
    'browser_hover',
    'browser_inspect',
    'browser_press',
    'browser_screenshot',
    'browser_scroll',
    'browser_type',
    'desktop_capture',
    'desktop_windows',
    'desktop_focus_window',
    'desktop_move_mouse',
    'desktop_click',
    'desktop_drag',
    'desktop_scroll',
    'desktop_type',
    'desktop_press',
  ].map((name) => [name, 'computer_use'] as const),
  ...[
    'view_image',
    'view_video',
    'generate_image',
    'upscale_image',
    'image_search',
    'send_file',
  ].map((name) => [name, 'media'] as const),
  ...[
    'get_editor_context',
    'replace_selection',
    'insert_code',
    'show_diff',
    'open_file',
    'open_url_in_browser',
    'show_notification',
    'copy_to_clipboard',
    'read_clipboard',
  ].map((name) => [name, 'editor_ui'] as const),
  ...['install_llamacpp', 'get_power_info', 'schedule_wake', 'sleep_computer'].map(
    (name) => [name, 'system'] as const,
  ),
  ...['read_notebook', 'edit_notebook_cell'].map((name) => [name, 'notebook'] as const),
  ...['move_file', 'create_directory', 'apply_line_edits', 'restore_file'].map(
    (name) => [name, 'files'] as const,
  ),
  ...['stage', 'commit', 'create_branch', 'switch_branch'].map((name) => [name, 'git'] as const),
  ...['code_intel', 'rename_symbol', 'apply_code_action', 'format_file', 'search_codebase'].map(
    (name) => [name, 'code_intel'] as const,
  ),
  ...['remember', 'recall', 'list_memories', 'forget'].map((name) => [name, 'memory'] as const),
  ...['stop_execution', 'list_executions', 'wait'].map((name) => [name, 'background'] as const),
  ...['ask_agent', 'ask_local_agent', 'list_delegation_targets', 'manage_jobs', 'notify_user'].map(
    (name) => [name, 'agents'] as const,
  ),
  ['get_system_status', 'system'],
]);

/** Tools actually registered or bridged in, per group. */
const membersByGroup = new Map<string, Set<string>>();
const activeByConversation = new Map<string, Set<string>>();

export function lazyGroupForServer(serverName: string): string | undefined {
  return LAZY_GROUP_BY_SERVER.get(serverName);
}

export function lazyGroupForTool(toolName: string): string | undefined {
  return NATIVE_GROUP_BY_TOOL.get(toolName) ?? groupForMember(toolName);
}

function groupForMember(toolName: string): string | undefined {
  for (const [group, members] of membersByGroup) if (members.has(toolName)) return group;
  return undefined;
}

/** Records a native tool from the static membership map when it is registered. */
export function recordNativeLazyTool(toolName: string): void {
  const group = NATIVE_GROUP_BY_TOOL.get(toolName);
  if (group) recordLazyGroupTool(group, toolName);
}

/** Records one successfully bridged tool as a member of an MCP group. */
export function recordLazyGroupTool(group: string, toolName: string): void {
  const members = membersByGroup.get(group) ?? new Set<string>();
  members.add(toolName);
  membersByGroup.set(group, members);
}

export function lazyGroupNames(): string[] {
  return [...membersByGroup.keys()].filter((group) => isLazyGroupAvailable(group)).sort();
}

export function lazyGroupMembers(group: string): string[] {
  return [...(membersByGroup.get(group) ?? [])].sort();
}

export function isLazyGroupAvailable(group: string): boolean {
  return (membersByGroup.get(group)?.size ?? 0) > 0;
}

export function hasAvailableLazyGroup(): boolean {
  return lazyGroupNames().length > 0;
}

export function activateLazyGroup(conversationId: string, group: string): void {
  const active = activeByConversation.get(conversationId) ?? new Set<string>();
  active.add(group);
  activeByConversation.set(conversationId, active);
}

export function isLazyGroupActive(conversationId: string, group: string): boolean {
  return activeByConversation.get(conversationId)?.has(group) === true;
}

/** Clears loaded schemas when their conversation is cleared or deleted. */
export function deactivateLazyGroups(conversationId: string): void {
  activeByConversation.delete(conversationId);
}

/** Hidden names omit explicitly allowlisted tools: config is an eager opt-in. */
export function hiddenLazyToolNames(
  conversationId: string | undefined,
  eagerNames: ReadonlySet<string> = new Set(),
  eagerGroups: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const [group, members] of membersByGroup) {
    const eagerByDefault = group === 'files' || group === 'background' || group === 'media';
    if (
      eagerByDefault ||
      eagerGroups.has(group) ||
      (conversationId !== undefined && isLazyGroupActive(conversationId, group))
    )
      continue;
    for (const name of members) {
      if (!eagerNames.has(name)) hidden.add(name);
    }
  }
  return hidden;
}

/** Test seam: drops bridged/registered membership and every activation. */
export function resetLazyToolGroups(): void {
  membersByGroup.clear();
  activeByConversation.clear();
}
