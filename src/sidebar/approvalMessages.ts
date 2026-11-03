/**
 * The approval card's message shapes, and the two facts every surface has to
 * agree about: what the card OFFERED, and how it was ANSWERED.
 *
 * Declared here rather than in `messageBridge.ts` for the reason that file's own
 * header gives — the bridge stays the single import for every message shape, but
 * the shapes live where their concern does. This concern is the card, which three
 * surfaces render and answer: the sidebar, the Telegram mirror and anything else
 * that adds an approval sink. Separate boolean decisions would be three ways for
 * the same owner action to mean something different on each one, so the answer is
 * a closed union declared once, here.
 *
 * Leaf module: it imports nothing, so `messageBridge.ts`,
 * `toolApprovalEvents.ts` and the webview can all read it without a cycle.
 */

/** What an "Allow for this chat" click would store: the keys the call needs, and
 *  what they say in plain words (`approvalKeyWords.ts`). A card that carries no
 *  offer has nothing the owner could allow — a deny-list command like `git rebase`
 *  whose target the key rules cannot name, a call whose key reaches past a wall,
 *  or a run nobody is in — and shows Approve and Decline exactly as it always did.
 */
export interface ApprovalOffer {
  keys: readonly string[];
  label: string;
}

/** What a card may be answered with.
 *
 *  `allowChat` is the owner's answer to this call AND to the keys the card named:
 *  the call runs, and each key becomes a rule of this chat, so the next call that
 *  needs the same key runs with no card (`docs/plans/ASK_ONCE_APPROVALS_PLAN.md`
 *  §2). Every surface answers with one of these three and the approval queue is
 *  the only thing that turns the answer into a rule, which is what keeps a phone
 *  click and a sidebar click doing the same thing.
 */
export type ApprovalDecision = 'approve' | 'allowChat' | 'alwaysProject' | 'decline';

export interface ConfirmRequestMsg {
  type: 'confirmRequest';
  id: string;
  toolName: string;
  detail: string;
  isDangerous?: boolean;
  conversationId?: string;
  /** Present only when the call has keys the owner could allow. It travels with
   *  the request rather than being worked out again in the webview, so a card
   *  re-posted after a window reload, a re-announce that only the owner can
   *  answer it, and the Telegram mirror all show the same buttons this card did.
   */
  allowForChat?: ApprovalOffer;
  /** Present only when a keyed card has an active workspace and the owner may
   *  write the same keys into `approvals.always`. */
  alwaysInProject?: ApprovalOffer;
}

/**
 * A pending approval that something OTHER than this webview settled — a remote
 * transport button, or a cancelled turn. Without it the sidebar keeps showing
 * live-looking Approve/Deny buttons for an approval that is already resolved.
 */
export interface ConfirmResolvedMsg {
  type: 'confirmResolved';
  id: string;
}

/** The sidebar's answer to a pending approval. */
export interface ConfirmResponseMsg {
  type: 'confirmResponse';
  id: string;
  /** The answer as the same four choices every surface uses. A boolean would
   *  have made "allow for this chat" indistinguishable from "approve" on the way
   *  back to the host, and that difference is the whole feature: one stores the
   *  key the card named, the other does not.
   */
  decision: ApprovalDecision;
}

/** The sessions panel's per-chat `Reset approvals`: clears THIS chat's rules and
 *  its host approvals, whatever chat the panel is looking at. Keyed by id because
 *  the menu opens on a row that is not the active tab, and a reset that landed on
 *  the active chat would clear the wrong one.
 */
export interface ResetApprovalsMsg {
  type: 'resetApprovals';
  conversationId: string;
}
