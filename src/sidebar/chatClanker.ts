/**
 * Where a chat's Clanker mode lives: one field on the conversation record
 * (`conversation.clanker`), not a window-wide key, because the mode is a property of
 * one conversation. It used to be `workspaceState['forge.clankerMode']`, which meant
 * arming one chat armed every tab in the window — including a tab that had taken in
 * a page its owner never approved — and the owner could not see which chat was armed
 * without reading every banner. The key is cleared once at startup so a value set by
 * an older Forge does not linger in the workspace.
 *
 * The queue (`ToolApprovalService.ts`) owns hand toggles and their announcements;
 * this module also applies the policy default to newly created records. The queue
 * reads and writes through the pair this module builds, so the
 * record is the only copy that has to be right: a tab restored from the archive
 * mid-window keeps the mode its owner armed because the flag travels with its record,
 * and a window reload is not a reset for the same reason. New chats may start on
 * through the owner's expiring policy default; existing records stay unchanged.
 */
import type { ConversationRuntime, SidebarRuntime } from './sessionTypes';

export const CLANKER_DEFAULT_SOURCE = 'policy-default' as const;
export const CLANKER_DEFAULT_EXPIRED_NOTICE =
  "Clanker's default from policy.yaml has ended, so this chat is gated again. Turn it back on with /clanker.";

export function clankerDefaultExpiryNotifier(
  post: (message: { type: 'clankerChanged'; enabled: false; conversationId: string }) => void,
  persist: ((conversationId: string) => void) | undefined,
): (conversationId: string, notice: string) => void {
  return (conversationId) => {
    post({ type: 'clankerChanged', enabled: false, conversationId });
    persist?.(conversationId);
  };
}

/** Pure approval-boundary transition for default-armed chats. */
export function reconcileClankerDefault(
  clanker: boolean,
  source: string | undefined,
  defaultOnUntil: string | undefined,
  now: number,
): { clanker: boolean; source: string | undefined; notice?: string } {
  if (source !== CLANKER_DEFAULT_SOURCE || clanker !== true) return { clanker, source };
  const until = defaultOnUntil === undefined ? Number.NaN : Date.parse(defaultOnUntil);
  if (Number.isFinite(until) && now < until) return { clanker, source };
  return { clanker: false, source: undefined, notice: CLANKER_DEFAULT_EXPIRED_NOTICE };
}

export function clankerDefaultNotice(defaultOnUntil: string): string {
  const date = new Date(Date.parse(defaultOnUntil));
  const pad = (value: number): string => String(value).padStart(2, '0');
  const until = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `Clanker is on by default until ${until} (policy.yaml clanker.default_on_until). Its three stops still hold: destructive actions, Forge guard files, a secret read followed by egress. Turn it off here with /clanker.`;
}

/** Apply the policy only to a record as it is created. */
export function armNewConversationByDefault(
  conversation: ConversationRuntime,
  defaultOnUntil: string | undefined,
  now: number,
): string | undefined {
  if (defaultOnUntil === undefined) return undefined;
  const until = Date.parse(defaultOnUntil);
  if (!Number.isFinite(until) || now >= until) return undefined;
  const notice = clankerDefaultNotice(defaultOnUntil);
  conversation.clanker = true;
  conversation.clankerSource = CLANKER_DEFAULT_SOURCE;
  addDisplayNotice(conversation, notice, now, 0);
  return notice;
}

function addDisplayNotice(
  conversation: ConversationRuntime,
  message: string,
  createdAt: number,
  messageIndex: number,
): void {
  const notices = conversation.displayNotices ?? (conversation.displayNotices = []);
  notices.push({ message, createdAt, messageIndex });
}

export function armConversationWithPolicyDefault(
  conversation: ConversationRuntime | undefined,
  defaultOnUntil: string | undefined,
): void {
  if (conversation) armNewConversationByDefault(conversation, defaultOnUntil, Date.now());
}

export function armRemovedChat(
  sidebar: SidebarRuntime,
  removedId: string,
  wasSoleOpenChat: boolean,
  defaultOnUntil: string | undefined,
): void {
  if (!wasSoleOpenChat || sidebar.conversations.length !== 1) return;
  const replacement = sidebar.conversations[0];
  if (replacement?.id !== removedId) armConversationWithPolicyDefault(replacement, defaultOnUntil);
}

/** The queue's view of the flags: read what a chat's record says, and write it. */
export interface ChatClankerRecords {
  read: (conversationId: string) => boolean | undefined;
  write: (conversationId: string, on: boolean) => void;
  source: (conversationId: string) => 'policy-default' | undefined;
  expirePolicyDefault: (conversationId: string, notice: string) => boolean;
}

/** Read and reconcile one record at the approval boundary. */
export function readClankerModeAtApproval(
  records: ChatClankerRecords,
  conversationId: string,
  defaultOnUntil: string | undefined,
  now: number,
  cached: boolean | undefined,
  onExpired: (conversationId: string, notice: string) => void,
): boolean | undefined {
  const clanker = records.read(conversationId);
  const source = records.source(conversationId);
  const transition = reconcileClankerDefault(clanker === true, source, defaultOnUntil, now);
  if (transition.notice && records.expirePolicyDefault(conversationId, transition.notice)) {
    onExpired(conversationId, transition.notice);
    return false;
  }
  return clanker ?? cached;
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
    source: (conversationId) => lookup(conversationId)?.clankerSource,
    write: (conversationId, on) => {
      const conversation = lookup(conversationId);
      // A chat this window cannot see has no record to write, and an armed chat it
      // cannot see would answer nothing anyway: the flag is stored where the chat is.
      if (conversation) {
        conversation.clanker = on;
        delete conversation.clankerSource;
      }
    },
    expirePolicyDefault: (conversationId, notice) => {
      const conversation = lookup(conversationId);
      if (!conversation || conversation.clankerSource !== CLANKER_DEFAULT_SOURCE) return false;
      conversation.clanker = false;
      delete conversation.clankerSource;
      addDisplayNotice(conversation, notice, Date.now(), conversation.messages.length);
      return true;
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
  delete conversation.clankerSource;
}
