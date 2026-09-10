/**
 * Going to another workspace: `/workspace <n-or-alias>`.
 *
 * Owner of the preflight for that move — resolving the number off the last
 * list, refusing the no-op, and saying what the silence means. The move itself
 * spans two processes (see `RemoteWorkspaceHandoff`): this window records it
 * and closes, and the window that comes up sends its own arrival receipt.
 */
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { numberedSelectionMiss, resolveSelection } from './remoteCommandSelectors';
import type { RemoteRequestStore } from './RemoteRequestStore';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

/** The slice of `RemoteCommandContext` the switch needs. */
export interface WorkspaceSwitchContext {
  channel: RemoteChannel;
  store: RemoteRequestStore;
  host: ForgeHostFacade;
  signal: AbortSignal;
  workspaceAliases: Readonly<Record<string, string>>;
  currentWorkspaceAlias?: string | undefined;
  switchWorkspace?: ((alias: string, channel: string, chatId: string) => Promise<void>) | undefined;
}

export async function switchWorkspaceCommand(
  selector: string,
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: WorkspaceSwitchContext,
): Promise<RemoteInboundDisposition> {
  // A number means the last `/workspace` list, matching /model <n> and
  // /chat <n>; an alias keeps working so a remembered name does not depend on
  // having listed first.
  const alias = resolveSelection(context, event, 'workspaces', selector) ?? selector;
  if (!context.workspaceAliases[alias]) {
    // A number that resolves to nothing means the list expired or never ran,
    // not that the workspace is missing — saying “not found” for a number the
    // user just read off a list sends them looking for the wrong problem.
    return { kind: 'rejected', reason: numberedSelectionMiss(context, event, selector) };
  }
  if (!context.switchWorkspace) {
    return { kind: 'rejected', reason: 'workspace switching is unavailable in this window' };
  }
  // Switching costs a window reload and the remote session with it, so doing it
  // to arrive where the chat already is would drop the session for nothing.
  if (alias === context.currentWorkspaceAlias) {
    return {
      kind: 'rejected',
      reason:
        `this chat is already in ${context.workspaceAliases[alias]}; ` +
        '/chats lists the conversations here and /new starts one',
    };
  }
  // Says what the silence that follows means: the VS Code window reloads, so
  // this chat hears nothing until the new window's transport comes up and
  // sends its own arrival receipt.
  await context.channel.send(
    event.chatId,
    `Forge: switching to ${context.workspaceAliases[alias]}… the window reloads, so this chat goes quiet for a few seconds — I will message you when it is back.`,
    { signal: context.signal },
  );
  await context.switchWorkspace(alias, event.channel, event.chatId);
  return { kind: 'handled' };
}
