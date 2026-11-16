import type { ToolApprovalRequestEvent } from '../sidebar/ToolApprovalService';
import { escapeTelegramHtml } from './telegramHtml';
import { codePointLength } from '../util/codePoints';

/**
 * The text one approval gate puts on a phone: the card itself, and the plain
 * line for a gate nobody but the owner can answer.
 *
 * Split out of `RemoteApprovalBridge.ts` for the 500-line `max-lines` stop —
 * that file keeps the gate bookkeeping, and these two pure functions own the
 * message shapes. They are the only place a card is built, so the bridge's
 * `send` call stays a one-liner about delivery.
 */

/**
 * The line a phone gets when nobody but the owner can answer this gate.
 *
 * Short, plain, and outside the card's detail: the detail is where the causes
 * are written, and it is also the part the transport clips first, so a sentence
 * inside it is the first thing an owner with a long card stops seeing. This one
 * cannot be clipped, and it says what the owner has to do and where.
 */
export function waitingForOwnerLine(event: ToolApprovalRequestEvent): string {
  return (
    `Forge approval ${event.toolName} is waiting for you: nothing but your answer ` +
    'settles it. Approve or Deny it here, or from the Forge sidebar.'
  );
}

export function formatApprovalPrompt(
  event: ToolApprovalRequestEvent,
  maximum: number,
  telegramHtml: boolean,
): string {
  const danger = event.dangerous ? ' DANGEROUS' : '';
  const offerLine = event.allowForChat
    ? '\nAllow for this chat covers: ' + event.allowForChat.label + '.'
    : '';
  const alwaysLine = event.alwaysInProject
    ? '\nAlways in this project covers: ' + event.alwaysInProject.label + '.'
    : '';
  const fullOfferLine = offerLine + alwaysLine;
  const plainPrefix = 'Forge approval' + danger + ': ' + event.toolName + '\n';
  if (!telegramHtml) {
    const budget = Math.max(
      0,
      maximum - codePointLength(plainPrefix) - codePointLength(fullOfferLine),
    );
    let detail = '';
    for (const character of event.detail) {
      if (codePointLength(detail) + codePointLength(character) > budget) break;
      detail += character;
    }
    return plainPrefix + detail + fullOfferLine;
  }
  const heading = event.dangerous
    ? `<b>⚠ Dangerous: ${escapeTelegramHtml(event.toolName)}</b>`
    : `<b>Approve ${escapeTelegramHtml(event.toolName)}?</b>`;
  const prefix = `${heading}\n<pre>`;
  const suffix =
    '</pre>' + (fullOfferLine ? '\n' + escapeTelegramHtml(fullOfferLine.slice(1)) : '');
  const budget = Math.max(0, maximum - codePointLength(prefix) - codePointLength(suffix));
  let detail = '';
  let escapedLength = 0;
  for (const character of event.detail) {
    const escapedCharacter = escapeTelegramHtml(character);
    const cost = codePointLength(escapedCharacter);
    if (escapedLength + cost > budget) break;
    detail += character;
    escapedLength += cost;
  }
  return `${prefix}${escapeTelegramHtml(detail)}${suffix}`;
}
