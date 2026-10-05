import { randomInt } from 'node:crypto';
import { describeError } from '../util/describeError';
import { TelegramRateLimitError } from './telegramSendQueue';

/**
 * Telegram rich-draft progress (Bot API 10.2/10.3).
 *
 * A draft is a *preview*, never the message: Telegram documents it as a
 * temporary 30-second preview, and the finalized output only exists once
 * `sendRichMessage` is called. So this module owns two distinct things that
 * are easy to conflate:
 *
 * - `beginDraft`  — opens the preview with the native Stop button.
 * - `updateDraft` — reuses the same `draft_id` so changes animate in place.
 *
 * The bot allocates `draft_id` itself (non-zero, and the same id animates
 * changes), and the method returns `True` — not an id. Treating the return
 * value as an id is the obvious mistake and would make every later update
 * address nothing.
 *
 * This lives outside `TelegramOutbound` because the interesting part is not the
 * HTTP call, it is the *outcome classification* below: a draft the server
 * refused outright is a signal to fall back to the plain bubble, while a draft
 * whose response was simply lost is not, because falling back there would put
 * two progress bubbles in the chat.
 */

/** Non-zero, per the Bot API; zero would be rejected and is never generated. */
const MIN_DRAFT_ID = 1;

/**
 * Draft ids must survive a restart, not merely be unique within one process.
 *
 * A preview lives ~30 seconds on Telegram's side, so a Stop can arrive at a
 * freshly started window naming an id the *previous* window opened. Ids that
 * restart at 1 would let that stale press cancel a brand-new turn. Starting
 * each instance at a random point in a 2^45-wide space makes that collision
 * improbable rather than automatic, and the counter still never repeats an id
 * inside its own instance.
 */
const DRAFT_ID_CEILING = 2 ** 45;

/**
 * How long a draft is trusted to still be on screen without a send.
 *
 * Telegram's preview expires after roughly 30 seconds of no draft for that id.
 * It is not kept alive -- a re-send re-types the same words -- so after this
 * long the words lane opens a fresh preview for the next words instead.
 */
export const DRAFT_LIFETIME_MS = 25_000;

/**
 * Whether a failed draft call means "this transport cannot do rich drafts" or
 * "we do not know".
 *
 * Only two answers are evidence about support: a 404, which is what an API
 * without `sendRichMessageDraft` says, and a 400 or an `ok:false` rejection,
 * which mean the server understood the method and refused the payload. Every
 * other fault — 429 after the retry budget, 5xx, an unreadable body, a fetch
 * failure, an abort — says nothing about support. A 5xx in particular can
 * follow upstream acceptance, so falling back on it risks a second progress
 * bubble next to a draft the user may be looking at.
 */
const HTTP_STATUS = /^Telegram Bot API HTTP (\d{3})\./;
const DEFINITIVE_STATUS = new Set([400, 404]);

export function isDefinitiveDraftRejection(err: unknown): boolean {
  const message = describeError(err);
  const status = HTTP_STATUS.exec(message)?.[1];
  if (status !== undefined) return DEFINITIVE_STATUS.has(Number(status));
  // `ok:false` on an otherwise-successful response: the method was understood
  // and the payload refused, which is a format answer, not a transport one.
  return message.startsWith('Telegram Bot API rejected ');
}

export type DraftOpenOutcome =
  | { kind: 'open'; draftId: number }
  /** The server refused the method or the format: use the plain bubble. */
  | { kind: 'unsupported' }
  /** No usable answer: keep the draft's own fate and send nothing plain. */
  | { kind: 'unknown'; error: string };

/** One block of an `InputRichMessage`. Only the text blocks Forge emits. */
interface InputRichBlock {
  type: 'paragraph' | 'footer' | 'thinking';
  text: string;
}

export interface InputRichMessage {
  blocks: InputRichBlock[];
}

/**
 * Plain progress text -> rich blocks, without inventing structure the text
 * does not have.
 *
 * `renderRemoteProgress` already separates its sections with a blank line, and
 * its last section is the clock line. Those become paragraphs, with the clock
 * as a footer so Telegram renders it de-emphasised rather than as another
 * sentence of status. Splitting on the blank line rather than on every newline
 * keeps a multi-line warning (which `renderRemoteProgress` joins with a single
 * newline) inside one block instead of scattering it.
 */
export function renderRichProgressBlocks(text: string): InputRichMessage {
  const sections = text
    .split(/\n{2,}/)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
  if (sections.length === 0) return { blocks: [{ type: 'paragraph', text: 'Forge: working…' }] };
  const blocks: InputRichBlock[] = sections.slice(0, -1).map((section) => ({
    type: 'paragraph',
    text: section,
  }));
  const last = sections[sections.length - 1]!;
  blocks.push({ type: last.startsWith('⏱') ? 'footer' : 'paragraph', text: last });
  return { blocks };
}

