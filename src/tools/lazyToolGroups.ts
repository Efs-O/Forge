/**
 * Demand-loaded MCP tool groups.
 *
 * A lazy group's tools stay registered, connected, and dispatchable at all
 * times — this module only decides whether their schemas are *advertised* to
 * the model. Nothing here touches MCP process lifecycle.
 *
 * The motive is static prompt cost: HalluScribe's six schemas are 2382 tokens
 * of every request (`test/prompt-context-measurement.txt`) on conversations
 * that never ask about past sessions. Hiding them behind `load_tool_group`
 * trades that for ~1 extra tool round on the turns that genuinely need history.
 *
 * Activation is per conversation and in memory only: it is a prompt-shaping
 * hint, not user configuration, so it never reaches config.yaml. A window
 * reload therefore drops it and the model re-activates — one round, not a bug.
 */

/**
 * MCP server name -> lazy group name. Only servers listed here are lazy;
 * every other MCP server advertises exactly as it always has.
 */
const LAZY_GROUP_BY_SERVER: ReadonlyMap<string, string> = new Map([['halluscribe', 'halluscribe']]);

/** Tool names actually bridged in, per group. Empty => the group is unavailable. */
const membersByGroup = new Map<string, Set<string>>();

/** Conversation id -> groups activated in it. */
const activeByConversation = new Map<string, Set<string>>();

/** The lazy group `serverName` belongs to, or undefined when it is not lazy. */
export function lazyGroupForServer(serverName: string): string | undefined {
  return LAZY_GROUP_BY_SERVER.get(serverName);
}

/** Records one successfully bridged tool as a member of `group`. */
export function recordLazyGroupTool(group: string, toolName: string): void {
  const members = membersByGroup.get(group) ?? new Set<string>();
  members.add(toolName);
  membersByGroup.set(group, members);
}

/** True once at least one of the group's tools has been bridged in. */
export function isLazyGroupAvailable(group: string): boolean {
  return (membersByGroup.get(group)?.size ?? 0) > 0;
}

/** Marks `group` advertised for the rest of `conversationId`. */
export function activateLazyGroup(conversationId: string, group: string): void {
  const active = activeByConversation.get(conversationId) ?? new Set<string>();
  active.add(group);
  activeByConversation.set(conversationId, active);
}

export function isLazyGroupActive(conversationId: string, group: string): boolean {
  return activeByConversation.get(conversationId)?.has(group) === true;
}

/**
 * Tool names that must be withheld from `conversationId`'s model-facing tool
 * list. An unknown conversation hides everything lazy — the safe direction,
 * since a withheld tool costs a round while a leaked one costs every request.
 */
export function hiddenLazyToolNames(conversationId: string | undefined): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const [group, members] of membersByGroup) {
    if (conversationId !== undefined && isLazyGroupActive(conversationId, group)) continue;
    for (const name of members) hidden.add(name);
  }
  return hidden;
}

/** Test seam: drops both bridged membership and every conversation's activation. */
export function resetLazyToolGroups(): void {
  membersByGroup.clear();
  activeByConversation.clear();
}
