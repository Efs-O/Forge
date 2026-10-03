import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ImageSearchConfigSchema } from '../../src/config/imageSearchSchema';
import type { ForgeConfig, ImageSearchConfig } from '../../src/config/types';
import { makeImageSearchTool } from '../../src/tools/imageSearch/imageSearchTool';
import type {
  SavedThumbnail,
  ThumbnailCandidate,
  ThumbnailDownload,
} from '../../src/tools/imageSearch/imageThumbnails';
import {
  IMAGE_SEARCH_THUMBNAILS_PREFIX,
  imageSearchThumbnails,
} from '../../src/sidebar/toolResultView';
import {
  FILE_DELIVERY_TURN_LIMIT,
  UserNotificationService,
  type UserNotificationEvent,
} from '../../src/sidebar/UserNotificationService';

/**
 * image_search thumbnail DELIVERY: who gets the photos, and what the model is
 * told when the per-turn file budget says no.
 *
 * Every case here runs a real `UserNotificationService`, not a fake with a
 * `deliverImage` mock: the whole point of the lease API is that the tool cannot
 * quietly skip the budget, and a cast fake is exactly what hid that before.
 */

const STAMP = 1_700_000_000_000;
const FOLDER = `.forge/image-search/${STAMP}`;

function config(overrides: Partial<ImageSearchConfig> = {}): ImageSearchConfig {
  const parsed = ImageSearchConfigSchema.parse({
    provider: 'serpapi_lens',
    secret_key_name: 'serpapi',
    ...overrides,
  });
  if (!parsed) throw new Error('schema returned undefined');
  return parsed;
}

/** Engine candidates on an allowed thumbnail host, in result order. */
function candidates(count: number): ThumbnailCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://serpapi.com/searches/${index}/images/thumb.jpg`,
    title: `Title ${index + 1}`,
    source: `source${index + 1}.example`,
    link: `https://example.com/page/${index + 1}`,
    original: `https://example.com/full/${index + 1}.jpg`,
  }));
}

interface HarnessOptions {
  /** config.thumbnails, i.e. how many candidates the search asks for. */
  thumbnails?: number;
  /** Candidates the engine actually offers (may exceed `thumbnails`). */
  offered?: number;
  /** How many picked candidates the download reports saved. */
  saved?: number;
  failures?: string[];
  /** Chats each sink reports taking the photo. */
  chats?: number | readonly number[];
  /** Slots already spent this turn by another sender. */
  spent?: number;
  conversationId?: string;
  /** No notification service at all (the optional-deps path). */
  noNotifications?: boolean;
  /** Aborts while the download is still running. */
  abortDuringDownload?: boolean;
  /** Aborts the turn after N photos have been handed to the sink. */
  abortAfterSends?: number;
  /** Fires `resetTurn` after N sends, so the next lease send is stale. */
  resetAfterSends?: number;
}

