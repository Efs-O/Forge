import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { ImageSearchConfigSchema } from '../../src/config/imageSearchSchema';
import type { ForgeConfig, ImageSearchConfig } from '../../src/config/types';
import type { ChatMessage } from '../../src/llm/types';
import { makeImageSearchTool, pickSource } from '../../src/tools/imageSearch/imageSearchTool';
import { uploadTemporaryImage } from '../../src/tools/imageSearch/litterboxUpload';
import {
  downloadThumbnails,
  isThumbnailHost,
  pickThumbnails,
  type ThumbnailCandidate,
} from '../../src/tools/imageSearch/imageThumbnails';
import {
  formatYandexResults,
  yandexThumbnailCandidates,
} from '../../src/tools/imageSearch/yandexImages';
import {
  IMAGE_SEARCH_THUMBNAILS_PREFIX,
  imageSearchThumbnails,
} from '../../src/sidebar/toolResultView';
import type { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatLensResults,
  MAX_RESULT_CHARS,
  lensThumbnailCandidates,
  searchLens,
} from '../../src/tools/imageSearch/serpApiLens';

/** Shapes copied from the live 2026-09-15 SerpApi yandex_images response. */
const YANDEX = {
  image_tags: [{ text: 'eiffel tower paris' }, { text: 'torre eiffel' }],
  image_sizes: {
    large: [{ size: '2900×5367', link: 'https://blogger.googleusercontent.com/big.jpg' }],
  },
  image_results: [
    {
      title: 'Pin em EU trip',
      source: 'au.pinterest.com',
      link: 'https://au.pinterest.com/pin/1/',
      thumbnail: { link: 'https://avatars.mds.yandex.net/i?id=abc-images-thumbs&n=13&w=296&h=180' },
      original_image: { link: 'https://i.pinimg.com/474x/e6.jpg' },
    },
  ],
  similar_images: [
    {
      image: { link: 'https://avatars.mds.yandex.net/i?id=def-images-thumbs&n=13' },
      link: 'https://yandex.com/images/search?url=x',
    },
  ],
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const HTML = new TextEncoder().encode('<!doctype html><html>');

/** Shapes copied from the live 2026-09-15 SerpApi responses. */
const EXACT = {
  search_metadata: { status: 'Success' },
  exact_matches: [
    {
      position: 1,
      title: 'Eiffel Tower - Wikipedia',
      source: 'Wikipedia',
      link: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
      thumbnail: 'https://serpapi.com/searches/x/images/y',
      actual_image_width: 330,
      actual_image_height: 550,
    },
    {
      position: 2,
      title: 'Vintage Eiffel Tower on Stone Base',
      source: 'eBay',
      link: 'https://www.ebay.com/itm/1',
      price: '$28.00',
      extracted_price: 28,
    },
    {
      position: 3,
      title: 'When the Eiffel Tower was first proposed',
      source: 'Instagram',
      link: 'https://www.instagram.com/reel/1/',
      date: 'Feb 21, 2026',
    },
  ],
};

function config(overrides: Partial<ImageSearchConfig> = {}): ImageSearchConfig {
  const parsed = ImageSearchConfigSchema.parse({
    provider: 'serpapi_lens',
    secret_key_name: 'serpapi',
    ...overrides,
  });
  if (!parsed) throw new Error('schema returned undefined');
  return parsed;
}

function user(attachments: { name: string; mediaType: string }[], text = 'find this'): ChatMessage {
  return {
    role: 'user',
    content: text,
    attachments: attachments.map((a) => ({ ...a, bytes: 6, relativePath: `conv/${a.name}` })),
  };
}

function makeTool(
  options: {
    cfg?: ImageSearchConfig | undefined;
    key?: string;
    bytes?: Uint8Array;
    workspace?: string | undefined;
    reached?: number;
  } = {},
) {
  const cfg = 'cfg' in options ? options.cfg : config();
  const upload = vi.fn(async () => 'https://litter.catbox.moe/abc.jpg');
  const search = vi.fn(async () => EXACT);
  const yandex = vi.fn(async () => YANDEX);
  const readFile = vi.fn(async () => options.bytes ?? JPEG);
  const download = vi.fn(async (thumbnails: readonly ThumbnailCandidate[]) => ({
    saved: thumbnails.map((thumbnail, index) => ({
      ...thumbnail,
      relativePath: `.forge/image-search/0/${index + 1}.jpg`,
      absolutePath: `/ws/.forge/image-search/0/${index + 1}.jpg`,
    })),
    failures: [] as string[],
  }));
  const deliverImage = vi.fn(async () => options.reached ?? 0);
  let clock = 0;
  const tool = makeImageSearchTool({
    getConfig: () => ({ ...(cfg ? { image_search: cfg } : {}) }) as ForgeConfig,
    secrets: {
      get: async () => ('key' in options ? options.key : 'serp-key'),
    } as unknown as vscode.SecretStorage,
    resolveAttachment: (relativePath) => `/store/${relativePath}`,
    notifications: { deliverImage } as unknown as UserNotificationService,
    upload,
    searchLens: search,
    searchYandex: yandex,
    readFile,
    downloadThumbnails: download,
    workspaceRoot: () => ('workspace' in options ? options.workspace : '/ws'),
    now: () => clock,
  });
  return {
    tool,
    upload,
    search,
    yandex,
    readFile,
    download,
    deliverImage,
    advance: (ms: number) => (clock += ms),
  };
}

const messages = [
  user([{ name: 'old.png', mediaType: 'image/png' }]),
  { role: 'assistant', content: 'ok' } as ChatMessage,
  user([
    { name: 'notes.pdf', mediaType: 'application/pdf' },
    { name: 'new.jpg', mediaType: 'image/jpeg' },
  ]),
];

describe('ImageSearchConfigSchema', () => {
  it('fills the documented defaults: gate off, 8 results, 90 s', () => {
    expect(config()).toEqual({
      provider: 'serpapi_lens',
      secret_key_name: 'serpapi',
      max_results: 8,
      confirm_upload: false,
      thumbnails: 4,
      timeout_ms: 90_000,
    });
  });
});

describe('pickSource', () => {
  it('defaults to the newest attached image, skipping non-images', () => {
    expect(pickSource({}, messages)).toMatchObject({ kind: 'attachment', ref: 'conv/new.jpg' });
    expect(pickSource({ attachment_index: 2 }, messages)).toMatchObject({ ref: 'conv/old.png' });
  });

  it('names the range when the index is too large', () => {
    expect(() => pickSource({ attachment_index: 3 }, messages)).toThrow(/has 2 attached image/);
  });

  it('points at the alternatives when nothing is attached', () => {
    expect(() => pickSource({}, [])).toThrow(/Ask the user to attach one, or pass image_url/);
  });

  it('refuses both sources at once and non-http URLs', () => {
    expect(() =>
      pickSource({ image_url: 'https://x/a.jpg', attachment_index: 1 }, messages),
    ).toThrow(/not both/);
    expect(() => pickSource({ image_url: 'file:///C:/a.jpg' }, messages)).toThrow(/http\(s\)/);
  });
});

describe('image_search tool', () => {
  it('is advertised only when config.yaml has an image_search block', () => {
    expect(makeTool().tool.advertise?.()).toBe(true);
    expect(makeTool({ cfg: undefined }).tool.advertise?.()).toBe(false);
  });

  it('uploads the attachment, searches, and returns trimmed text', async () => {
    const { tool, upload, search, readFile } = makeTool();
    const result = await tool.handler(
      { type: 'exact_matches' },
      { beforeMutate: () => undefined, conversationMessages: messages },
    );
    expect(readFile).toHaveBeenCalledWith('/store/conv/new.jpg');
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ mime: 'image/jpeg', filename: 'new.jpg' }),
    );
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: 'https://litter.catbox.moe/abc.jpg',
        type: 'exact_matches',
        apiKey: 'serp-key',
      }),
    );
    expect(result).toContain('Exact matches (same image): 3 found');
    expect(result).not.toContain('serpapi.com/searches');
  });

  it('reuses an upload inside 50 minutes and re-uploads after', async () => {
    const { tool, upload, advance } = makeTool();
    const context = { beforeMutate: () => undefined, conversationMessages: messages };
    await tool.handler({}, context);
    advance(49 * 60 * 1000);
    await tool.handler({ type: 'visual_matches' }, context);
    expect(upload).toHaveBeenCalledTimes(1);
    advance(2 * 60 * 1000);
    await tool.handler({}, context);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('never uploads a public URL', async () => {
    const { tool, upload, search } = makeTool();
    await tool.handler(
      { image_url: 'https://example.com/a.jpg' },
      { beforeMutate: () => undefined },
    );
    expect(upload).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrl: 'https://example.com/a.jpg' }),
    );
  });

  it('refuses bytes that are not an image before anything is sent', async () => {
    const { tool, upload } = makeTool({ bytes: HTML });
    await expect(
      tool.handler({}, { beforeMutate: () => undefined, conversationMessages: messages }),
    ).rejects.toThrow(/not a PNG, JPEG/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('names the command when the key is missing', async () => {
    const { tool, upload } = makeTool({ key: undefined as unknown as string });
    await expect(
      tool.handler({}, { beforeMutate: () => undefined, conversationMessages: messages }),
    ).rejects.toThrow(/Set Cloud Provider Token/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('gates only local uploads, and only when confirm_upload is on', () => {
    expect(makeTool().tool.approval?.({})).toBeUndefined();
    const gated = makeTool({ cfg: config({ confirm_upload: true }) }).tool;
    expect(gated.approval?.({})).toMatchObject({ dangerous: false });
    expect(gated.approval?.({ image_url: 'https://example.com/a.jpg' })).toBeUndefined();
  });
});

describe('formatLensResults', () => {
  it('keeps title, source, link, size, price and date; drops thumbnails', () => {
    const text = formatLensResults(EXACT, 'exact_matches', 8);
    expect(text).toContain(
      '1. Eiffel Tower - Wikipedia — Wikipedia — <https://en.wikipedia.org/wiki/Eiffel_Tower> — 330x550',
    );
    expect(text).toContain('— $28.00');
    expect(text).toContain('— Feb 21, 2026');
    expect(text).not.toContain('thumbnail');
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

  it('says so when nothing matched', () => {
    expect(formatLensResults({ search_metadata: {} }, 'exact_matches', 8)).toMatch(
      /found no matches/,
    );
  });
});

describe('HTTP clients', () => {
  it('searchLens surfaces SerpApi error text verbatim', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Your account has run out of searches.' }), {
          status: 429,
        }),
    );
    await expect(
      searchLens({ imageUrl: 'https://a/b.jpg', type: 'all', apiKey: 'k', fetchImpl }),
    ).rejects.toThrow('SerpApi: Your account has run out of searches.');
  });

  it('searchLens omits type for all and sends it otherwise', async () => {
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
      uploadTemporaryImage({ bytes: JPEG, filename: 'a.jpg', mime: 'image/jpeg', fetchImpl: ok }),
    ).resolves.toBe('https://litter.catbox.moe/q1w2e3.jpg');
    const bad = vi.fn(async () => new Response('<html>busy</html>'));
    await expect(
      uploadTemporaryImage({ bytes: JPEG, filename: 'a.jpg', mime: 'image/jpeg', fetchImpl: bad }),
    ).rejects.toThrow(/no file URL/);
  });
});

describe('thumbnails', () => {
  const context = {
    beforeMutate: () => undefined,
    conversationMessages: messages,
    conversationId: 'c1',
  };

  it('lists saved thumbnails in the parseable line and says when no phone watches', async () => {
    const { tool, download, deliverImage } = makeTool();
    const result = String(await tool.handler({}, context));
    expect(download).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          url: 'https://serpapi.com/searches/x/images/y',
          title: 'Eiffel Tower - Wikipedia',
        }),
      ],
      '/ws',
      expect.objectContaining({ stamp: 0 }),
    );
    expect(imageSearchThumbnails('image_search', result)).toEqual([
      {
        path: '.forge/image-search/0/1.jpg',
        original: 'https://en.wikipedia.org/wiki/Eiffel_Tower',
      },
    ]);
    expect(deliverImage).toHaveBeenCalledWith({
      conversationId: 'c1',
      text: '🔎 1/1 Eiffel Tower - Wikipedia — Wikipedia\nhttps://en.wikipedia.org/wiki/Eiffel_Tower',
      imagePath: '/ws/.forge/image-search/0/1.jpg',
    });
    expect(result).toContain('No remote chat is watching this turn');
  });

  it('reports a phone delivery only when a remote chat took it', async () => {
    const { tool } = makeTool({ reached: 1 });
    expect(String(await tool.handler({}, context))).toContain(
      'Sent 1 thumbnail(s) to 1 remote chat(s).',
    );
  });

  it('skips thumbnails when configured to 0 or no workspace is open', async () => {
    const off = makeTool({ cfg: config({ thumbnails: 0 }) });
    expect(String(await off.tool.handler({}, context))).not.toContain(
      IMAGE_SEARCH_THUMBNAILS_PREFIX,
    );
    expect(off.download).not.toHaveBeenCalled();
    const noWorkspace = makeTool({ workspace: undefined });
    expect(String(await noWorkspace.tool.handler({}, context))).toContain(
      'no workspace folder is open',
    );
  });

  it('picks only SerpApi and Google thumbnail hosts, in result order, up to the limit', () => {
    const data = {
      exact_matches: [{ title: 'evil', thumbnail: 'https://tracker.example/x.jpg' }],
      visual_matches: [
        { title: 'a', thumbnail: 'https://encrypted-tbn2.gstatic.com/images?q=a' },
        { title: 'b', thumbnail: 'http://serpapi.com/insecure.jpg' },
        { title: 'c', thumbnail: 'https://serpapi.com/searches/1/images/c.jpeg' },
        { title: 'd', thumbnail: 'https://serpapi.com/searches/1/images/d.jpeg' },
      ],
    };
    expect(pickThumbnails(lensThumbnailCandidates(data), 2).map((t) => t.title)).toEqual([
      'a',
      'c',
    ]);
    expect(isThumbnailHost('https://serpapi.com.evil.example/x')).toBe(false);
  });

  it('downloads into a per-search folder, refuses non-images, and prunes old searches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-lens-'));
    try {
      const old = path.join(root, '.forge', 'image-search', '1');
      fs.mkdirSync(old, { recursive: true });
      const stamp = 8 * 24 * 60 * 60 * 1000;
      const fetchImpl = vi.fn(async (url: string | URL | Request) =>
        String(url).endsWith('bad') ? new Response('<html>') : new Response(JPEG),
      );
      const result = await downloadThumbnails(
        [
          { url: 'https://serpapi.com/ok', title: 'ok', source: '', link: '' },
          { url: 'https://serpapi.com/bad', title: 'bad', source: '', link: '' },
        ],
        root,
        { stamp, fetchImpl },
      );
      expect(result.saved.map((t) => t.relativePath)).toEqual([
        `.forge/image-search/${stamp}/1.jpg`,
      ]);
      expect(result.failures).toEqual(['#2: not an image']);
      expect(fs.existsSync(result.saved[0]!.absolutePath)).toBe(true);
      expect(fs.existsSync(old)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('yandex engine', () => {
  const context = { beforeMutate: () => undefined, conversationMessages: messages };

  it('routes engine yandex to Yandex and leads with tags and the largest copies', async () => {
    const { tool, search, yandex, download } = makeTool();
    const result = String(await tool.handler({ engine: 'yandex' }, context));
    expect(search).not.toHaveBeenCalled();
    expect(yandex).toHaveBeenCalledWith(
      expect.objectContaining({
        imageUrl: 'https://litter.catbox.moe/abc.jpg',
        apiKey: 'serp-key',
      }),
    );
    expect(result.split('\n')[0]).toBe('Yandex identifies it as: eiffel tower paris; torre eiffel');
    expect(result).toContain('1. 2900×5367 — <https://blogger.googleusercontent.com/big.jpg>');
    expect(result).toContain('Pages with this image: 1 found');
    const picked = download.mock.calls[0]?.[0] ?? [];
    expect(picked.map((t) => t.url)).toEqual([
      'https://avatars.mds.yandex.net/i?id=abc-images-thumbs&n=13',
      'https://avatars.mds.yandex.net/i?id=def-images-thumbs&n=13',
    ]);
    expect(picked[0]?.original).toBe('https://i.pinimg.com/474x/e6.jpg');
  });

  it('refuses a Lens-only type with engine yandex, naming the fix', async () => {
    const { tool, upload } = makeTool();
    await expect(
      tool.handler({ engine: 'yandex', type: 'exact_matches' }, context),
    ).rejects.toThrow(/Drop type for engine yandex/);
    expect(upload).not.toHaveBeenCalled();
  });

  it('formats an empty Yandex response and allows only Yandex thumbnail hosts', () => {
    expect(formatYandexResults({}, 8)).toBe('Yandex found no matches for this image.');
    expect(isThumbnailHost('https://avatars.mds.yandex.net/i?id=1')).toBe(true);
    expect(isThumbnailHost('https://i.pinimg.com/474x/e6.jpg')).toBe(false);
    expect(yandexThumbnailCandidates({ image_results: [{ title: 'no thumb' }] })).toEqual([]);
  });

  it('prefers Lens match thumbnails over 92px organic ones, with the full image as original', () => {
    const candidates = lensThumbnailCandidates({
      organic_results: [{ title: 'org', thumbnail: 'https://encrypted-tbn0.gstatic.com/o' }],
      visual_matches: [
        {
          title: 'vis',
          thumbnail: 'https://encrypted-tbn2.gstatic.com/v',
          image: 'https://thumb.wikimedia.org/full.jpg',
          link: 'https://commons.wikimedia.org/page',
        },
      ],
    });
    expect(candidates.map((c) => c.title)).toEqual(['vis', 'org']);
    expect(candidates[0]?.original).toBe('https://thumb.wikimedia.org/full.jpg');
  });

  it('skips repeated thumbnails and strips Yandex tracking from links (live-run findings)', () => {
    const shared = 'https://avatars.mds.yandex.net/i?id=same-images-thumbs&n=13&w=296&h=180';
    const data = {
      image_results: [
        {
          title: 'p1',
          link: 'https://pinterest.com/a/?utm_medium=organic&utm_source=yandexsmartcamera',
          thumbnail: { link: shared },
        },
        { title: 'p2', link: 'https://pinterest.com/b/', thumbnail: { link: shared } },
        {
          title: 'p3',
          link: 'https://historydraft.com/x?id=7&utm_source=yandexsmartcamera',
          thumbnail: { link: 'https://avatars.mds.yandex.net/i?id=other&n=13' },
        },
      ],
    };
    const picked = pickThumbnails(yandexThumbnailCandidates(data), 4);
    expect(picked.map((c) => c.title)).toEqual(['p1', 'p3']);
    expect(picked[0]?.link).toBe('https://pinterest.com/a/');
    const text = formatYandexResults(data, 8);
    expect(text).toContain('<https://historydraft.com/x?id=7>');
    expect(text).not.toContain('utm_');
  });
});
