/**
 * What an approval that did NOT come from the user means: the outcome shape a
 * waiting tool call resolves to, the text the agent gets back instead of a
 * result, and the two ways a run can be stopped by a gate it cannot answer.
 *
 * Kept apart from `ToolApprovalService` (the queue that holds the card) so the
 * service stays what it always was — the one owner of approval STATE — while the
 * wording a refusal carries to the model, which is what actually changes the
 * model's next move, lives where it can be read and tested on its own.
 */

import type { ApprovalOffer } from './approvalMessages';

export type ToolApprovalOutcome =
  | 'approved'
  | 'declined'
  | { kind: 'timeout'; minutes: number; carried?: true };

/**
 * Format a declined or timed-out approval for the model's tool-result row.
 *
 * A human decline carries no alternative. It used to append `— use this
 * instead: <the gate's hint>`, and in the live test the owner declined a
 * recursive delete and the agent read that hint as an instruction and deleted
 * the folder with `delete_file` anyway. A person who says no means no; the
 * sanctioned alternative stays on the CARD (`approvalCallOptions.ts`), where it
 * can change what the owner clicks, and in the unattended refusal below, where
 * nobody is there to say no at all.
 */
export function toolApprovalResult(
  toolName: string,
  outcome: Exclude<ToolApprovalOutcome, 'approved'>,
): string {
  return typeof outcome === 'string'
    ? `User declined: ${toolName}. The user said no to this action: do not do the same thing another way (another tool, command or path) unless they ask for it.`
    : outcome.carried
      ? `Not run: an approval earlier in this turn went unanswered for ${outcome.minutes} min, so no card was shown for this ${toolName} call. Do not retry it this turn. Finish the remaining steps, then list this one as not done in your final reply.`
      : `Not run: nobody answered the approval for ${toolName} within ${outcome.minutes} min. ` +
        'Do not retry it this turn. Finish the remaining steps, then list this one as not done in your final reply.';
}

/** Why a gate that no automated answer is allowed for is refused on the spot, in
 *  an unattended run. It lives here because it is the wording the model acts on,
 *  which is what this file owns, not the queue's business. A chat with Clanker on
 *  no longer gets this refusal: its keyed calls were answered by
 *  `chatApprovalRules.ts` and an unkeyable one gets a card, so the only run that
 *  still refuses a taint gate without one is a run with nobody in it at all. */
export const SECRET_TAINT_REFUSAL_REASON =
  'This chat has read a secret file, so nothing more is sent out of it without you.';

/** Close a fragment into a sentence. A refusal's `why` and `alternative` come
 *  from whoever raised the card — a deny-list rule name (`git checkout/restore
 *  discarding work`), a secret-path gate's line naming the pattern it matched —
 *  and they may not end with a full stop, which is how "…discarding work Use
 *  this instead" reached the model. A part that already ends a sentence is left
 *  exactly as it is, so nothing that reads well today is re-punctuated.
 */
function asSentence(part: string): string {
  const text = part.trim();
  return /[.?!]["')\]]*$/u.test(text) ? text : `${text}.`;
}

/** A tool was refused by policy rather than by a human. Only an unattended run
 *  refuses this way now: a chat with Clanker on gets a card for every call the
 *  key rules do not answer, so there is no `/clanker` refusal left to word and
 *  the three tails that carried one (`denyList`, `ownerGate`, `taintGate`) went
 *  with it. */
export class ToolApprovalPolicyDenied extends Error {
  constructor(
    toolName: string,
    run: {
      /** False for an unattended bus turn, which has no RESULT contract. */
      job?: boolean;
      /** The exact unattended policy list this key must be added to. */
      allowPath?: string;
      approvalKey?: string;
      /** Why this call is dangerous, in one line, from the gate that raised it. */
      why?: string;
      /** What the agent should do instead, from that same gate. A refusal that
       *  only says "no" sends the model back at the same wall; this is what
       *  changes its next move. */
      alternative?: string;
    } = {},
  ) {
    const job = run.job ?? true;
    const denied = run.allowPath
      ? `unattended: approval key denied by policy: "${toolName}".`
      : `unattended: dangerous tool denied by policy: "${toolName}".`;
    super(
      [
        denied,
        run.allowPath && run.approvalKey
          ? `Add ${run.approvalKey} to ${run.allowPath} in ~/.forge/policy.yaml.`
          : '',
        run.why ? asSentence(run.why) : '',
        run.alternative ? `Use this instead: ${asSentence(run.alternative)}` : '',
        job
          ? 'Stop and report RESULT: failed naming the action you needed.'
          : 'Nobody is present to approve it, so do not retry it. Recycle-bin ' +
            'deletes are allowed; only a permanent delete (to_trash: false) is ' +
            'dangerous. Continue with safe steps or report the step as not done.',
      ]
        .filter((part) => part !== '')
        .join(' '),
    );
    this.name = 'ToolApprovalPolicyDenied';
  }
}

/**
 * How a call asks to be judged when nobody answers it, set by the gate that
 * raised the card (`ToolDispatch` passes it straight through). It classifies
 * the gate; it does not choose who answers it.
 *
 * `ownerGate` is the exfil gates' request: the decision belongs to the owner, so
 * in an unattended run — where nobody is at the card — the call is refused at
 * once instead of waiting. `taintGate` is the opposite half of the same fact: a
 * fetch in a chat that has read a secret may never be answered by anything but
 * the owner, because no automated answer can see what this chat has already
 * read, so an unattended run refuses it at once too. A chat with Clanker on is
 * not an unattended run: `chatApprovalRules.ts` answers its keyed calls before a
 * card opens, and an unkeyable one gets the card, so these three kinds now refuse
 * without one only where nobody is present at all. `denyList` is the deny list's
 * own answer: an unattended run has no judgement to make — refuse at once, with
 * no card, and name the sanctioned tool in `alternative` — while a chat with
 * somebody in it keeps its card and its wait exactly as before, `taintGate`'s
 * included. Absent means the ordinary rule: a dangerous call keeps its card in
 * any chat with a human — Clanker included — and an unattended run refuses it,
 * because nobody is there to answer that card.
 */
export interface ToolApprovalCallOptions {
  gateKind?: 'ownerGate' | 'taintGate' | 'denyList';
  /** What made this card exist, in one line, from the gate that knows it. */
  cardReason?: string;
  /** What the agent should do instead, from the same gate. It travels with the
   *  request so a refusal by policy can name the alternative, not just the no. */
  alternative?: string;
  /** The card's "Allow for this chat" offer: the keys this call needs that the
   *  owner could allow, and what they say in plain words. Written by
   *  `chatApprovalRules.ts` when nothing had already answered the call, and read
   *  by every surface that renders the card, so a card that cannot be allowed
   *  shows two buttons everywhere rather than three in one place and two in
   *  another. `approvalCallOptions.ts` is the one place that assembles it.
   */
  allowForChat?: ApprovalOffer;
  /** The distinct owner-only project-policy button, available only when there
   *  is a workspace and a key the policy can store. */
  alwaysInProject?: ApprovalOffer;
  /** Set only for a keyed unattended call that policy did not allow. */
  policyAllowPath?: string;
  policyApprovalKey?: string;
}
