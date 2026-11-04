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
 * their schemas. ask_user is ungrouped, and so is `load_skill` (2026-10-29, lane
 * F2): its one-line-per-skill catalog is already in the system prompt, so a skill
 * the model can see but cannot open would cost a `load_tool_group` round before
 * any skill could be read. view_image (17) is the exception: it stays in media because it works only on
 * vision models and most calls came from image-review sessions. delete_file
 * joined the eager set on 2026-10-07: the most-called grouped tool since 09-30
 * (79 calls, 25 of 127 sessions), and the alternative every rm / Remove-Item
 * refusal names, so hiding it made the refusal point at a tool the model could
 * not see. git_read joined it the same day: 70 calls in 25 sessions, as often
 * as delete_file, and the read side of every git question. Other grouped
 * tools each had at most 7 calls. Rare tools stay grouped to avoid paying their
 * schema cost on every conversation.
 *
 * `media` left the eager-by-default set on 2026-10-29
 * (`docs/reports/TOOL_AUDIT_2026_10_29.md` §7): across the 53 sessions since
 * 0.17.80, `render_html_to_image`, `view_video`, `image_search` and
 * `upscale_image` had 0 calls and `generate_image` 1, and the group's only use
 * — `view_image` 94, `send_file` 52 — came from a single session. The group is
 * ~2,300 tokens on every coding round, so it now loads on demand like the rest.
 * `render_html_to_image` joined the group the same day: ungrouped, it paid its
 * 3,905-char schema to conversations that never render, and 53 sessions used it
 * 0 times. A profile that reviews or makes images keeps it eager through
 * `tool_groups.eager: [media]`.
 *
 * `git_read` went back into `git` the same day. It was promoted out of the
 * group on 2026-10-07 because the 2026-09-30 audit saw 70 calls in 25 sessions;
 * the 53 sessions since 0.17.80 show 6 calls against 418 shell `git` commands
 * (`status` 177, `diff` 159, `log` 139, `commit` 97, `add` 65), so the model
 * reads git through `shell` whether or not the tool is offered, and an always-
 * advertised 1,799-char schema does not change that. `git` now holds the reads
 * and the writes, and its purpose line says so.
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
    // Ungrouped until 2026-10-29: an always-advertised 3,905-char schema that
    // 53 sessions called 0 times. Its verbs now ride in the media purpose line.
    'render_html_to_image',
    'export_document',
    // The shipped render tools join the group with it: registered only while
    // `media.enabled` is true (docs/plans/MEDIA_SHIPPED_PLAN.md §1), and a
    // coding conversation that never renders should not pay their schemas.
    'generate_video',
    'generate_music',
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
  // `create_directory` left this map with the tool itself (2026-10-29, lane B
  // item B3): the map is only consulted for registered names, so leaving the
  // entry would have advertised nothing, but it would have told the next reader
  // that a tool which no longer exists belongs to the `files` group.
  ...['move_file', 'apply_line_edits', 'restore_file'].map((name) => [name, 'files'] as const),
  ...['git_read', 'stage', 'commit', 'create_branch', 'switch_branch'].map(
    (name) => [name, 'git'] as const,
  ),
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
    // `files` and `background` stay eager: `files` holds the structured-edit,
    // move and restore tools a coding turn reaches for, and `background` holds
    // what a long turn needs without a load round (`delete_file` is eager for
    // its own reason — it is ungrouped, and it is the alternative every rm /
    // Remove-Item refusal names). `media` left this list on 2026-10-29; a
    // profile that renders or reviews images restores it with
    // `tool_groups.eager: [media]`.
    const eagerByDefault = group === 'files' || group === 'background';
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
