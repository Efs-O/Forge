/**
 * The approval card and what the queue says about it: the shape every surface
 * sees, kept apart from the queue that holds it.
 *
 * `ToolApprovalService` owns approval STATE — who is waiting, who answered, which
 * timer fires. These are the events it emits, and it is not the only consumer:
 * the webview message bridge, the Telegram mirror, the desktop bridge and the
 * hidden-chat alert all read them, so the message everybody else parses should
 * not live in the file that owns one window's queue. `ToolApprovalService`
 * re-exports all four, so every existing import keeps resolving to this file.
 */

import type { HostToWebview } from './messageBridge';
import type { ApprovalDecision, ApprovalOffer } from './approvalMessages';

/**
 * The card's offer and the four decisions it may be answered with are the
 * message shapes three surfaces share (`approvalMessages.ts`); they are re-exported
 * here so a consumer of the card contract can read the whole contract from one
 * import, the way this file has always re-exported the event types it owns.
 */
export type { ApprovalDecision, ApprovalOffer } from './approvalMessages';

export interface ToolApprovalRequestEvent {
  id: string;
  toolName: string;
  detail: string;
  /** Why this card is open, when its gate can name the cause. */
  cardReason?: string;
  dangerous: boolean;
  conversationId?: string;
  /** True when only the owner can answer this card: the gate is one no
   *  automated answer is allowed for. Written by `eventOf`, so a re-announce says
   *  why it is a re-announce and every mirror sees the same flag the
   *  `waitingForOwner` sink carries. */
  waitingForOwner?: boolean;
  /** What an "Allow for this chat" click would store, when this call has keys the
   *  owner could allow (`approvalKey.ts` worked them out, `approvalKeyWords.ts`
   *  said them in plain words). Carried inside the event rather than worked out
   *  again at render time, because the same event feeds the sidebar card, the
   *  Telegram mirror, a re-announce that only the owner can answer it, and the
   *  card re-posted after a window reload: two places computing the offer would
   *  be two places that can disagree about which buttons to show.
   */
  allowForChat?: ApprovalOffer;
  /** Owner-clicked project-wide policy offer, separate from chat storage. */
  alwaysInProject?: ApprovalOffer;
}

/** The one host-to-webview representation used for live and re-posted approvals. */
export function buildApprovalRequestMessage(event: ToolApprovalRequestEvent): HostToWebview {
  return {
    type: 'confirmRequest',
    id: event.id,
    toolName: event.toolName,
    detail: event.detail,
    ...(event.cardReason ? { cardReason: event.cardReason } : {}),
    ...(event.dangerous ? { isDangerous: true } : {}),
    ...(event.conversationId ? { conversationId: event.conversationId } : {}),
    ...(event.allowForChat ? { allowForChat: event.allowForChat } : {}),
    ...(event.alwaysInProject ? { alwaysInProject: event.alwaysInProject } : {}),
  };
}

export interface ToolApprovalResolvedEvent extends ToolApprovalRequestEvent {
  approved: boolean;
  /** How the owner answered: `approve`, `decline`, `allowChat`, or `alwaysProject`.
   *  The last two store the offered keys as chat rules or project policy.
   *  `approved` stays because
   *  a sink that only needs to know whether the call ran should not have to know
   *  what the owner did to the rules; the ledger row and the receipts do need the
   *  difference between the two yeses, which is why both fields are here.
   */
  decision: ApprovalDecision;
  /** How the card left the queue: the owner's answer, a turn that stopped while
   *  it was open, or the timeout. Nothing else resolves a card. */
  reason: 'resolved' | 'cancelled' | 'timeout';
  /** Why a key the card offered could not be stored, when that happened. The call
   *  still ran, because the owner approved it; the owner has to be told the rule
   *  did not land, or they will believe the next call is answered when it is not.
   *  Only an `allowChat` answer can carry these.
   */
  chatRuleErrors?: readonly string[];
  /** A receipt for an `alwaysProject` click whose policy write was locked or
   *  failed, or for the successful project-wide save. */
  approvalNotice?: string;
}

/**
 * A gate call that a rule answered with no card: what the owner would have seen,
 * plus what answered it instead.
 *
 * It is NOT a card and the queue holds nothing for it — no id, no timer, no
 * `requested`/`resolved` pair. It exists so the `gate` ledger still records every
 * decision a card would have recorded (`docs/plans/ASK_ONCE_APPROVALS_PLAN.md` §5:
 * "every auto-allowed gate call writes a `gate` row"), and so a reader can tell an
 * auto-allowed call from one that never had a gate at all. `approvalKey` is the
 * key or keys that covered it, comma-joined, because a row that only said "it ran"
 * would be a security ledger that cannot say who allowed what.
 */
export interface ToolApprovalAutoApprovedEvent {
  toolName: string;
  /** The card's text, had there been one: what the call was about to do. */
  detail?: string;
  conversationId?: string;
  dangerous?: boolean;
  /** The key or keys that covered it, comma-joined. Absent when the answer was not
   *  a key at all: Clanker answering a call that has no key (`approvalKey.ts`
   *  `unkeyable`) runs it without a card and has nothing to name, and a row that
   *  named a key nobody allowed would be a ledger that cannot say who allowed what. */
  approvalKey?: string;
  /** Who answered it in place of the owner. Phase 2 has only `chat_rule`; `policy_rule`
   *  and `clanker` arrive with phases 4 and 3. */
  answeredBy: 'chat_rule' | 'policy_rule' | 'clanker';
}

export interface ToolApprovalSink {
  requested(event: ToolApprovalRequestEvent): void;
  resolved(event: ToolApprovalResolvedEvent): void;
  /** Nobody but the owner can answer this card: the gate forbids any
   *  automated answer. Emitted once, after `requested`, with the detail already
   *  carrying the causes. */
  waitingForOwner?(event: ToolApprovalRequestEvent): void;
  /** A gate call a rule answered with no card. Optional because most sinks only
   *  mirror cards, and this one has no card to mirror: the gate ledger
   *  (`gateEventLog.ts`) is what implements it. */
  autoApproved?(event: ToolApprovalAutoApprovedEvent): void;
}
