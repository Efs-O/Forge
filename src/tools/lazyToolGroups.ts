import type { ToolDefinition } from '../llm/types';

/**
 * Demand-loaded groups. Tools stay registered and dispatchable; this module
 * controls only which schemas are advertised in each conversation.
 */

/**
 * Which MCP server tools are advertised, and when. Every server's tools arrive
 * in a demand-loaded group named after the server — the same mechanism the
 * native groups use — unless its `mcp_servers` entry sets `eager: true`. A
 * server whose name is already a built-in group gets `mcp-<name>` instead, so
 * its tools cannot ride along inside a native group unasked.
 *
 * The default flipped from eager to demand-loaded on 2026-11-14: the one server
 * that used to stay eager here was the Blender bridge, 11 tools and 11,913
 * characters of schemas paid by every conversation, with 9 of those 11 tools at
 * zero calls across 10 days of session logs.
 */

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
 * 2026-11-11, owner: code_intel itself is always offered; its group keeps the editing tools.
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
    'show_diff',
    'open_file',
    'open_url_in_browser',
    'show_notification',
    'copy_to_clipboard',
    'read_clipboard',
  ].map((name) => [name, 'editor_ui'] as const),
  ...['get_power_info', 'schedule_wake', 'sleep_computer'].map((name) => [name, 'system'] as const),
  ...['read_notebook', 'edit_notebook_cell'].map((name) => [name, 'notebook'] as const),
  // `create_directory` left this map with the tool itself (2026-10-29, lane B
  // item B3): the map is only consulted for registered names, so leaving the
  // entry would have advertised nothing, but it would have told the next reader
  // that a tool which no longer exists belongs to the `files` group.
  ...['move_file', 'apply_line_edits', 'restore_file'].map((name) => [name, 'files'] as const),
  ...['git_read', 'stage', 'commit', 'create_branch', 'switch_branch'].map(
    (name) => [name, 'git'] as const,
  ),
  ...['rename_symbol', 'apply_code_action', 'format_file', 'search_codebase'].map(
    (name) => [name, 'code_intel'] as const,
  ),
  ...['remember', 'recall', 'list_memories', 'forget'].map((name) => [name, 'memory'] as const),
  ...['stop_execution', 'list_executions', 'wait'].map((name) => [name, 'background'] as const),
  ...[
    'ask_agent',
    'ask_local_agent',
    'list_agent_targets',
    'list_delegation_targets',
    'manage_jobs',
    'notify_user',
  ].map((name) => [name, 'agents'] as const),
  ['get_system_status', 'system'],
]);

/**
 * Every built-in group name, lower-cased, so an MCP server cannot be given one.
 * Built from the map's own values: a group added here needs no second list.
 */
const NATIVE_GROUP_NAMES: ReadonlySet<string> = new Set(
  [...new Set(NATIVE_GROUP_BY_TOOL.values())].map((group) => group.toLowerCase()),
);

/** Tools actually registered or bridged in, per group. */
const membersByGroup = new Map<string, Set<string>>();
const activeByConversation = new Map<string, Set<string>>();
/**
 * Per-turn `tool_groups.schemas_in_result`: while it is on, the conversation's
 * tool list must not grow, so a group loaded in it is advertised by nothing but
 * the schemas in its own load result.
 */
const schemasInResultByConversation = new Set<string>();
/**
 * Groups loaded while that flag was on: active, and hidden from the `tools`
 * array because their schemas live only in a tool result. This set is what
 * keeps them hidden, and what promotes or deactivates them later.
 */
const resultSchemaGroupsByConversation = new Map<string, Set<string>>();
/**
 * The definitions this chat's text-form calls may be typed and admitted from,
 * set once per turn: `load_tool_group` prints schemas from it, so its result
 * names only tools this chat may actually call.
 */
const textCallCatalogByConversation = new Map<string, readonly ToolDefinition[]>();

/**
 * The lazy group an MCP server's tools belong to: its own name, so
 * `load_tool_group` can fetch them by the name the user configured. Returns
 * undefined only for a server that asks to stay advertised on every request.
 *
 * A server whose name IS a built-in group cannot have it: its tools would join
 * that group, load and hide with the native ones, and for `files`, `background`
 * and `memory` — the groups advertised on every request — the server would
 * pay its schemas in every conversation without being asked. Such a server gets
 * `mcp-<name>`, which is the name `load_tool_group` is then told to pass.
 */
