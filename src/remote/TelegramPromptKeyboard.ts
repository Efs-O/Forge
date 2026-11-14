/**
 * The approval keyboard a Telegram prompt message carries.
 *
 * A gate is sent with Approve/Deny buttons; when it is answered, times out or
 * is cancelled, those buttons must stop looking pressable. That needs the
 * message id of every send that carried a keyboard for this correlation id —
 * a republished gate leaves more than one — so the ids are remembered here,
 * bounded, and used to rewrite the row in place.
 *
 * `TelegramOutbound` owns the text of a bubble; this owns its fate.
 */
import { describeError } from '../util/describeError';
import { resolvedApprovalButton, telegramApprovalKeyboard } from './telegramApprovalKeyboard';
import type { ApprovalDecision } from '../sidebar/approvalMessages';

/**
 * correlationId -> message_id of the prompt that carries its keyboard. Bounded:
 * an approval nobody ever answers would otherwise leak an entry per prompt for
 * the life of the window.
 */
const PROMPT_MESSAGE_LIMIT = 256;

type EditReplyMarkup = (
  chatId: string,
  messageId: string,
  replyMarkup: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<void>;

export class TelegramPromptKeyboard {
  private readonly promptMessages = new Map<string, number>();

  constructor(private readonly editReplyMarkup: EditReplyMarkup) {}

  /** The buttons to attach to the first chunk of a gate, in its own row layout. */
  keyboardFor(
    correlationId: string,
    options: { allowChat?: boolean; alwaysInProject?: boolean },
  ): { inline_keyboard: ReturnType<typeof telegramApprovalKeyboard> } {
    return {
      inline_keyboard: telegramApprovalKeyboard(correlationId, {
        ...(options.allowChat ? { allowChat: true } : {}),
        ...(options.alwaysInProject ? { alwaysInProject: true } : {}),
      }),
    };
  }

  remember(correlationId: string, messageId: number): void {
    if (this.promptMessages.size >= PROMPT_MESSAGE_LIMIT) {
      const oldest = this.promptMessages.keys().next();
      if (!oldest.done) this.promptMessages.delete(oldest.value);
    }
    this.promptMessages.set(correlationId, messageId);
  }

  /**
   * Replace a resolved prompt's Approve/Deny row with a single disabled button
   * naming the outcome, so the row stays visible instead of vanishing.
   *
   * `keyboardMessageIds` is what the approval bridge recorded from every send
   * that carried a keyboard for this correlation id — a republished gate leaves
   * more than one, and a keyboard Telegram never takes back is a button that
   * still looks pressable. The id remembered here for the correlation id is
   * folded in as well, so a bridge that lost track of one chunk still gets it
   * greyed out.
   *
   * The remembered correlation entry is dropped either way: this is the method
   * that clears it for a resolved prompt, and it must not blank the button it
   * just resolved.
   *
   * `decision` is the answer as the four choices every surface uses, carried
   * down from the bridge that has it. Without it a card allowed for the chat
   * reads `Approved ✓`, which says nothing was remembered when a rule was just
   * written.
   *
   * Throws when an edit failed, naming both the resolved-button failure and the
   * empty-keyboard fallback's failure when that failed too — a swallowed
   * failure here means the user keeps staring at a live Approve button with no
   * sign that anything went wrong.
   */
  async resolve(
    chatId: string,
    correlationId: string,
    keyboardMessageIds: readonly string[],
    approved: boolean,
    options?: { signal?: AbortSignal },
    reason?: 'resolved' | 'cancelled' | 'timeout',
    decision?: ApprovalDecision,
  ): Promise<void> {
    const remembered = this.promptMessages.get(correlationId);
    this.promptMessages.delete(correlationId);
    const messageIds = [
      ...new Set([
        ...keyboardMessageIds,
        ...(remembered === undefined ? [] : [String(remembered)]),
      ]),
    ];
    const failures: string[] = [];
    for (const messageId of messageIds) {
      try {
        await this.editReplyMarkup(
          chatId,
          messageId,
          {
            inline_keyboard: [[resolvedApprovalButton(approved, reason, decision)]],
          },
          options?.signal,
        );
      } catch (err) {
        const disabledFailure = describeError(err);
        // Better a row that is gone than a row that still looks pressable.
        try {
          await this.editReplyMarkup(chatId, messageId, { inline_keyboard: [] }, options?.signal);
          failures.push(
            `resolved approval button could not be set on message ${messageId} (keyboard cleared instead): ${disabledFailure}`,
          );
        } catch (clearErr) {
          failures.push(
            `resolved approval button could not be set on message ${messageId} and its keyboard could not be cleared either: ${disabledFailure}; ${describeError(clearErr)}`,
          );
        }
      }
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
  }

  /** Drop the buttons from a prompt nobody answered, without touching its text. */
  async retract(chatId: string, correlationId: string, signal?: AbortSignal): Promise<void> {
    const messageId = this.promptMessages.get(correlationId);
    this.promptMessages.delete(correlationId);
    if (messageId === undefined) return;
    await this.editReplyMarkup(chatId, String(messageId), { inline_keyboard: [] }, signal).catch(
      () => undefined,
    );
  }
}
