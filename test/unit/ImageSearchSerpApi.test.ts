import { describe, expect, it, vi } from 'vitest';
import { uploadTemporaryImage } from '../../src/tools/imageSearch/litterboxUpload';
import {
  formatLensResults,
  MAX_RESULT_CHARS,
  searchLens,
} from '../../src/tools/imageSearch/serpApiLens';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

async function rejectionMessage<T>(promise: Promise<T>): Promise<string> {
  return promise.then(
    () => '',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe('formatLensResults', () => {
  it('formats match details and omits thumbnails', () => {
    const text = formatLensResults(
      {
        exact_matches: [
          {
            title: 'Known match',
            source: 'Example',
            link: 'https://example.com/image',
            date: 'Jan 2, 2026',
            actual_image_width: 320,
            actual_image_height: 240,
            price: { value: '$12.00' },
            thumbnail: 'https://example.com/thumb.jpg',
          },
        ],
      },
      'exact_matches',
      8,
    );
    expect(text).toBe(
      'Exact matches (same image): 1 found, top 1 shown.\n' +
        '1. Known match — Example — <https://example.com/image> — Jan 2, 2026 — 320x240 — $12.00',
    );
  });

  it('leads with what Lens identified for type all', () => {
    const text = formatLensResults(
      {
        related_content: [{ query: 'Eiffel Tower' }],
        visual_matches: [{ title: 'A', link: 'https://a' }],
        short_videos: [{ title: 'ignored' }],
      },
      'all',
      8,
    );
    expect(text.split('\n')[0]).toBe('Google Lens identifies it as: Eiffel Tower');
    expect(text).toContain('Visually similar: 1 found');
    expect(text).not.toContain('ignored');
  });

  it('caps the model-facing text', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      title: 'x'.repeat(100),
      link: `https://e/${i}`,
    }));
    const text = formatLensResults({ visual_matches: many, organic_results: many }, 'all', 20);
    expect(text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 60);
  });

  it('formats an empty response with type-specific retry guidance', () => {
    expect(formatLensResults({ search_metadata: {} }, 'exact_matches', 8)).toBe(
      'Google Lens (exact_matches) found no matches for this image. SerpApi keeps this answer for about an hour, so the same call returns it again; try another type, or engine yandex.',
    );
  });

  it('formats a successful empty SerpApi answer without repeating its error', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            search_metadata: { status: 'Success' },
            error: "Google Lens hasn't returned any results for this query.",
          }),
          { status: 200 },
        ),
    );
    const data = await searchLens({
      imageUrl: 'https://a/b.jpg',
      type: 'visual_matches',
      apiKey: 'k',
      fetchImpl,
    });
    expect(data['error']).toBe("Google Lens hasn't returned any results for this query.");
    expect(formatLensResults(data, 'visual_matches', 8)).toBe(
      'Google Lens (visual_matches) found no matches for this image. SerpApi keeps this answer for about an hour, so the same call returns it again; try another type, or engine yandex.',
    );
  });

  it('keeps throwing SerpApi errors for an unauthorized key', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: 'Invalid API key.' }), { status: 401 }),
    );
    const message = await rejectionMessage(
      searchLens({ imageUrl: 'https://a/b.jpg', type: 'all', apiKey: 'k', fetchImpl }),
    );
    expect(message).toBe('SerpApi: Invalid API key.');
  });

  it('keeps throwing errors when SerpApi marks an HTTP 200 response as failed', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            search_metadata: { status: 'Error' },
            error: "Google Lens hasn't returned any results for this query.",
          }),
          { status: 200 },
        ),
    );
    const message = await rejectionMessage(
      searchLens({ imageUrl: 'https://a/b.jpg', type: 'all', apiKey: 'k', fetchImpl }),
    );
    expect(message).toBe("SerpApi: Google Lens hasn't returned any results for this query.");
  });

  it('leaves regular Lens matches unchanged', async () => {
    const body = {
      search_metadata: { status: 'Success' },
      exact_matches: [
        {
          title: 'Known match',
          source: 'Example',
          link: 'https://example.com/image',
          date: 'Jan 2, 2026',
          actual_image_width: 320,
          actual_image_height: 240,
          price: { value: '$12.00' },
        },
      ],
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    const data = await searchLens({
      imageUrl: 'https://a/b.jpg',
      type: 'exact_matches',
      apiKey: 'k',
      fetchImpl,
    });
    expect(formatLensResults(data, 'exact_matches', 8)).toBe(
      'Exact matches (same image): 1 found, top 1 shown.\n' +
        '1. Known match — Example — <https://example.com/image> — Jan 2, 2026 — 320x240 — $12.00',
    );
  });
});

describe('SerpApi HTTP client', () => {
  it('surfaces quota errors verbatim', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Your account has run out of searches.' }), {
          status: 429,
        }),
    );
    const message = await rejectionMessage(
      searchLens({ imageUrl: 'https://a/b.jpg', type: 'all', apiKey: 'k', fetchImpl }),
    );
    expect(message).toBe('SerpApi: Your account has run out of searches.');
  });

  it('omits type for all and sends it otherwise', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request) => new Response('{}', { status: 200 }),
    );
    await searchLens({ imageUrl: 'https://a/b.jpg', type: 'all', apiKey: 'k', fetchImpl });
    await searchLens({
      imageUrl: 'https://a/b.jpg',
      type: 'exact_matches',
      apiKey: 'k',
      fetchImpl,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain('type=');
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('type=exact_matches');
  });

  it('uploadTemporaryImage requires a Litterbox file URL back', async () => {
    const ok = vi.fn(async () => new Response('https://litter.catbox.moe/q1w2e3.jpg\n'));
    await expect(
      uploadTemporaryImage({
        bytes: JPEG,
        filename: 'a.jpg',
        mime: 'image/jpeg',
        fetchImpl: ok,
      }),
    ).resolves.toBe('https://litter.catbox.moe/q1w2e3.jpg');
    const bad = vi.fn(async () => new Response('<html>busy</html>'));
    await expect(
      uploadTemporaryImage({
        bytes: JPEG,
        filename: 'a.jpg',
        mime: 'image/jpeg',
        fetchImpl: bad,
      }),
    ).rejects.toThrow(/no file URL/);
  });
});
