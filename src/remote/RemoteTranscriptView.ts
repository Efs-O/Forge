import { boldLineLabel, sendRichText } from './telegramHtml';
import type { ForgeExchange } from '../sidebar/sessionProjections';
import type { RemoteChannel } from './types';

/** `/view` with no argument. Enough to remember an outcome, short enough to read. */
export const DEFAULT_VIEW_COUNT = 3;
/** Ten messages is already a wall on a phone; past it the command stops helping. */
export const MAX_VIEW_COUNT = 10;
/** Telegram's own cap is 4096; the header and the cut marker take the rest. */
const MAX_ANSWER_CHARS = 3_500;
/** A prompt is orientation, not content: one line, never a paragraph. */
const MAX_PROMPT_CHARS = 120;

/** Header prefixes bolded on a transport that parses HTML. */
const VIEW_LABELS = new Set(['Forge']);

export type ViewCountRequest =
  | { kind: 'ok'; count: number; clamped: boolean }
  | { kind: 'invalid' };

/**
 * How many exchanges `/view` was asked for.
 *
 * A number above the maximum is clamped and reported, not refused. Refusing a
 * `/view 20` teaches the command is fragile when the honest answer is "here are
 * the last 10" -- the same reason a denied tool call must name its sanctioned
 * alternative. Nonsense (`/view abc`, `/view 0`) is still a usage error,
 * because there is no honest reading of it.
 */
export function parseViewCount(argument: string | undefined): ViewCountRequest {
  if (argument === undefined) return { kind: 'ok', count: DEFAULT_VIEW_COUNT, clamped: false };
  const requested = Number(argument);
  if (!Number.isInteger(requested) || requested < 1) return { kind: 'invalid' };
  return requested > MAX_VIEW_COUNT
    ? { kind: 'ok', count: MAX_VIEW_COUNT, clamped: true }
    : { kind: 'ok', count: requested, clamped: false };
}

/**
 * One exchange as it is read on a phone.
 *
 * The prompt line is not optional. A recap of five answers with no sight of
 * what each was replying to is not a recap, and `[2/3]` is what tells the
 * reader whether they are looking at all of what they asked for.
 */
export function renderExchange(
  exchange: ForgeExchange,
  index: number,
  total: number,
  note?: string,
): string {
  const prompt = clipLine(tidy(exchange.prompt).replace(/\s+/gu, ' ') || '(no prompt)');
  const answer = clipBody(tidy(exchange.answer));
  const header = `[${String(index)}/${String(total)}] You: ${prompt}`;
  return `${note ? `Forge: ${note}\n\n` : ''}${header}\n\n${answer}`;
}

/**
 * Sends the exchanges oldest first, one message each.
 *
 * Oldest first because that is reading order -- Telegram appends downward, so
 * newest-first would have to be read bottom-up. One message each because a
 * single answer runs to thousands of characters against a 4096 limit: packing
 * several into one means cutting each to a few hundred, which destroys exactly
 * the detail the command exists to recover. An answer that does not fit is cut
 * with a marker rather than split, because half an answer arriving as two
 * notifications is worse than a whole one that says it was cut.
 */
export async function sendTranscriptView(
  channel: RemoteChannel,
  chatId: string,
  exchanges: readonly ForgeExchange[],
  options: { clamped: boolean; signal: AbortSignal },
): Promise<void> {
  if (exchanges.length === 0) {
    await channel.send(chatId, 'Forge: this conversation has no answers yet.', {
      signal: options.signal,
    });
    return;
  }
  const note = options.clamped
    ? `showing the last ${String(MAX_VIEW_COUNT)}, the maximum.`
    : undefined;
  for (const [offset, exchange] of exchanges.entries()) {
    await sendRichText(
      channel,
      chatId,
      renderExchange(exchange, offset + 1, exchanges.length, offset === 0 ? note : undefined),
      (line) => boldHeader(line, VIEW_LABELS),
      { signal: options.signal },
    );
  }
}

function boldHeader(line: string, labels: ReadonlySet<string>): string {
  return /^\[\d+\/\d+\]\s/u.test(line) ? `<b>${line}</b>` : boldLineLabel(line, labels);
}

/**
 * Readable, not merely safe.
 *
 * Control characters would render as replacement boxes, and a model that ends
 * every section with two blank lines turns a phone screen into scrolling. Runs
 * of blank lines collapse to one; the paragraph breaks that carry meaning stay.
 */
function tidy(text: string): string {
  let output = '';
  for (const character of text.replace(/\r\n?/gu, '\n')) {
    const code = character.charCodeAt(0);
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) output += character;
  }
  return output
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/** The header must stay one line, so it ends in an ellipsis, not a marker. */
function clipLine(text: string): string {
  return text.length <= MAX_PROMPT_CHARS
    ? text
    : `${text.slice(0, MAX_PROMPT_CHARS - 1).trimEnd()}…`;
}

function clipBody(text: string): string {
  return text.length <= MAX_ANSWER_CHARS
    ? text
    : `${text.slice(0, MAX_ANSWER_CHARS).trimEnd()}\n\n… (cut; see the Forge window)`;
}
