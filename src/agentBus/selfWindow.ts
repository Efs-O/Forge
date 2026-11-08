/**
 * This window's own address on the agent bus.
 *
 * A chat that talks to a peer window needs three things it cannot read off the
 * workspace: the bus folder, this window's id — so discovery does not list the
 * window it is standing in — and the folder this window is open on, so a second
 * window on that same folder is not mistaken for a peer (two windows on one
 * folder share one chat store, so their chats are the same records).
 *
 * The route registry owns the window id, and it is built long after the tools
 * are registered, so the tools read it from here rather than threading a getter
 * through the twenty positional arguments of `registerAllTools`. Written once per
 * activation, next to the place the id first exists, and cleared when that
 * activation is disposed. Same shape as `agentMesh/meshContext.ts`.
 */
export interface SelfWindow {
  /** The agent-bus folder: `~/.forge/agent-bus` unless a profile says otherwise. */
  busRoot: string;
  windowId: string;
  workspaceRoot: string;
}

let current: SelfWindow | undefined;

export function setSelfWindow(self: SelfWindow): void {
  current = self;
}

/** Forget the address only if it is still the one `windowId` set: a reload that
 *  activated before the old activation disposed must not clear the new record. */
export function clearSelfWindow(windowId: string): void {
  if (current?.windowId === windowId) current = undefined;
}

/** Undefined until the bus is up in this window — which is also the honest answer
 *  for a workspace that has `agent_bus.enabled` off. */
export function getSelfWindow(): SelfWindow | undefined {
  return current;
}
