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
import { ToolApprovalRefusal } from '../tools/toolContract';

export type ToolApprovalOutcome =
  | 'approved'
  | 'declined'
  | { kind: 'timeout'; minutes: number; carried?: true };

/** Anything that is not a granted approval: the outcomes `toolApprovalResult` words. */
export type UngrantedApprovalOutcome =
  | 'declined'
  | { kind: 'timeout'; minutes: number; carried?: true };

/** `41s`, `5m09s`, `12m` — the wait an approval cost, in the shape a card's
 *  answer takes in a sentence. Minutes first, because a card that gets answered
 *  at all usually waited minutes, which is the whole point of reporting it. */
export function formatApprovalWait(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

/** The line a granted card approval adds to the tool result, or '' when nobody
 *  waited. One place, so every gated tool attributes the wait the same way instead
 *  of each tool inventing its own claim about who said yes (BUG-14: `web_fetch`
 *  said "approved for the rest of it" and the model read that as automatic). */
export function approvalGrantNote(waitedMs: number | undefined): string {
  if (waitedMs === undefined) return '';
  return `[you approved this call after ${formatApprovalWait(waitedMs)}]`;
}

/**
 * What an unanswered approval silences: the exact approval this call needs.
 *
 * A card that offered "Allow for this chat" carries the keys it would store, and
 * those keys are what a later call would re-ask for, so they are the honest
 * identity of "the same approval". With no offer to go on, the tool and the gate
 * that raised the card are the best answer available — enough to keep an ignored
 * `schedule_wake` from silencing `manage_jobs create`, which is what the old
 * one-mark-per-chat used to do (2026-11-13 lab, rep 21).
 */
export function approvalCarryKey(
  toolName: string,
  options?: Pick<ToolApprovalCallOptions, 'allowForChat' | 'policyApprovalKey' | 'gateKind'>,
): string {
  const offered = options?.allowForChat?.keys;
  if (offered && offered.length > 0) return `keys:${[...offered].sort().join('|')}`;
  if (options?.policyApprovalKey) return `key:${options.policyApprovalKey}`;
  return `tool:${toolName}${options?.gateKind ? `:gate:${options.gateKind}` : ''}`;
}

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
export function toolApprovalResult(toolName: string, outcome: UngrantedApprovalOutcome): string {
  return typeof outcome === 'string'
    ? `User declined: ${toolName}. The user said no to this action: do not do the same thing another way (another tool, command or path) unless they ask for it.`
    : outcome.carried
      ? `Not run: this ${toolName} call needs the approval that went unanswered earlier in this turn (${outcome.minutes} min), so no new card was shown. Do not retry it this turn. Finish the remaining steps, then list this one as not done in your final reply.`
      : `Not run: nobody answered the approval for ${toolName} within ${outcome.minutes} min. ` +
        'Do not retry it this turn. Finish the remaining steps, then list this one as not done in your final reply.';
}

/** Why secret egress is refused on the spot in an unattended run. It lives here
 *  because this is the wording the model acts on, not the queue's business. An
 *  attended Clanker chat keeps the secret-egress stop as an owner card; unattended
 *  runs retain their existing policy-denied outcome. */
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

/** A tool was refused by policy rather than by a human. Unattended runs retain
 *  this outcome; attended Clanker calls are handled by the three stops (deny-listed
 *  destructive shell commands, Forge guard files, and secret reads followed by
 *  egress) before they reach the queue. */
export class ToolApprovalPolicyDenied extends ToolApprovalRefusal {
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
          : 'Nobody is present to approve it, so do not retry it. ' +
            // The recycle-bin hint is delete_file's alone: on any other tool it
            // points the model at a to_trash argument that tool does not take.
            (toolName === 'delete_file'
              ? 'Recycle-bin deletes are allowed; only a permanent delete (to_trash: false) is dangerous. '
              : '') +
            'Continue with safe steps or report the step as not done.',
      ]
        .filter((part) => part !== '')
        .join(' '),
    );
    this.name = 'ToolApprovalPolicyDenied';
  }
}

