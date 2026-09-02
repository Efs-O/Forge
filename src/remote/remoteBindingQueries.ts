import type { RemoteBinding } from './types';

/**
 * Pure selectors over the store's binding list.
 *
 * Both answer "which chats should hear this", and they differ only in what
 * "this" is addressed to — a conversation or the whole window. Keeping them
 * together makes that pair visible; inside RemoteRequestStore they read as two
 * unrelated filters separated by unrelated methods.
 *
 * They clone: the store's state must not escape to callers who might mutate it.
 */
export function bindingsForConversation(
  bindings: readonly RemoteBinding[],
  conversationId: string,
  channel?: RemoteBinding['channel'],
): RemoteBinding[] {
  return bindings
    .filter(
      (item) =>
        item.conversationId === conversationId &&
        (channel === undefined || item.channel === channel),
    )
    .map((item) => ({ ...item }));
}

/**
 * Every chat bound to a workspace, whatever conversation each is on.
 *
 * The conversation-keyed sibling cannot answer for window-scoped news:
 * unloading a model or restarting the backend is a property of the window, not
 * of whichever conversation happened to be in front, so addressing it by
 * conversation would silently skip a paired chat bound to a different one and
 * equally affected.
 */
export function bindingsForWorkspace(
  bindings: readonly RemoteBinding[],
  workspaceId: string,
  channel?: RemoteBinding['channel'],
): RemoteBinding[] {
  return bindings
    .filter(
      (item) =>
        item.workspaceId === workspaceId && (channel === undefined || item.channel === channel),
    )
    .map((item) => ({ ...item }));
}