export interface RichDraftTransport {
  /** Allocates the draft id, opens the preview, and reports what happened. */
  beginDraft(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<DraftOpenOutcome>;
  updateDraft(
    chatId: string,
    draftId: number,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

type TelegramCall = (
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export class TelegramRichDrafts implements RichDraftTransport {
  /**
   * Random start, then monotonic. Uniqueness matters because a stopped update
   * names a draft by id alone: a recycled id could match a turn that started
   * after the one the user actually pressed Stop on — including across a
   * restart, which is why the start is random rather than 1.
   */
  private nextDraftId = randomInt(MIN_DRAFT_ID, DRAFT_ID_CEILING);
  /**
   * chatId -> epoch ms before which draft updates are skipped, from a 429's
   * `retry_after`. Skipping is safe because every update renders the whole
   * state: the first one after the pause carries everything the skipped ones
   * would have.
   */
  private readonly pausedUntil = new Map<string, number>();

  /**
   * The channel passes a call that bypasses its chat queue and does not wait
   * out a 429 in place (see `TelegramChannel.richDraft`).
   */
  constructor(private readonly draftCall: TelegramCall) {}

  async beginDraft(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<DraftOpenOutcome> {
    if (options?.signal?.aborted)
      return { kind: 'unknown', error: 'aborted before the draft send' };
    const draftId = this.nextDraftId;
    this.nextDraftId += 1;
    let body: Record<string, unknown>;
    try {
      body = this.draftBody(chatId, draftId, text);
    } catch (err) {
      return { kind: 'unknown', error: describeError(err) };
    }
    try {
      const result = await this.draftCall('sendRichMessageDraft', body, options?.signal);
      // The method returns True and nothing else. Anything that is not `true`
      // is not confirmation that a preview exists, so it is unknown rather than
      // an opened draft — the caller must not go on animating a draft Telegram
      // never accepted.
      if (result !== true) {
        return {
          kind: 'unknown',
          error: `sendRichMessageDraft returned ${JSON.stringify(result) ?? 'no result'}`,
        };
      }
      return { kind: 'open', draftId };
    } catch (err) {
      if (options?.signal?.aborted)
        return { kind: 'unknown', error: 'aborted during the draft send' };
      if (isDefinitiveDraftRejection(err)) return { kind: 'unsupported' };
      return { kind: 'unknown', error: describeError(err) };
    }
  }

  async updateDraft(
    chatId: string,
    draftId: number,
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const paused = this.pausedUntil.get(chatId);
    if (paused !== undefined) {
      if (Date.now() < paused) return;
      this.pausedUntil.delete(chatId);
    }
    try {
      await this.draftCall(
        'sendRichMessageDraft',
        this.draftBody(chatId, draftId, text),
        options?.signal,
      );
    } catch (err) {
      // A throttled preview is skipped, not reported: the next update replaces
      // it anyway, and reporting every 429 of a streaming turn would bury the
      // failures that matter.
      if (err instanceof TelegramRateLimitError) {
        this.pausedUntil.set(chatId, Date.now() + err.retryAfterMs);
        return;
      }
      throw err;
    }
  }

  /**
   * One body for both draft calls.
   *
   * `can_stop` is deliberately NOT set (2026-10-05). With it, Telegram turned
   * the chat's Send button into Stop for as long as a preview lived, so it
   * flashed between the two around every stretch of words, and the Stop update
   * could reach Forge seconds late. The turn's Stop is the status bubble's
   * inline button instead (`TelegramStopButton.ts`).
   *
   * `keep_on_stop` is deliberately NOT set either. It only keeps the preview briefly —
   * Telegram still drops it shortly after, and the docs are explicit that
   * preserving the partial output requires sending it as a new message.
   * Reading it as durability would leave the user with a status that silently
   * vanishes and no final message.
   */
  private draftBody(chatId: string, draftId: number, text: string): Record<string, unknown> {
    return {
      chat_id: draftChatId(chatId),
      draft_id: draftId,
      rich_message: renderRichProgressBlocks(text),
    };
  }
}

/**
 * `sendRichMessageDraft` types chat_id as an Integer, unlike nearly every other
 * Bot API method ("Integer or String") — the draft lane addresses a private
 * chat by its numeric id and nothing else. So the internal string id must be
 * converted, and a non-numeric id is a bug rather than a wire value: sending it
 * would produce a 400 that looks like an unsupported-format answer and would
 * wrongly flip the turn onto the plain bubble.
 */
export function draftChatId(chatId: string): number {
  const numeric = Number(chatId);
  if (!Number.isSafeInteger(numeric)) {
    throw new Error(`Telegram draft chat_id must be a safe integer, received "${chatId}".`);
  }
  return numeric;
}

/**
 * What the progress lifecycle decided when it opened this turn's status bubble.
 *
 * The status bubble is always a plain message edited in place. It used to open
 * as a rich draft, and that was the regression: Telegram animates every change
 * to a draft, so a status line that is rewritten (a tool name, the clock) was
 * re-typed letter by letter on every update. A draft now carries only the
 * model's streamed words (`RemoteAgentProgress`), opened lazily beside this
 * bubble. See docs/plans/TELEGRAM_STATUS_BUBBLE_RESTORE_PLAN.md.
 */
export type ProgressOpen =
  | { kind: 'plain'; messageId: string }
  | { kind: 'declined'; error?: string | undefined };

/**
 * The slice of a transport the progress lifecycle needs, declared here rather
 * than imported from `types.ts`: this module is the one `types.ts` names the
 * draft capability by, and a structural parameter keeps that a one-way
 * dependency instead of a cycle.
 */
export interface ProgressCapableChannel {
  sendProgress?(
    chatId: string,
    text: string,
    options?: { signal?: AbortSignal; stopButton?: boolean },
  ): Promise<string | undefined>;
}

/**
 * Open one turn's status bubble.
 *
 * Shared by both openers (chat-queued drain and sidebar-started mirror) so they
 * cannot drift. Nothing here throws: the drain calls this *before* its
 * try/finally, so a failure escaping here would abandon a claimed request
 * without settling it, which is worse than having no progress bubble at all.
 */
export async function openProgressBubble(
  channel: ProgressCapableChannel,
  chatId: string,
  text: string,
  signal: AbortSignal,
): Promise<ProgressOpen> {
  if (!channel.sendProgress) return { kind: 'declined' };
  try {
    const messageId = await channel.sendProgress(chatId, text, { signal, stopButton: true });
    return messageId ? { kind: 'plain', messageId } : { kind: 'declined' };
  } catch (err) {
    return { kind: 'declined', error: describeError(err) };
  }
}
