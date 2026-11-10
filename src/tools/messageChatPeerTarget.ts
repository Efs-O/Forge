/** Cross-window target lookup. Only chat ids are portable: `#N` is a tab number
 *  made by one window, and title words can name different chats in each window. */
import type { ChatsReportChat } from '../backend/agentChatReadRoute';
import type { PeerContext, PeerWindow, PeerChatRef } from './messageChatPeers';
import { discoverPeers, peerChatRef, windowLabel } from './messageChatPeers';

/** A full chat id or a prefix long enough to identify one across all windows. */
export const FULL_CHAT_ID = /^[0-9a-f][0-9a-f-]{7,}$/iu;
const MIN_PEER_ID_PREFIX = 8;

/** What a peer lookup answers: the chat, the folder this window is open on (the
 *  peer prompt names it so the other window knows where the reply goes back to),
 *  or the note to append to the local refusal. A refusal reports an ambiguous
 *  id prefix that matches more than one chat in other windows. */
export type PeerTarget =
  | { chat: PeerChatRef; selfWorkspace: string }
  | { note: string }
  | { refusal: string };

/** Match the trimmed reference against the start of chat ids, across peers in
 *  discovery order. Titles and tab numbers never enter this lookup. */
function findPeerChats(
  peers: PeerWindow[],
  ref: string,
): { peer: PeerWindow; chat: ChatsReportChat }[] {
  const needle = ref.trim().toLowerCase();
  if (!FULL_CHAT_ID.test(needle) || needle.length < MIN_PEER_ID_PREFIX) return [];
  return peers.flatMap((peer) =>
    peer.chats
      .filter((candidate) => candidate.id.toLowerCase().startsWith(needle))
      .map((chat) => ({ peer, chat })),
  );
}

/** A uniquely matching peer chat, whether named by full id or long prefix. */
export function findPeerChat(
  peers: PeerWindow[],
  ref: string,
): { peer: PeerWindow; chat: ChatsReportChat } | undefined {
  const matches = findPeerChats(peers, ref);
  return matches.length === 1 ? matches[0] : undefined;
}

/** A chat the caller named by full id, if another window holds it.
 *
 *  Local resolution always runs first — this is only reached once this window
 *  has said it does not know the id. A caller that named a full id while the bus
 *  is off here gets a note naming the switch, because "no chat matches" is not
 *  the whole truth in that case: the chat may well exist next door. */
export async function resolvePeerTarget(
  ref: string | undefined,
  ctx: PeerContext | undefined,
  list: typeof discoverPeers = discoverPeers,
  signal?: AbortSignal,
): Promise<PeerTarget> {
  const needle = ref?.trim() ?? '';
  if (!FULL_CHAT_ID.test(needle) || needle.length < MIN_PEER_ID_PREFIX) return { note: '' };
  if (!ctx) {
    return {
      note:
        '\nNo other Forge window can be reached from here: set `agent_bus.enabled: true` ' +
        'in .forge/config.yaml of both windows, or run this chat in the window that holds the chat.',
    };
  }
  const matches = findPeerChats((await list(ctx, signal)).peers, needle);
  if (matches.length === 1) {
    const found = matches[0]!;
    return { chat: peerChatRef(found.peer, found.chat), selfWorkspace: ctx.workspaceRoot };
  }
  if (matches.length > 1) {
    return {
      refusal:
        `Error: "${ref}" starts the id of more than one chat in other windows: ` +
        `${matches.map(({ peer, chat }) => `${chat.id} in ${windowLabel(peer)}`).join('; ')}. Pass the full id.`,
    };
  }
  return { note: '' };
}
