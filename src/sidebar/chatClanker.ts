/**
 * Where a chat's Clanker mode lives: one field on the conversation record
 * (`conversation.clanker`), not a window-wide key, because the mode is a property of
 * one conversation. It used to be `workspaceState['forge.clankerMode']`, which meant
 * arming one chat armed every tab in the window — including a tab that had taken in
 * a page its owner never approved — and the owner could not see which chat was armed
 * without reading every banner. The key is cleared once at startup so a value set by
 * an older Forge does not linger in the workspace.
 *
 * The queue (`ToolApprovalService.ts`) is still the sole writer and the one that
 * announces, but it reads and writes through the pair this module builds, so the
 * record is the only copy that has to be right: a tab restored from the archive
 * mid-window keeps the mode its owner armed because the flag travels with its record,
 * and a window reload is not a reset for the same reason. Every chat starts off,
 * because a record written before this field exists has none.
 */
import type { ConversationRuntime } from './sessionTypes';

/** The queue's view of the flags: read what a chat's record says, and write it. */
export interface ChatClankerRecords {
  read: (conversationId: string) => boolean | undefined;
  write: (conversationId: string, on: boolean) => void;
}

/** The pair, built over the lookup that resolves a chat id to its record. Passing the
 *  lookup rather than the conversations keeps this independent of who holds them: the
 *  window's lookup is set after construction, so the pair is bound to a function that
 *  may not have an answer yet.
 */
export function chatClankerRecords(
  lookup: (conversationId: string) => ConversationRuntime | undefined,
): ChatClankerRecords {
  return {
    read: (conversationId) => lookup(conversationId)?.clanker,
    write: (conversationId, on) => {
      const conversation = lookup(conversationId);
      // A chat this window cannot see has no record to write, and an armed chat it
      // cannot see would answer nothing anyway: the flag is stored where the chat is.
      if (conversation) conversation.clanker = on;
    },
  };
}

/** Whether this chat's record says it is armed — the answer for surfaces that report
 *  the mode without going through the queue, so they cannot disagree with it. */
export function chatClankerOn(conversation: ConversationRuntime | undefined): boolean {
  return conversation?.clanker === true;
}

/** `/clear` clears the flag with the history it was armed for, the way
 *  `clearChatRules` clears the keys earned on that history. Written as `false` rather
 *  than deleted so the open-chat signature sees the change and the save cannot skip
 *  it. Turning the mode off by hand revokes nothing; this is not turning it off, it is
 *  the chat ending. */
export function clearChatClanker(conversation: ConversationRuntime): void {
  conversation.clanker = false;
}
