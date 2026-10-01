import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined },
  commands: { executeCommand: vi.fn() },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  ViewColumn: { Beside: -2 },
  window: {
    createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }),
  },
}));

import type { ForgeConfig, ImageGenerationConfig } from '../../src/config/types';
import { ImageGenerationConfigSchema } from '../../src/config/imageGenerationSchema';
import type { SdServerBackend } from '../../src/backend/SdServerBackend';
import {
  backendCostTag,
  makeGenerateImageTool,
  pickBackend,
  targetPath,
} from '../../src/tools/imageGeneration/generateImageTool';
import { generateCloudImage } from '../../src/tools/imageGeneration/cloudImageBackend';
import { SDCPP_SIZE_NAMES, type SdcppImageRequest } from '../../src/tools/imageGeneration/sdcppImageBackend';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let root: string;

function imageConfig(overrides: Record<string, unknown> = {}): ImageGenerationConfig {
  return ImageGenerationConfigSchema.parse({
    backends: [
      {
        name: 'grok-imagine',
        provider: 'xai',
        model: 'grok-imagine-image-2.0',
        api_key_secret: 'xai',
      },
      {
        name: 'other-api',
        provider: 'openai-compatible',
        model: 'img',
        endpoint: 'https://images.example.com/v1',
        api_key_secret: 'other',
        confirm_each: false,
      },
    ],
    ...overrides,
  }) as ImageGenerationConfig;
}

function makeTool(
  config: ImageGenerationConfig | undefined,
  notifications: UserNotificationService,
  generate = vi.fn(async () => ({ bytes: JPEG, mime: 'image/jpeg' })),
) {
  const tool = makeGenerateImageTool({
    getConfig: () => ({ image_generation: config }) as unknown as ForgeConfig,
    secrets: undefined,
    notifications,
    generate,
    reveal: async () => undefined,
    now: () => new Date('2026-09-14T10:20:30Z'),
  });
  return { tool, generate };
}

function rig(config: ImageGenerationConfig | undefined = imageConfig()) {
  const notifications = new UserNotificationService();
  const delivered: Array<{ conversationId?: string; text: string; imagePath?: string }> = [];
  notifications.addSink(async (event) => {
    delivered.push(event);
    return event.imagePath ? 1 : 0;
  });
  return { ...makeTool(config, notifications), delivered };
}