/** A Clanker chat that answers one deny-list stop itself instead of waiting on
 *  an owner card. Only the rules that say so (`clankerRedirect`) get this
 *  answer, and only in a chat with a person in the tab it was armed in: the
 *  unattended refusal above stays what a run with nobody in it gets.
 *
 *  The two parts the agent acts on are the rule's own name and the sanctioned
 *  alternative it carries, so rewording the rule rewords this refusal too. The
 *  tail says what the agent cannot infer from the refusal alone: the card it
 *  would have expected was never coming, and the file it is about to overwrite
 *  is already snapshotted, so Undo can bring the content back. */
export class ClankerDenyListRedirect extends ToolApprovalRefusal {
  constructor(
    toolName: string,
    redirect: {
      /** The rule that stopped the call, in the deny list's own words. */
      rule: string;
      /** The tool the agent should use instead, from that same rule. */
      alternative?: string;
    },
  ) {
    super(
      [
        `Clanker: "${toolName}" was not run: ${asSentence(redirect.rule)}`,
        redirect.alternative ? `Use this instead: ${asSentence(redirect.alternative)}` : '',
        'Forge snapshots the file first, so Undo can bring it back.',
        'No approval card was raised.',
      ]
        .filter((part) => part !== '')
        .join(' '),
    );
    this.name = 'ClankerDenyListRedirect';
  }
}

/**
 * How a call asks to be judged when nobody answers it, set by the gate that
 * raised the card (`ToolDispatch` passes it straight through). It classifies
 * the gate; it does not choose who answers it.
 *
 * `ownerGate` and `taintGate` describe why unattended runs refuse a gated call
 * instead of waiting for an owner. `denyList` carries the deny list's refusal and
 * sanctioned alternative. In attended chats, Clanker answers these gates unless
 * the call is a deny-listed destructive shell command, touches a Forge guard file,
 * or sends data out after a secret read; the `clankerStop` option carries those
 * stops into this queue. With Clanker off, normal approval cards remain.
 */
export interface ToolApprovalCallOptions {
  gateKind?: 'ownerGate' | 'taintGate' | 'denyList';
  /** A tool-owned protected stop that attended Clanker must leave to the owner. */
  clankerStop?: boolean;
  /** What made this card exist, in one line, from the gate that knows it. */
  cardReason?: string;
  /** What the agent should do instead, from the same gate. It travels with the
   *  request so a refusal by policy can name the alternative, not just the no. */
  alternative?: string;
  /** The deny-list rule that stopped this call, named by the rule itself
   *  (`git checkout/restore discarding work`), from `ToolApprovalMetadata.denyRule`.
   *  The typed identity a decision can be made on: `cardReason` is the card's
   *  prose around the same name, and a decision that read the card's text back
   *  would break the day the card is reworded. */
  denyRule?: string;
  /** The stopping rule's own answer for a Clanker chat: refuse and name the
   *  alternative, no card. From `ShellTokenRule.clankerRedirect`, so which rules
   *  answer themselves is decided where the rule is written, not here. */
  clankerRedirect?: boolean;
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
  /** A box the caller hands in and reads back. The queue writes the owner's wait
   *  into it when it answers this call from a card, so the wait can reach the
   *  tool result while the outcome stays the plain `'approved'` string every
   *  consumer already compares against — no second ledger to consult. */
  grant?: ApprovalGrantRecord;
}

/** What the queue reports back through `ToolApprovalCallOptions.grant`. */
export interface ApprovalGrantRecord {
  /** Set when a card was shown and answered: how long the owner took, measured
   *  from the moment the card was SHOWN. A card that queued behind another was
   *  not on screen for its share of the turn, so that share is not charged here. */
  waitedMs?: number;
}
