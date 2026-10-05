import { describe, expect, it, vi } from 'vitest';
import {
  draftChatId,
  isDefinitiveDraftRejection,
  TelegramRichDrafts,
} from '../../src/remote/telegramRichDraft';

/**
 * Phase 2: the rich-draft progress transport.
 *
 * The mistakes this file exists to prevent are the specific ones the Bot API
 * shape invites: reading `sendRichMessageDraft`'s `True` return as an id,
 * reviving `can_stop` (it flashed the chat's Send button into Stop), treating a throttled or 5xx response
 * as "unsupported" (which would put a second progress bubble next to a draft
 * the user may be looking at), and allocating draft ids that restart at 1.
 */

interface Call {
  method: string;
  body: Record<string, unknown>;
}

function recording(result: unknown = true) {
  const calls: Call[] = [];
  const call = vi.fn(async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body });
    return result;
  });
  return { calls, call };
}

/** A transport whose every call rejects with `message` — a factory, not a call. */
function failingWith(message: string) {
  return vi.fn(async (): Promise<never> => {
    throw new Error(message);
  });
}

describe('TelegramRichDrafts — draft identity', () => {
  it('supplies a generated nonzero integer draft_id and treats True as success, not as an id', async () => {
    const { calls, call } = recording(true);
    const drafts = new TelegramRichDrafts(call);

    const opened = await drafts.beginDraft('99', 'Forge: working…');

    expect(opened).toEqual({ kind: 'open', draftId: expect.any(Number) });
    const draftId = (opened as { draftId: number }).draftId;
    expect(Number.isSafeInteger(draftId)).toBe(true);
    expect(draftId).toBeGreaterThan(0);
    // The return value is never consulted as an id: the id is the one we sent.
    expect(calls[0]).toMatchObject({ method: 'sendRichMessageDraft', body: { draft_id: draftId } });
  });

  it('sends chat_id as an integer on draft calls, as the Bot API types it', async () => {
    const { calls, call } = recording(true);
    const drafts = new TelegramRichDrafts(call);
    await drafts.beginDraft('99', 'Forge: working…');
    await drafts.updateDraft('99', 5, 'Forge: working…');

    // `sendRichMessageDraft` documents chat_id as Integer ("target private
    // chat"), unlike the usual "Integer or String".
    expect(calls.map((c) => c.body.chat_id)).toEqual([99, 99]);
    expect(calls.every((c) => typeof c.body.chat_id === 'number')).toBe(true);
  });

  it('refuses a non-numeric chat id rather than sending a value that reads as unsupported', async () => {
    const { calls, call } = recording(true);
    const drafts = new TelegramRichDrafts(call);
    // A 400 for a junk chat_id would otherwise be classified as an
    // unsupported-format answer and wrongly flip the turn to the plain bubble.
    const opened = await drafts.beginDraft('not-a-chat-id', 'Forge: working…');
    expect(opened.kind).toBe('unknown');
    expect(calls).toEqual([]);
    expect(() => draftChatId('9007199254740993')).toThrowError();
    expect(draftChatId('-100200')).toBe(-100200);
  });

  it('never sets can_stop or keep_on_stop on a draft send', async () => {
    const { calls, call } = recording(true);
    const drafts = new TelegramRichDrafts(call);
    await drafts.beginDraft('99', 'Forge: working…');
    await drafts.updateDraft('99', 5, 'Forge: working… one');
    await drafts.updateDraft('99', 5, 'Forge: working… two');

    // can_stop swapped the chat's Send button for Stop while a preview lived;
    // the turn's Stop is the status bubble's button.
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => !('can_stop' in c.body))).toBe(true);
    // keep_on_stop keeps the preview briefly and preserves nothing. Reading it
    // as durability would leave a status that silently vanishes.
    expect(calls.every((c) => !('keep_on_stop' in c.body))).toBe(true);
  });

  it('allocates a unique id per turn and never reuses one inside an instance', async () => {
    const { call } = recording(true);
    const drafts = new TelegramRichDrafts(call);
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const opened = await drafts.beginDraft('99', 'a');
      ids.push((opened as { draftId: number }).draftId);
    }
    expect(new Set(ids).size).toBe(5);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('generates draft ids that do not collide across instances', async () => {
    // A preview lives ~30 s on Telegram's side, so a Stop can reach a freshly
    // started window naming an id the previous window opened. Ids that restart
    // at 1 would let that stale press cancel a brand-new turn.
    const first = new TelegramRichDrafts(vi.fn(async () => true));
    const second = new TelegramRichDrafts(vi.fn(async () => true));
    const a = (await first.beginDraft('99', 'a')) as { draftId: number };
    const b = (await second.beginDraft('99', 'b')) as { draftId: number };
    expect(a.draftId).not.toBe(b.draftId);
    expect(a.draftId).toBeGreaterThan(0);
    expect(Number.isSafeInteger(a.draftId)).toBe(true);
  });

  it('reuses the same draft_id for updates so the preview animates in place', async () => {
    const { calls, call } = recording(true);
    const drafts = new TelegramRichDrafts(call);
    const opened = await drafts.beginDraft('99', 'Forge: working…');
    const draftId = (opened as { draftId: number }).draftId;

    await drafts.updateDraft('99', draftId, 'Forge: working…\n\nRunning read_file…');
    await drafts.updateDraft('99', draftId, 'Forge: working…\n\nRunning write_file…');

    expect(calls.slice(1).map((c) => c.body.draft_id)).toEqual([draftId, draftId]);
    expect(calls.slice(1).every((c) => c.method === 'sendRichMessageDraft')).toBe(true);
  });
});