function harness(options: HarnessOptions = {}) {
  const conversationId = options.conversationId ?? 'c1';
  const service = options.noNotifications
    ? undefined
    : new UserNotificationService(undefined, () => 0);
  const controller = new AbortController();
  const delivered: UserNotificationEvent[] = [];
  const sink = vi.fn(async (event: UserNotificationEvent) => {
    delivered.push(event);
    if (options.resetAfterSends === delivered.length) service?.resetTurn(conversationId);
    if (options.abortAfterSends === delivered.length) controller.abort();
    return Array.isArray(options.chats)
      ? (options.chats[delivered.length - 1] ?? 0)
      : (options.chats ?? 1);
  });
  service?.addSink(sink);
  if (options.spent) service?.reserveFileDeliveries(conversationId, options.spent);

  const download = vi.fn(
    async (
      picked: readonly ThumbnailCandidate[],
      _root: string,
      opts: { stamp: number; signal?: AbortSignal },
    ): Promise<ThumbnailDownload> => {
      if (options.abortDuringDownload) {
        controller.abort();
        throw new Error('This operation was aborted');
      }
      if (opts.signal?.aborted) throw new Error('This operation was aborted');
      const kept = picked.slice(0, options.saved ?? picked.length);
      const saved: SavedThumbnail[] = kept.map((thumbnail, index) => ({
        ...thumbnail,
        relativePath: `${FOLDER}/${index + 1}.jpg`,
        absolutePath: `/ws/${FOLDER}/${index + 1}.jpg`,
      }));
      return { saved, failures: options.failures ?? [] };
    },
  );
  const search = vi.fn(async () => ({
    exact_matches: candidates(options.offered ?? options.thumbnails ?? 4).map((c, index) => ({
      position: index + 1,
      title: c.title,
      source: c.source,
      link: c.link,
      thumbnail: c.url,
    })),
  }));
  const tool = makeImageSearchTool({
    getConfig: () => ({ image_search: config({ thumbnails: options.thumbnails ?? 4 }) }) as ForgeConfig,
    secrets: { get: async () => 'serp-key' } as unknown as vscode.SecretStorage,
    ...(service ? { notifications: service } : {}),
    searchLens: search,
    downloadThumbnails: download,
    workspaceRoot: () => '/ws',
    now: () => STAMP,
  });
  const run = () =>
    tool.handler(
      // Pinned to Lens because this harness stubs only `searchLens`; the tool's
      // default engine is yandex, and an unstubbed engine here would reach the
      // network. Delivery budgeting is engine-independent.
      { engine: 'google_lens', image_url: 'https://example.com/input.jpg' },
      { beforeMutate: () => undefined, abortSignal: controller.signal, conversationId },
    );
  return {
    tool,
    service,
    run,
    download,
    delivered,
    sinkCalls: () => delivered.length,
    captions: () => delivered.map((event) => event.text),
    remaining: () => service?.remainingFileDeliveries(conversationId) ?? FILE_DELIVERY_TURN_LIMIT,
    sidebarPaths: (result: string) =>
      imageSearchThumbnails('image_search', result).map((t) => t.path),
  };
}