export function lazyGroupForServer(serverName: string, eager = false): string | undefined {
  if (eager) return undefined;
  return NATIVE_GROUP_NAMES.has(serverName.toLowerCase()) ? `mcp-${serverName}` : serverName;
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

export function activateLazyGroup(
  conversationId: string,
  group: string,
  opts?: { schemasInResult?: boolean },
): void {
  const active = activeByConversation.get(conversationId) ?? new Set<string>();
  active.add(group);
  activeByConversation.set(conversationId, active);
  if (opts?.schemasInResult === true) {
    const groups = resultSchemaGroupsByConversation.get(conversationId) ?? new Set<string>();
    groups.add(group);
    resultSchemaGroupsByConversation.set(conversationId, groups);
  }
}

export function isLazyGroupActive(conversationId: string, group: string): boolean {
  return activeByConversation.get(conversationId)?.has(group) === true;
}

/**
 * A group whose tools this conversation's tool list already holds, so loading it
 * again must not move it into the result-schema set: that hides tools the model
 * has been calling, and this turn's text-call catalog holds only unlisted tools,
 * so every member would come back named "not allowed in this chat".
 *
 * Two views, each with what it can prove. The hidden-name set covers the groups
 * this module knows are always listed: eager by default, or activated while the
 * flag was off. The turn's own catalog is the authoritative list of what the
 * request does NOT hold, so it also covers a group made eager by
 * `tool_groups.eager` or named in `tools:` -- config this module cannot see.
 * An empty catalog means no turn has recorded one yet, so nothing is claimed.
 */
export function isListedLazyGroup(conversationId: string, group: string): boolean {
  const members = lazyGroupMembers(group);
  if (members.length === 0) return false;
  const hidden = hiddenLazyToolNames(conversationId);
  if (members.some((name) => !hidden.has(name))) return true;
  const catalog = textCallCatalog(conversationId);
  if (catalog.length === 0) return false;
  const unlisted = new Set(catalog.map((definition) => definition.function.name));
  return !members.some((name) => unlisted.has(name));
}

/** Clears loaded schemas when their conversation is cleared or deleted. */
export function deactivateLazyGroups(conversationId: string): void {
  activeByConversation.delete(conversationId);
  schemasInResultByConversation.delete(conversationId);
  resultSchemaGroupsByConversation.delete(conversationId);
  textCallCatalogByConversation.delete(conversationId);
}

/** Records this turn's `schemas_in_result`. Turning it off mid-chat promotes
 *  the groups it had hidden: they join the tool list, one cold re-read, which
 *  is today's cost for a group load. */
export function setSchemasInResult(conversationId: string, on: boolean): void {
  if (!on) {
    schemasInResultByConversation.delete(conversationId);
    promoteResultSchemaGroups(conversationId);
    return;
  }
  schemasInResultByConversation.add(conversationId);
}

export function isSchemasInResult(conversationId: string): boolean {
  return schemasInResultByConversation.has(conversationId);
}

/** Flag off mid-chat: the loaded groups stay active, so they appear in the tool
 *  list from the next request instead of only in an old tool result. */
export function promoteResultSchemaGroups(conversationId: string): void {
  resultSchemaGroupsByConversation.delete(conversationId);
}

/** Compaction summarises the schemas in the load results away, so the groups
 *  deactivate: the model loads one again and gets its schemas again. */
export function forgetResultSchemaGroups(conversationId: string): void {
  const groups = resultSchemaGroupsByConversation.get(conversationId);
  if (!groups) return;
  const active = activeByConversation.get(conversationId);
  for (const group of groups) active?.delete(group);
  resultSchemaGroupsByConversation.delete(conversationId);
}

/** Members of result-schema groups that this turn still keeps out of the list,
 *  so a request's tool set and its text-call set cannot disagree about them. */
export function resultSchemaToolNames(
  conversationId: string | undefined,
  eagerNames: ReadonlySet<string> = new Set(),
  eagerGroups: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const groups =
    conversationId === undefined ? undefined : resultSchemaGroupsByConversation.get(conversationId);
  if (groups === undefined || groups.size === 0) return new Set();
  const hidden = hiddenLazyToolNames(conversationId, eagerNames, eagerGroups);
  const names = new Set<string>();
  for (const group of groups) {
    for (const name of membersByGroup.get(group) ?? []) {
      if (hidden.has(name)) names.add(name);
    }
  }
  return names;
}

/** The definitions this chat's text-form calls are typed from and printed by. */
export function setTextCallCatalog(conversationId: string, defs: readonly ToolDefinition[]): void {
  textCallCatalogByConversation.set(conversationId, defs);
}

export function textCallCatalog(conversationId: string): readonly ToolDefinition[] {
  return textCallCatalogByConversation.get(conversationId) ?? [];
}

/** Hidden names omit explicitly allowlisted tools: config is an eager opt-in. */
export function hiddenLazyToolNames(
  conversationId: string | undefined,
  eagerNames: ReadonlySet<string> = new Set(),
  eagerGroups: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const [group, members] of membersByGroup) {
    // `files`, `background` and `memory` stay eager: `files` holds the structured-edit,
    // move and restore tools a coding turn reaches for, and `background` holds
    // what a long turn needs without a load round; `memory` joined on 2026-11-23, when it
    // was 38 of 51 group loads in 80 chats, each a cold re-read (`delete_file` is eager for
    // its own reason — it is ungrouped, and it is the alternative every rm /
    // Remove-Item refusal names). `media` left this list on 2026-10-29; a
    // profile that renders or reviews images restores it with
    // `tool_groups.eager: [media]`.
    const eagerByDefault = group === 'files' || group === 'background' || group === 'memory';
    if (
      eagerByDefault ||
      eagerGroups.has(group) ||
      (conversationId !== undefined &&
        isLazyGroupActive(conversationId, group) &&
        !resultSchemaGroupsByConversation.get(conversationId)?.has(group))
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
  schemasInResultByConversation.clear();
  resultSchemaGroupsByConversation.clear();
  textCallCatalogByConversation.clear();
}
