import { TELEGRAM_CALLBACK_DATA_LIMIT_BYTES } from './telegramInlineKeyboard';
import type { ApprovalDecision } from '../sidebar/approvalMessages';

/**
 * The buttons under a Telegram approval card, and the one button a resolved card
 * leaves behind. Both live here rather than inside `TelegramOutbound.ts` because
 * they are layout decisions: what a phone user sees and can reach, with nothing
 * around them that the transport owns.
 */

/** The callback prefixes the inbound handler parses (`RemoteApprovalBridge` routes on them). */
const APPROVAL_CALLBACK_PREFIXES = {
  approve: 'a',
  decline: 'd',
  allowChat: 'r',
  alwaysProject: 'p',
} as const;

/** Which of the two rule offers this card carries. A card with neither stays a single row. */
export interface TelegramApprovalOffers {
  allowChat?: boolean;
  alwaysInProject?: boolean;
}

export interface TelegramApprovalButton {
  text: string;
  callback_data: string;
}

/**
 * Two rows, so a phone does not truncate them.
 *
 * Four buttons on one row was the 0.17.117 live test's complaint: Telegram fits
 * about three buttons across before it cuts the label, so `Always in this
 * project` — the longest of the four, and the one that writes a rule to
 * `policy.yaml` — arrived as `Always in this …`. The decision row comes first
 * (Decline, Approve: the answers that run or refuse THIS call), and the rule
 * offers come below it, because they answer the same card and change what the
 * NEXT one does.
 *
 * The callback data is checked against Telegram's 64-byte limit here, before
 * anything is sent: a card that cannot be identified cannot be answered, and a
 * button whose data was cut by Telegram would answer the wrong gate.
 */
export function telegramApprovalKeyboard(
  correlationId: string,
  offers: TelegramApprovalOffers,
): TelegramApprovalButton[][] {
  const data = {
    approve: `${APPROVAL_CALLBACK_PREFIXES.approve}:${correlationId}`,
    decline: `${APPROVAL_CALLBACK_PREFIXES.decline}:${correlationId}`,
    ...(offers.allowChat
      ? { allowChat: `${APPROVAL_CALLBACK_PREFIXES.allowChat}:${correlationId}` }
      : {}),
    ...(offers.alwaysInProject
      ? { alwaysProject: `${APPROVAL_CALLBACK_PREFIXES.alwaysProject}:${correlationId}` }
      : {}),
  };
  for (const value of Object.values(data)) {
    if (Buffer.byteLength(value, 'utf8') > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
      throw new Error('Forge Telegram approval identifier exceeds the Bot API limit.');
    }
  }
  const rows: TelegramApprovalButton[][] = [
    [
      { text: 'Decline', callback_data: data.decline },
      { text: 'Approve', callback_data: data.approve },
    ],
  ];
  if (data.allowChat || data.alwaysProject) {
    rows.push([
      ...(data.allowChat ? [{ text: 'Allow for this chat', callback_data: data.allowChat }] : []),
      ...(data.alwaysProject
        ? [{ text: 'Always in this project', callback_data: data.alwaysProject }]
        : []),
    ]);
  }
  return rows;
}

/**
 * The one button a resolved approval leaves behind, greyed out by Telegram's
 * `DisabledButton` — an object with no fields, not a Boolean.
 *
 * The label names the choice that was actually made. `approved` alone could not
 * tell `Approve` from `Allow for this chat`, and the difference is the whole
 * feature: one ran this call, the other wrote a rule that answers every future
 * one. A card that says `Approved ✓` after the owner allowed the rule for the
 * chat reads as if nothing was remembered — so the decision is carried down from
 * the bridge, which has it, and shown here.
 */
export function resolvedApprovalButton(
  approved: boolean,
  reason?: 'resolved' | 'cancelled' | 'timeout',
  decision?: ApprovalDecision,
): { text: string; disabled: Record<string, never> } {
  return {
    text:
      reason === 'timeout'
        ? 'Timed out — not run'
        : decision === 'allowChat'
          ? 'Allowed for this chat ✓'
          : decision === 'alwaysProject'
            ? 'Always in this project ✓'
            : approved
              ? 'Approved ✓'
              : 'Denied ✗',
    disabled: {},
  };
}