describe('image_search thumbnail delivery budget', () => {
  it('queues every thumbnail when the budget fits, numbering captions by what was sent', async () => {
    const h = harness({ thumbnails: 4 });
    const result = String(await h.run());
    expect(h.remaining()).toBe(1);
    expect(h.sinkCalls()).toBe(4);
    expect(h.captions()[0]).toBe(
      '🔎 1/4 Title 1 — source1.example\nhttps://example.com/page/1',
    );
    expect(h.captions()[3]).toContain('🔎 4/4 Title 4');
    expect(h.delivered[0]).toMatchObject({ conversationId: 'c1' });
    expect(result).toContain('Sent 4 thumbnail(s) to 1 remote chat(s).');
    expect(result).not.toContain('not queued');
    expect(h.sidebarPaths(result)).toEqual([
      `${FOLDER}/1.jpg`,
      `${FOLDER}/2.jpg`,
      `${FOLDER}/3.jpg`,
      `${FOLDER}/4.jpg`,
    ]);
  });

  it('sends the prefix that fits and names the withheld count in caption and footer', async () => {
    // 3 of the 5 slots already spent by another sender: 2 left for 4 saved.
    const h = harness({ thumbnails: 4, spent: 3 });
    const result = String(await h.run());
    expect(h.sinkCalls()).toBe(2);
    expect(h.captions()).toEqual([
      '🔎 1/2 (of 4 saved; 2 withheld by the per-turn file limit) Title 1 — source1.example\nhttps://example.com/page/1',
      '🔎 2/2 (of 4 saved; 2 withheld by the per-turn file limit) Title 2 — source2.example\nhttps://example.com/page/2',
    ]);
    expect(result).toContain('Sent 2 thumbnail(s) to 1 remote chat(s).');
    expect(result).toContain(
      `2 of 4 thumbnail(s) were not queued to a phone. All 4 are saved under ${FOLDER}`,
    );
    // The sidebar still gets the whole result set, sent or not.
    expect(h.sidebarPaths(result)).toHaveLength(4);
    expect(result).not.toContain(IMAGE_SEARCH_THUMBNAILS_PREFIX + 'undefined');
  });

  it('queues nothing when the turn has no slots left, and says so by folder and count', async () => {
    const h = harness({ thumbnails: 4, spent: FILE_DELIVERY_TURN_LIMIT });
    const result = String(await h.run());
    expect(h.sinkCalls()).toBe(0);
    expect(result).toContain("this turn's file-delivery limit is already spent");
    expect(result).toContain(
      `4 of 4 thumbnail(s) were not queued to a phone. All 4 are saved under ${FOLDER}`,
    );
    expect(result).not.toContain('Sent ');
    expect(h.sidebarPaths(result)).toHaveLength(4);
  });

  it('grants the five slots it has to an eight-thumbnail search, never zero', async () => {
    const h = harness({ thumbnails: 8 });
    const result = String(await h.run());
    expect(h.sinkCalls()).toBe(5);
    expect(h.captions()[0]).toContain('🔎 1/5 (of 8 saved; 3 withheld by the per-turn file limit)');
    expect(result).toContain('Sent 5 thumbnail(s) to 1 remote chat(s).');
    expect(result).toContain('3 of 8 thumbnail(s) were not queued to a phone');
    expect(h.sidebarPaths(result)).toHaveLength(8);
  });

  it('charges only the files that actually saved', async () => {
    const h = harness({ thumbnails: 4, saved: 2, failures: ['#3: HTTP 404', '#4: not an image'] });
    const result = String(await h.run());
    expect(h.remaining()).toBe(3);
    expect(h.sinkCalls()).toBe(2);
    expect(h.captions()[0]).toContain('🔎 1/2 Title 1');
    expect(result).toContain('2 thumbnail(s) could not be saved: #3: HTTP 404; #4: not an image');
    expect(result).toContain('Sent 2 thumbnail(s) to 1 remote chat(s).');
    expect(result).not.toContain('not queued');
  });

  it('keeps the "no remote chat is watching" footer when every grant reaches zero chats', async () => {
    const h = harness({ thumbnails: 4, chats: 0 });
    const result = String(await h.run());
    expect(h.sinkCalls()).toBe(4);
    expect(result).toContain('No remote chat is watching this turn');
    expect(result).not.toContain('Sent ');
    // The grant is still spent: an unwatched search must not farm slots.
    expect(h.remaining()).toBe(1);
    expect(h.sidebarPaths(result)).toHaveLength(4);
  });

  it('counts only photos accepted by a chat when sink results are mixed', async () => {
    const h = harness({ thumbnails: 4, chats: [0, 1, 0, 1] });
    const result = String(await h.run());
    expect(h.sinkCalls()).toBe(4);
    expect(h.remaining()).toBe(1);
    expect(result).toContain('Sent 2 thumbnail(s) to 1 remote chat(s).');
    expect(result).toContain('2 of 4 thumbnail(s) were not queued to a phone');
    expect(h.sidebarPaths(result)).toHaveLength(4);
  });

  it('never exceeds five queued photos across repeated searches, then refills at reset', async () => {
    const h = harness({ thumbnails: 4 });
    const first = String(await h.run());
    const second = String(await h.run());
    expect(h.sinkCalls()).toBe(FILE_DELIVERY_TURN_LIMIT);
    expect(first).toContain('Sent 4 thumbnail(s) to 1 remote chat(s).');
    expect(second).toContain('Sent 1 thumbnail(s) to 1 remote chat(s).');
    expect(second).toContain(
      `3 of 4 thumbnail(s) were not queued to a phone. All 4 are saved under ${FOLDER}`,
    );
    expect(h.remaining()).toBe(0);
    h.service?.resetTurn('c1');
    const third = String(await h.run());
    expect(third).toContain('Sent 4 thumbnail(s) to 1 remote chat(s).');
    expect(h.sinkCalls()).toBe(FILE_DELIVERY_TURN_LIMIT + 4);
  });

  it('stops sending when the turn is cancelled mid-delivery, without refunding or replaying', async () => {
    const h = harness({ thumbnails: 4, abortAfterSends: 1 });
    const result = String(await h.run());
    expect(h.sinkCalls()).toBe(1);
    expect(result).toContain('Sent 1 thumbnail(s) to 1 remote chat(s).');
    expect(result).toContain(
      `3 of 4 thumbnail(s) were not queued to a phone — the search was cancelled. All 4 are saved under ${FOLDER}`,
    );
    expect(h.remaining()).toBe(1);
  });

  it('reports a stale lease as unsent instead of claiming a send after resetTurn', async () => {
    const h = harness({ thumbnails: 4, resetAfterSends: 1 });
    const result = String(await h.run());
    expect(h.sinkCalls()).toBe(1);
    expect(result).toContain(
      '3 of 4 thumbnail(s) were not queued to a phone — this turn ended and its delivery budget was reset.',
    );
    expect(result).not.toContain('Sent 4');
    // A reset reopens the budget, yet the stale lease must not spend it.
    expect(h.remaining()).toBe(FILE_DELIVERY_TURN_LIMIT);
  });

  it('charges nothing when the download is aborted, and lets the turn end on the abort', async () => {
    const h = harness({ thumbnails: 4, abortDuringDownload: true });
    await expect(h.run()).rejects.toThrow(/aborted/i);
    expect(h.sinkCalls()).toBe(0);
    expect(h.remaining()).toBe(FILE_DELIVERY_TURN_LIMIT);
  });

  it('does not reserve or download when thumbnails are off, or with no notification service', async () => {
    const off = harness({ thumbnails: 0 });
    const offResult = String(await off.run());
    expect(off.download).not.toHaveBeenCalled();
    expect(off.remaining()).toBe(FILE_DELIVERY_TURN_LIMIT);
    expect(offResult).not.toContain(IMAGE_SEARCH_THUMBNAILS_PREFIX);

    const bare = harness({ thumbnails: 3, noNotifications: true });
    const bareResult = String(await bare.run());
    expect(bare.sinkCalls()).toBe(0);
    expect(bareResult).toContain(IMAGE_SEARCH_THUMBNAILS_PREFIX);
    expect(bareResult).not.toContain('Sent ');
    expect(bareResult).not.toContain('No remote chat');
    expect(bare.sidebarPaths(bareResult)).toHaveLength(3);
  });

  it('shares one budget with the other senders: 2 renders + 1 send_file + a 2-photo search fill 5', async () => {
    // The other senders go through their real call (deliverFile), so this is
    // the shared-counter invariant, not a mock of it.
    const h = harness({ thumbnails: 2, spent: 0 });
    for (let i = 0; i < 3; i += 1) {
      const result = await h.service!.deliverFile({
        conversationId: 'c1',
        text: `sender ${i + 1}`,
        imagePath: `/ws/out/${i + 1}.png`,
      });
      expect(result.kind).toBe('queued');
    }
    const result = String(await h.run());
    expect(result).toContain('Sent 2 thumbnail(s) to 1 remote chat(s).');
    expect(h.remaining()).toBe(0);
    const sixth = await h.service!.deliverFile({
      conversationId: 'c1',
      text: 'sixth',
      imagePath: '/ws/out/6.png',
    });
    expect(sixth.kind).toBe('refused');
    // Each queued photo was attempted exactly once.
    expect(h.sinkCalls()).toBe(5);
  });

  it('skips upload approval for a public URL yet still budgets the thumbnails', async () => {
    const h = harness({ thumbnails: 4 });
    expect(h.tool.approval?.({ image_url: 'https://example.com/input.jpg' })).toBeUndefined();
    await h.run();
    expect(h.remaining()).toBe(1);
  });
});
