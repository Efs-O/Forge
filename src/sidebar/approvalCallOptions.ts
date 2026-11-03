/**
 * The sixth argument to the approval queue, assembled in one place.
 *
 * `ToolDispatch` used to spell these fields out inside the call that opens the
 * card: three `metadata ? this : verdict : that : {}` fallbacks, sixteen lines of
 * nested ternaries in a file that is at this repo's 500-line gate. The rule they
 * encode is four lines long — whoever raised the card says why, and the
 * untrusted-flag rule is the fallback when no gate had anything to say — so it
 * lives here, where it can be read and tested on its own, and where the card's
 * "Allow for this chat" offer can join it without the dispatch growing.
 *
 * Pure: it decides nothing, reads nothing and calls nothing. A card's reason, its
 * gate kind, its alternative and its offer all arrive from outside.
 */
import type { ToolApprovalMetadata } from '../tools/toolContract';
import type { UntrustedExitVerdict } from './untrustedExitPolicy';
import type { ToolApprovalCallOptions } from './toolApprovalOutcome';
import type { ChatRuleDecision } from './chatApprovalRules';

/**
 * Build the queue's options for one gated call.
 *
 * `metadata` is what the gate that raised the card knows; `exitVerdict` is what
 * the card rule (`untrustedExitPolicy.ts`) worked out when no gate told it
 * otherwise; `offer` is the chat-rule seam's answer to "is there anything the
 * owner could allow here", which is `undefined` for a call that has no key, for a
 * run nobody is in, and for a call a rule or Clanker already answered.
 *
 * A field the caller left `undefined` is left OUT of the object rather than set to
 * `undefined`, exactly as the conditional spreads it replaces did, so a consumer
 * that asks whether the card carried a reason still gets a true answer.
 */
export function approvalCallOptions(
  metadata: ToolApprovalMetadata | undefined,
  exitVerdict: UntrustedExitVerdict,
  chatRule: ChatRuleDecision | undefined,
): ToolApprovalCallOptions {
  const options: ToolApprovalCallOptions = {};
  const gateKind = metadata?.gateKind ?? exitVerdict.gateKind;
  if (gateKind !== undefined) options.gateKind = gateKind;
  const cardReason = metadata?.cardReason ?? exitVerdict.cardReason;
  if (cardReason !== undefined) options.cardReason = cardReason;
  const alternative = metadata?.declineHint ?? exitVerdict.alternative;
  if (alternative !== undefined) options.alternative = alternative;
  if (chatRule?.kind === 'offer') {
    options.allowForChat = chatRule.offer;
    if (chatRule.alwaysInProject !== undefined) options.alwaysInProject = chatRule.alwaysInProject;
  }
  if (chatRule?.kind === 'policy-denied') {
    options.policyAllowPath = chatRule.allowPath;
    options.policyApprovalKey = chatRule.key;
  }
  return options;
}