const noSnapshot = { beforeMutate: (): void => undefined };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-generate-image-'));
  (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: { fsPath: root } },
  ];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('image_generation config schema', () => {
  it('defaults confirm_each on and the output folder', () => {
    const config = imageConfig();
    expect(config.backends[0]?.confirm_each).toBe(true);
    expect(config.output_dir).toBe('generated-images');
  });

  it('rejects an openai-compatible backend without an endpoint', () => {
    const result = ImageGenerationConfigSchema.safeParse({
      backends: [{ name: 'x', provider: 'openai-compatible', model: 'm', api_key_secret: 'k' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a keyless non-xai backend, duplicate names, and an unknown default', () => {
    const parse = (value: unknown): boolean => ImageGenerationConfigSchema.safeParse(value).success;
    expect(parse({ backends: [{ name: 'o', provider: 'openai', model: 'gpt-image-1' }] })).toBe(
      false,
    );
    expect(
      parse({
        backends: [
          { name: 'a', provider: 'xai', model: 'm' },
          { name: 'a', provider: 'xai', model: 'n' },
        ],
      }),
    ).toBe(false);
    expect(
      parse({ default: 'missing', backends: [{ name: 'a', provider: 'xai', model: 'm' }] }),
    ).toBe(false);
  });
});

describe('generate_image', () => {
  it('is not advertised without an image_generation block', () => {
    expect(makeTool(undefined, new UserNotificationService()).tool.advertise?.()).toBe(false);
    expect(rig().tool.advertise?.()).toBe(true);
  });

  it('advertises the configured backends as an enum', () => {
    const described = rig().tool.describe?.();
    const properties = described?.function.parameters['properties'] as Record<
      string,
      { enum?: string[]; description?: string }
    >;
    expect(properties['backend']?.enum).toEqual(['grok-imagine', 'other-api']);
    expect(properties['backend']?.description).toContain('default (grok-imagine)');
  });

  it('forces a dangerous confirmation for a billed backend but not for an opted-out one', () => {
    const { tool } = rig();
    expect(tool.approval?.({ prompt: 'a fox' })).toMatchObject({ dangerous: true });
    expect(tool.approval?.({ prompt: 'a fox' })?.detail).toContain('billed per image');
    expect(tool.approval?.({ prompt: 'a fox', backend: 'other-api' })).toMatchObject({
      dangerous: false,
    });
  });

  it('saves with the returned format, snapshots before writing, and delivers remotely', async () => {
    const { tool, generate, delivered } = rig();
    const seenBeforeWrite: boolean[] = [];
    const beforeMutate = vi.fn((paths: string[]) => {
      seenBeforeWrite.push(fs.existsSync(paths[0] ?? ''));
    });

    const result = await tool.handler(
      { prompt: 'a red fox', path: 'art/fox.png' },
      { beforeMutate, conversationId: 'c1' },
    );

    const saved = path.join(root, 'art', 'fox.jpg');
    expect(fs.readFileSync(saved)).toEqual(JPEG);
    expect(beforeMutate).toHaveBeenCalledWith([saved]);
    expect(seenBeforeWrite).toEqual([false]);
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'a red fox',
        backend: expect.objectContaining({ name: 'grok-imagine' }),
      }),
    );
    expect(delivered).toEqual([
      { conversationId: 'c1', text: '🖼 grok-imagine (paid xai API): a red fox', imagePath: saved },
    ]);
    expect(result).toContain('This was a paid xai API call, billed per image.');
    expect(result).toContain('art/fox.jpg');
    expect(result).toContain('Sent to 1 remote chat(s).');
    expect(result).toContain('view_image');
  });

  it('says so when no chat is watching the turn', async () => {
    const { tool } = makeTool(
      imageConfig(),
      new UserNotificationService(),
      vi.fn(async () => ({ bytes: PNG, mime: 'image/png' })),
    );
    const result = await tool.handler({ prompt: 'x' }, noSnapshot);
    expect(result).toContain('No remote chat is watching this turn');
  });

  it('refuses an unknown backend and an empty prompt without calling the provider', async () => {
    const { tool, generate } = rig();
    await expect(tool.handler({ prompt: 'x', backend: 'nope' }, noSnapshot)).rejects.toThrow(
      /unknown backend "nope". Configured: grok-imagine, other-api/,
    );
    await expect(tool.handler({ prompt: '   ' }, noSnapshot)).rejects.toThrow(
      /prompt must be a non-empty string/,
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it('names default files from the time and a prompt slug under output_dir', () => {
    const config = imageConfig({ output_dir: 'out\\images' });
    const image = { bytes: PNG, mime: 'image/png' };
    const at = new Date('2026-09-14T10:20:30Z');
    expect(targetPath(config, undefined, 'A Red Fox, at dawn!', image, at)).toBe(
      'out/images/20260914-102030-a-red-fox-at-dawn.png',
    );
    expect(pickBackend(config, undefined)?.name).toBe('grok-imagine');
    expect(pickBackend(imageConfig({ default: 'other-api' }), undefined)?.name).toBe('other-api');
  });
});

describe('generateCloudImage', () => {
  const secrets = { get: async () => 'plain-api-key' } as unknown as vscode.SecretStorage;
  const backends = imageConfig().backends;
  const xai = backends[0]!;
  const custom = backends[1]!;

  it('downloads a URL response right away and sniffs the format', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith('/v1/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://imgen.x.ai/tmp/a.jpeg' }] }));
      }
      return new Response(JPEG);
    }) as unknown as typeof fetch;

    const image = await generateCloudImage({ backend: xai, prompt: 'fox', secrets, fetchImpl });

    expect(image.mime).toBe('image/jpeg');
    expect(calls).toEqual([
      'https://api.x.ai/v1/images/generations',
      'https://imgen.x.ai/tmp/a.jpeg',
    ]);
  });

  it('accepts a base64 response from a custom endpoint', async () => {
    let body: unknown;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      const data = [{ b64_json: PNG.toString('base64'), revised_prompt: 'a fox, detailed' }];
      return new Response(JSON.stringify({ data }));
    }) as unknown as typeof fetch;

    const image = await generateCloudImage({ backend: custom, prompt: 'fox', secrets, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://images.example.com/v1/images/generations',
      expect.anything(),
    );
    expect(body).toEqual({ model: 'img', prompt: 'fox', n: 1 });
    expect(image).toMatchObject({ mime: 'image/png', revisedPrompt: 'a fox, detailed' });
  });

  it('turns a credential rejection into the login fix', async () => {
    const fetchImpl = (async () =>
      new Response('bad credentials', { status: 401 })) as unknown as typeof fetch;
    await expect(
      generateCloudImage({ backend: xai, prompt: 'fox', secrets, fetchImpl }),
    ).rejects.toThrow(/opencode auth login/);
  });

  it('refuses bytes that are not an image, and a non-https image URL', async () => {
    const html = Buffer.from('<html>').toString('base64');
    const notImage = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: html }] }))) as unknown as typeof fetch;
    await expect(
      generateCloudImage({ backend: xai, prompt: 'fox', secrets, fetchImpl: notImage }),
    ).rejects.toThrow(/not a PNG, JPEG/);

    const plainHttp = (async () =>
      new Response(
        JSON.stringify({ data: [{ url: 'http://127.0.0.1/a.png' }] }),
      )) as unknown as typeof fetch;
    await expect(
      generateCloudImage({ backend: xai, prompt: 'fox', secrets, fetchImpl: plainHttp }),
    ).rejects.toThrow(/not https/);
  });
});

