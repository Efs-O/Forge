/** Applies an owner's chat-rule card decision and reports a failed save. */
import type { HostToWebview } from './messageBridge';
import type { ApprovalOffer } from './approvalMessages';
import { getLogger } from '../util/logger';

/** The queue supplies the offered keys and the one chat that owns the card. */
export function applyChatApprovalRule(options: {
  offer: ApprovalOffer | undefined;
  conversationId: string | undefined;
  allow?: (
    conversationId: string,
    keys: readonly string[],
  ) => readonly { key: string; reason: string }[] | undefined;
  post: (message: HostToWebview) => void;
}): readonly string[] | undefined {
  const { offer, conversationId } = options;
  if (!offer || !conversationId) return undefined;
  const failures = options.allow
    ? (options.allow(conversationId, offer.keys) ?? [])
    : offer.keys.map((key) => ({ key, reason: 'this window has nowhere to store a chat rule' }));
  if (failures.length === 0) return undefined;
  const reasons = failures.map((failure) => `${failure.key}: ${failure.reason}`);
  const sentence = reasons.join('; ');
  options.post({
    type: 'notice',
    message:
      `Allow for this chat could not store ${reasons.length === 1 ? 'a rule' : 'rules'}: ` +
      `${sentence}. This call ran as you approved it; the next identical call will ask again.`,
    conversationId,
  });
  getLogger().warn(`Forge approval rule not stored: ${sentence}`);
  return reasons;
}
