/** Applies an owner's project-policy card decision and its one locked-file fallback. */
import type { HostToWebview } from './messageBridge';
import type { ApprovalOffer } from './approvalMessages';
import type { AlwaysApprovalWriteResult } from './approvalPolicyRules';
import { getLogger } from '../util/logger';

export interface ProjectApprovalResolution {
  chatRuleErrors?: readonly string[];
  approvalNotice: string;
}

/** Writes only a button's offered keys. A locked policy keeps the same offer in
 *  this chat and tells the owner how to unlock; other write failures do not fall
 *  back to a broader or different storage path. */
export function applyAlwaysProjectApproval(options: {
  offer: ApprovalOffer | undefined;
  chatOffer: ApprovalOffer | undefined;
  conversationId: string | undefined;
  writeAlways?: (keys: readonly string[]) => AlwaysApprovalWriteResult;
  allowChat?: (
    conversationId: string,
    keys: readonly string[],
  ) => readonly { key: string; reason: string }[];
  post: (message: HostToWebview) => void;
}): ProjectApprovalResolution {
  const { offer, chatOffer, conversationId } = options;
  if (!offer) return { approvalNotice: 'No project approval was stored.' };
  const result = options.writeAlways?.(offer.keys) ?? {
    kind: 'failed' as const,
    message: 'The project policy writer is unavailable.',
  };
  if (result.kind === 'written') {
    const approvalNotice = `Always in this project saved (${offer.label}).`;
    options.post({
      type: 'notice',
      message: approvalNotice,
      ...(conversationId ? { conversationId } : {}),
    });
    return { approvalNotice };
  }
  if (result.kind === 'locked') {
    const failures =
      chatOffer && options.allowChat && conversationId
        ? options.allowChat(conversationId, chatOffer.keys)
        : (chatOffer?.keys ?? []).map((key) => ({
            key,
            reason: 'this window has nowhere to store a chat rule',
          }));
    const reasons = failures.map((failure) => `${failure.key}: ${failure.reason}`);
    const approvalNotice =
      `${result.message} The approval was kept for this chat only` +
      (reasons.length ? `; chat rule storage failed: ${reasons.join('; ')}` : '.') +
      ' This call ran as approved.';
    options.post({
      type: 'notice',
      message: approvalNotice,
      ...(conversationId ? { conversationId } : {}),
    });
    getLogger().warn(`Forge project approval not stored: ${approvalNotice}`);
    return {
      ...(reasons.length ? { chatRuleErrors: reasons } : {}),
      approvalNotice,
    };
  }
  const approvalNotice =
    `Could not save Always in this project: ${result.message} This call ran as approved; ` +
    'the project rule was not stored.';
  options.post({
    type: 'notice',
    message: approvalNotice,
    ...(conversationId ? { conversationId } : {}),
  });
  getLogger().warn(`Forge project approval not stored: ${result.message}`);
  return { approvalNotice };
}
