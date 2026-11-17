/**
 * Who answers a gated call BEFORE any card opens, and why nobody is asked instead.
 *
 * Split out of `ToolApprovalService.ts` so the queue stays the owner of card
 * STATE — its queue, its timers, its mirrors — while the two standing pre-card
 * answers live where their rules can be read and tested on their own:
 *
 *  - An **unattended run** (a job, or a bus turn a job relays to a peer chat) has no owner to
 *    click. A keyed call policy did not allow is refused naming the exact line to
 *    add; a taint gate is refused because only the owner can clear a taint; a
 *    dangerous call is refused whatever an automated answer would have said; any
 *    other call is approved, because a run nobody is in has to be able to work.
 *  - **Clanker** answers everything in its own chat except the three owner-only
 *    stops (deny-listed destructive shell commands, Forge guard files, a secret
 *    read followed by egress), which arrive tagged on the options. One deny-list
 *    stop answers itself rather than stopping: a rule that carries
 *    `clankerRedirect` is refused at once naming the tool it points at, because
 *    that card only ever stalled a lane the owner was not watching.
 *
 * The queue decides nothing here. It hands over the same six inputs it was
 * handed and gets back either a settled outcome or the word that says a card is
 * still the only answer available.
 */
import type { ToolApprovalAutoApprovedEvent } from './toolApprovalEvents';
import type { UnattendedConversationRegistry } from './unattendedConversations';
import { unattendedFlaggedExitDetails, unattendedTaintGateDetails } from './untrustedExitPolicy';
import {
  ClankerDenyListRedirect,
  ToolApprovalPolicyDenied,
  type ToolApprovalCallOptions,
} from './toolApprovalOutcome';
import type { ToolApprovalOutcome } from './toolApprovalOutcome';

/** What the queue supplies: the registry of runs nobody is in, this chat's Clanker
 *  flag as the queue sees it, and the sink-forwarding the queue already owns. */
export interface AutoAnswerDeps {
  unattended: UnattendedConversationRegistry;
  clankerEnabled: boolean;
  autoApproved: (event: ToolApprovalAutoApprovedEvent) => void;
}

/** `'needs-card'` means no automated answer is allowed for this call: open one. */
export type AutoAnswer = Promise<ToolApprovalOutcome> | 'needs-card';

export function answerBeforeCard(
  toolName: string,
  detail: string,
  dangerous: boolean,
  conversationId: string | undefined,
  options: ToolApprovalCallOptions | undefined,
  deps: AutoAnswerDeps,
): AutoAnswer {
  const { unattended, clankerEnabled, autoApproved } = deps;
  if (conversationId && unattended.has(conversationId) && options?.policyAllowPath) {
    return Promise.reject(
      new ToolApprovalPolicyDenied(toolName, {
        job: unattended.jobMeta(conversationId) !== undefined,
        allowPath: options.policyAllowPath,
        ...(options.policyApprovalKey ? { approvalKey: options.policyApprovalKey } : {}),
        ...unattendedFlaggedExitDetails(options),
      }),
    );
  }
  /* An unattended taint gate requires an owner. Refuse before the dangerous-call
   * branch below can approve it without a card nobody is there to answer. */
  if (options?.gateKind === 'taintGate' && conversationId && unattended.has(conversationId)) {
    return Promise.reject(
      new ToolApprovalPolicyDenied(toolName, {
        job: unattended.jobMeta(conversationId) !== undefined,
        ...unattendedTaintGateDetails(options, conversationId),
      }),
    );
  }
  if (conversationId && unattended.has(conversationId)) {
    if (dangerous) {
      const job = unattended.jobMeta(conversationId) !== undefined;
      // Nothing here can answer it, so refuse at once — naming the pattern and
      // the alternative — and let the run carry on. A deny-list command
      // (`gateKind: 'denyList'`) lands here too, refused whatever an
      // automated answer would have said, with the tool it should use in
      // `options.alternative`.
      return Promise.reject(
        new ToolApprovalPolicyDenied(toolName, {
          job,
          ...(options?.cardReason ? { why: options.cardReason } : {}),
          ...(options?.alternative ? { alternative: options.alternative } : {}),
        }),
      );
    }
    return Promise.resolve('approved');
  }
  /* A deny-list rule that says so (`clankerRedirect`) is answered on the spot in
   * a Clanker chat: refused naming the rule and the sanctioned tool, with no
   * card. The card for this one rule was stalling a lane left alone — eight
   * `git checkout -- <file>` calls on 2026-11-17 waited 1.3 s to 198 s each for
   * an owner who was away — and the tool it points at does the same overwrite
   * behind a checkpoint, so the card protected nothing. Every other deny-list
   * stop stays the owner's, and an unattended chat never reaches this line: it
   * refused above, whatever the rule says. */
  if (conversationId && clankerEnabled && options?.clankerRedirect === true && options.denyRule) {
    return Promise.reject(
      new ClankerDenyListRedirect(toolName, {
        rule: options.denyRule,
        ...(options.alternative ? { alternative: options.alternative } : {}),
      }),
    );
  }
  /* Clanker covers every remaining call except deny-listed destructive shell
   * commands, Forge guard files, and secret reads followed by egress. Dangerous
   * alone is not a stop; the owner wall runs earlier and deny-list gates are tagged. */
  if (
    conversationId &&
    options?.clankerStop !== true &&
    options?.gateKind !== 'denyList' &&
    clankerEnabled
  ) {
    autoApproved({
      toolName,
      ...(detail ? { detail } : {}),
      conversationId,
      answeredBy: 'clanker',
    });
    return Promise.resolve('approved');
  }
  return 'needs-card';
}