describe('generate_image with an sdcpp backend', () => {
  const LOCAL = {
    name: 'qwen-local',
    provider: 'sdcpp',
    binary: 'V:/Tools/sd.cpp/sd-server.exe',
    diffusion_model: 'V:/models/Qwen-Image-2.1/qwen_image_2.1-Q4_K.gguf',
    text_encoder: 'V:/models/Qwen-Image-2.1/Qwen3VL-8B-Instruct-Q4_K_M.gguf',
    vae: 'V:/models/Qwen-Image-2.1/qwen_image_2.1_vae_bf16.safetensors',
    cuda_device: 2,
    text_encoder_on_cpu: true,
    port: 8093,
    min_free_vram_mb: 7000,
    idle_timeout_ms: 600_000,
    request_timeout_ms: 300_000,
    defaults: { steps: 20, cfg_scale: 6, sampler: 'euler', width: 1024, height: 1024 },
    extra_args: [],
    confirm_on_start: true,
    confirm_each: false,
  };

  function localConfig(): ImageGenerationConfig {
    return imageConfig({
      default: 'qwen-local',
      backends: [LOCAL, { name: 'grok-imagine', provider: 'xai', model: 'grok-imagine-image-2.0', api_key_secret: 'xai' }],
    }) as ImageGenerationConfig;
  }

  function localRig(options: { startDetail?: string; withServer?: boolean } = {}) {
    const startApproval = vi.fn(() =>
      options.startDetail ? { detail: options.startDetail } : undefined,
    );
    const server = { startApproval, baseUrl: () => 'http://127.0.0.1:8093' } as unknown as SdServerBackend;
    const servers = new Map<string, SdServerBackend>(
      options.withServer === false ? [] : [[LOCAL.name, server]],
    );
    const generate = vi.fn(async () => ({ bytes: JPEG, mime: 'image/jpeg' }));
    const generateLocal = vi.fn(async (_request: SdcppImageRequest) => ({
      bytes: PNG,
      mime: 'image/png',
      seed: 1111,
      width: 1024,
      height: 1024,
    }));
    const tool = makeGenerateImageTool({
      getConfig: () => ({ image_generation: localConfig() }) as unknown as ForgeConfig,
      secrets: undefined,
      notifications: new UserNotificationService(),
      sdServers: () => servers,
      generate,
      generateLocal,
      reveal: async () => undefined,
      now: () => new Date('2026-09-14T10:20:30Z'),
    });
    return { tool, generate, generateLocal, startApproval };
  }

  it('dispatches on provider, passing the live server handle and the size', async () => {
    const { tool, generate, generateLocal } = localRig();
    const result = await tool.handler(
      { prompt: 'a red fox', size: 'portrait' },
      { beforeMutate: () => undefined },
    );
    expect(generate).not.toHaveBeenCalled();
    const request = generateLocal.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      backend: { name: 'qwen-local', provider: 'sdcpp' },
      prompt: 'a red fox',
      size: 'portrait',
      alternatives: ['grok-imagine'],
    });
    expect(request.server.baseUrl()).toBe('http://127.0.0.1:8093');
    const saved = path.join(root, 'generated-images', '20260914-102030-a-red-fox.png');
    expect(fs.readFileSync(saved)).toEqual(PNG);
    expect(result).toContain('Rendered locally at 1024x1024, seed 1111.');
    expect(result).not.toContain('paid');
  });

  it('refuses when this window built no server, naming the fix and the alternative', async () => {
    const { tool, generateLocal } = localRig({ withServer: false });
    await expect(tool.handler({ prompt: 'fox' }, noSnapshot)).rejects.toThrow(
      /built no sd-server for image_generation\.backends\.qwen-local.*backend grok-imagine/,
    );
    // The fix differs by OS: sdcpp ownership needs Windows process identity.
    await expect(tool.handler({ prompt: 'fox' }, noSnapshot)).rejects.toThrow(
      process.platform === 'win32' ? /Reload the window/ : /sdcpp backends need Windows/,
    );
    expect(generateLocal).not.toHaveBeenCalled();
  });

  it('asks a dangerous confirmation for a billed backend and a plain one for a warm local backend', () => {
    const { tool, startApproval } = localRig();
    expect(tool.approval?.({ prompt: 'a fox' })).toMatchObject({ dangerous: false });
    expect(tool.approval?.({ prompt: 'a fox' })?.detail).toContain(
      'local · free · sdcpp · qwen_image_2.1-Q4_K',
    );
    expect(tool.approval?.({ prompt: 'a fox' })?.detail).not.toContain('billed per image');
    expect(tool.approval?.({ prompt: 'a fox', backend: 'grok-imagine' })).toMatchObject({
      dangerous: true,
    });
    expect(startApproval).toHaveBeenCalled();
  });

  it('adds the start approval only when a spawn is needed', () => {
    const cold = localRig({ startDetail: 'Start qwen-local (qwen_image_2.1-Q4_K.gguf) on CUDA device 2' });
    const coldApproval = cold.tool.approval?.({ prompt: 'a fox' });
    expect(coldApproval?.detail).toContain(
      'Start qwen-local (qwen_image_2.1-Q4_K.gguf) on CUDA device 2',
    );
    // confirm_each is false for the local backend, so only the start makes it ask.
    expect(coldApproval).toMatchObject({ dangerous: true });
    const warm = localRig();
    expect(warm.tool.approval?.({ prompt: 'a fox' })?.detail).not.toContain('Start qwen-local');
    expect(warm.tool.approval?.({ prompt: 'a fox' })).toMatchObject({ dangerous: false });
  });

  it('lists backends with cost tags and never an undefined model', () => {
    const described = localRig().tool.describe?.();
    const backend = (described?.function.parameters['properties'] as Record<
      string,
      { enum?: string[]; description?: string }
    >)['backend'];
    expect(backend?.enum).toEqual(['qwen-local', 'grok-imagine']);
    expect(backend?.description).toContain('qwen-local (local · free · sdcpp · qwen_image_2.1-Q4_K)');
    expect(backend?.description).toContain(
      'grok-imagine (cloud · billed per image · xai · grok-imagine-image-2.0)',
    );
    expect(backend?.description).not.toContain('undefined');
  });

  it('offers the size enum, and says when a cloud backend ignored it', async () => {
    const described = localRig().tool.describe?.();
    const size = (described?.function.parameters['properties'] as Record<
      string,
      { enum?: string[] }
    >)['size'];
    // The definition inlines the literals for scripts/tool-audit-catalog.mjs;
    // this is what keeps them from drifting away from the request mapping.
    expect(size?.enum).toEqual([...SDCPP_SIZE_NAMES]);

    const { tool, generateLocal } = localRig();
    const cloud = await tool.handler(
      { prompt: 'fox', backend: 'grok-imagine', size: 'square' },
      noSnapshot,
    );
    expect(generateLocal).not.toHaveBeenCalled();
    expect(cloud).toContain('The size argument applies to local backends only');
  });

  it('tags each backend by provider alone', () => {
    const [local, cloud] = localConfig().backends;
    expect(backendCostTag(local!)).toBe('local · free · sdcpp · qwen_image_2.1-Q4_K');
    expect(backendCostTag(cloud!)).toBe(
      'cloud · billed per image · xai · grok-imagine-image-2.0',
    );
  });

  it('says the description no longer promises an approval for every call', () => {
    const description = makeGenerateImageTool({
      getConfig: () => ({ image_generation: localConfig() }) as unknown as ForgeConfig,
      secrets: undefined,
      notifications: new UserNotificationService(),
    }).definition.function.description!;
    expect(description).toContain('Cloud backends ask for approval and bill per image; local backends are free');
    expect(description).not.toContain('Each call asks the user to approve it');
  });
});