describe('TelegramRichDrafts — response acceptance', () => {
  it('treats only a literal True as an opened draft', async () => {
    for (const result of [false, undefined, null, {}, 'ok', 0]) {
      const drafts = new TelegramRichDrafts(vi.fn(async () => result));
      const opened = await drafts.beginDraft('99', 'Forge: working…');
      // Not confirmation that a preview exists: the caller must not start
      // animating a draft Telegram never accepted.
      expect(opened.kind).toBe('unknown');
    }
  });

});

describe('TelegramRichDrafts — fallback classification', () => {
  it('classifies only unsupported method or format answers as definitive', async () => {
    for (const message of [
      // An API without the method answers 404.
      'Telegram Bot API HTTP 404.',
      // The method was understood and the payload refused.
      'Telegram Bot API HTTP 400.',
      'Telegram Bot API rejected sendRichMessageDraft.',
    ]) {
      const drafts = new TelegramRichDrafts(failingWith(message));
      await expect(drafts.beginDraft('99', 'Forge: working…')).resolves.toEqual({
        kind: 'unsupported',
      });
    }
  });

  it('treats throttling and server errors as unknown, never as unsupported', async () => {
    // A 429 after the retry budget, or a 5xx that can follow upstream
    // acceptance, says nothing about support. Falling back there risks a second
    // progress bubble next to a draft the user may be looking at.
    for (const message of [
      'Telegram Bot API HTTP 429.',
      'Telegram Bot API HTTP 500.',
      'Telegram Bot API HTTP 502.',
      'Telegram Bot API HTTP 503.',
      'Telegram Bot API returned an unreadable sendRichMessageDraft response.',
    ]) {
      const drafts = new TelegramRichDrafts(failingWith(message));
      const opened = await drafts.beginDraft('99', 'Forge: working…');
      expect(opened.kind).toBe('unknown');
      expect(isDefinitiveDraftRejection(new Error(message))).toBe(false);
    }
  });

  it('treats a lost or aborted response as unknown', async () => {
    const drafts = new TelegramRichDrafts(failingWith('fetch failed'));
    const opened = await drafts.beginDraft('99', 'Forge: working…');
    expect(opened.kind).toBe('unknown');
    expect((opened as { error: string }).error).toContain('fetch failed');
  });

  it('reports an abort before or during the send as unknown without calling the API', async () => {
    const call = vi.fn(async () => true);
    const drafts = new TelegramRichDrafts(call);
    const aborted = new AbortController();
    aborted.abort();

    await expect(
      drafts.beginDraft('99', 'Forge: working…', { signal: aborted.signal }),
    ).resolves.toMatchObject({ kind: 'unknown' });
    expect(call).not.toHaveBeenCalled();
  });

  it('names only errors the server actually answered as definitive', () => {
    expect(isDefinitiveDraftRejection(new Error('Telegram Bot API HTTP 400.'))).toBe(true);
    expect(isDefinitiveDraftRejection(new Error('Telegram Bot API HTTP 404.'))).toBe(true);
    expect(isDefinitiveDraftRejection('Telegram Bot API rejected sendRichMessageDraft.')).toBe(true);
    expect(isDefinitiveDraftRejection(new Error('Telegram Bot API HTTP 429.'))).toBe(false);
    expect(isDefinitiveDraftRejection(new Error('Telegram Bot API HTTP 502.'))).toBe(false);
    expect(isDefinitiveDraftRejection(new Error('fetch failed'))).toBe(false);
    expect(isDefinitiveDraftRejection(new Error('aborted'))).toBe(false);
  });
});
