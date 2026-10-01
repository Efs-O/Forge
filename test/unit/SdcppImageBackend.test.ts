import { describe, expect, it, vi } from 'vitest';
import type { SdcppImageBackendConfig } from '../../src/config/types';
import { ImageGenerationConfigSchema } from '../../src/config/imageGenerationSchema';
import type { GpuInfo } from '../../src/system/systemProbes';
import {
  generateSdcppImage,
  SDCPP_SIZES,
  sdcppSizeFor,
  type SdServerHandle,
} from '../../src/tools/imageGeneration/sdcppImageBackend';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sdcppConfig(overrides: Record<string, unknown> = {}): SdcppImageBackendConfig {
  const parsed = ImageGenerationConfigSchema.parse({
    backends: [
      {
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
        ...overrides,
      },
    ],
  });
  const backend = parsed.backends[0];
  if (!backend || backend.provider !== 'sdcpp') throw new Error('config did not parse as sdcpp.');
  return backend;
}

function gpu(index: number, usedMb: number | null, totalMb: number | null = 32768): GpuInfo {
  return {
    index,
    name: `RTX 5060 Ti ${index}`,
    memoryUsedMb: usedMb,
    memoryTotalMb: totalMb,
    utilizationPercent: 0,
    temperatureC: 40,
  };
}

/**
 * Stand-in for `SdServerBackend`: it keeps the contract the module is written
 * against (`withActivity` runs `beforeSpawn` exactly when a spawn is needed, and
 * `stopAfterAbort` implements the plan's cross-window rule) without a process, a
 * GPU or a port. `stopAfterAbort` counts its calls so the abort rule is asserted,
 * not just exercised.
 */
function fakeServer(options: { adopted?: boolean; spawnNeeded?: boolean } = {}) {
  let stopCalls = 0;
  const handle: SdServerHandle = {
    baseUrl: () => 'http://127.0.0.1:8093',
    withActivity: async (operation, startOptions) => {
      if (startOptions?.beforeSpawn && options.spawnNeeded !== false) {
        await startOptions.beforeSpawn();
      }
      return operation();
    },
    stopAfterAbort: async () => {
      stopCalls++;
      return options.adopted
        ? 'The sd-server on port 8093 belongs to another Forge window, so Forge left it running.'
        : 'Forge stopped its own sd-server, the only way to cancel a render, so the card is free again.';
    },
  };
  return { handle, stopCalls: () => stopCalls };
}

/** Rejects when the request's signal aborts, like undici does. */
async function rejectOnAbort(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new Error('The operation was aborted'));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

const enoughVram = async () => [gpu(2, 1000)];

describe('sdcpp size mapping', () => {
  it('maps the enum names to the plan pixels and falls back to the configured defaults', () => {
    const config = sdcppConfig({
      defaults: { steps: 20, cfg_scale: 6, sampler: 'euler', width: 512, height: 768 },
    });
    expect(sdcppSizeFor('square', config)).toEqual({ width: 1328, height: 1328 });
    expect(sdcppSizeFor('portrait', config)).toEqual({ width: 928, height: 1664 });
    expect(sdcppSizeFor('landscape', config)).toEqual({ width: 1664, height: 928 });
    expect(sdcppSizeFor(undefined, config)).toEqual({ width: 512, height: 768 });
    expect(sdcppSizeFor('', config)).toEqual({ width: 512, height: 768 });
    expect(Object.keys(SDCPP_SIZES)).toEqual(['square', 'portrait', 'landscape']);
  });

  it('refuses an unknown size by naming the allowed ones', () => {
    expect(() => sdcppSizeFor('wide', sdcppConfig())).toThrow(
      /size "wide" is not one of square, portrait, landscape/,
    );
  });
});

describe('generateSdcppImage request', () => {
  it('POSTs /sdapi/v1/txt2img with the config defaults and returns the base64 image', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ images: [PNG.toString('base64')], info: '{"seed":1111}' }));
    }) as unknown as typeof fetch;
    const server = fakeServer();

    const image = await generateSdcppImage({
      backend: sdcppConfig(),
      server: server.handle,
      prompt: 'a red fox',
      size: 'portrait',
      alternatives: ['grok-imagine'],
      seed: () => 1111,
      probe: enoughVram,
      fetchImpl,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://127.0.0.1:8093/sdapi/v1/txt2img');
    expect(seen[0]?.body).toMatchObject({
      prompt: 'a red fox',
      width: 928,
      height: 1664,
      steps: 20,
      cfg_scale: 6,
      seed: 1111,
      batch_size: 1,
    });
    expect(image.bytes).toEqual(PNG);
    expect(image.mime).toBe('image/png');
    expect(image).toMatchObject({ seed: 1111, width: 928, height: 1664 });
  });

  it('runs the VRAM gate only when a spawn is needed', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ images: [PNG.toString('base64')] }))) as unknown as typeof fetch;
    const probe = vi.fn(enoughVram);
    const warm = fakeServer({ spawnNeeded: false });
    const image = await generateSdcppImage({
      backend: sdcppConfig({ min_free_vram_mb: 999_999 }),
      server: warm.handle,
      prompt: 'fox',
      alternatives: ['grok-imagine'],
      probe,
      fetchImpl,
    });
    expect(image.mime).toBe('image/png');
    expect(probe).not.toHaveBeenCalled();
  });

  it('names the alternative backend for HTTP 500, an OOM body, and an empty images[0]', async () => {
    const base = {
      backend: sdcppConfig(),
      server: fakeServer().handle,
      prompt: 'fox',
      alternatives: ['grok-imagine'],
      probe: enoughVram,
    };
    await expect(
      generateSdcppImage({
        ...base,
        fetchImpl: vi.fn(async () =>
          new Response('server exploded', { status: 500 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(
      /qwen-local: sd-server returned HTTP 500 for \/sdapi\/v1\/txt2img: server exploded.*grok-imagine/,
    );

    await expect(
      generateSdcppImage({
        ...base,
        fetchImpl: vi.fn(async () =>
          new Response('ggml_cuda_free: out of memory', { status: 500 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/qwen-local: out of memory on GPU 2.*grok-imagine/);

    await expect(
      generateSdcppImage({
        ...base,
        fetchImpl: vi.fn(async () =>
          new Response(JSON.stringify({ images: [] }))) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no image in images\[0\].*grok-imagine/);
  });

  it('refuses bytes that are not an image, using the shared sniffer', async () => {
    await expect(
      generateSdcppImage({
        backend: sdcppConfig(),
        server: fakeServer().handle,
        prompt: 'fox',
        alternatives: [],
        probe: enoughVram,
        fetchImpl: vi.fn(async () =>
          new Response(JSON.stringify({ images: [Buffer.from('<html>').toString('base64')] }))) as unknown as
          typeof fetch,
      }),
    ).rejects.toThrow(/not a PNG, JPEG, GIF, BMP or WebP image/);
  });
});

describe('sdcpp VRAM gate (criterion 7)', () => {
  it('refuses below min_free_vram_mb naming free MB, required MB and the alternative backend', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ images: [PNG.toString('base64')] }))) as unknown as typeof fetch;
    await expect(
      generateSdcppImage({
        backend: sdcppConfig({ min_free_vram_mb: 7000 }),
        server: fakeServer().handle,
        prompt: 'fox',
        alternatives: ['grok-imagine'],
        probe: async () => [gpu(2, 28000)],
        fetchImpl,
      }),
    ).rejects.toThrow(
      /qwen-local: only 4[,.]?768 MB free on GPU 2.*7[,.]?000 MB is required to load "qwen_image_2\.1-Q4_K\.gguf".*grok-imagine/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed on a probe error, an unknown device index, and null memory fields', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ images: [PNG.toString('base64')] }))) as unknown as typeof fetch;
    const base = {
      backend: sdcppConfig(),
      server: fakeServer().handle,
      prompt: 'fox',
      alternatives: ['grok-imagine'],
      fetchImpl,
    };
    await expect(
      generateSdcppImage({
        ...base,
        probe: async () => {
          throw new Error('nvidia-smi is not on PATH');
        },
      }),
    ).rejects.toThrow(/could not check free VRAM on CUDA device 2.*grok-imagine/);

    await expect(generateSdcppImage({ ...base, probe: async () => [gpu(0, 100)] })).rejects.toThrow(
      /no GPU at index 2.*image_generation\.backends\.qwen-local\.cuda_device/,
    );

    await expect(
      generateSdcppImage({ ...base, probe: async () => [gpu(2, null, null)] }),
    ).rejects.toThrow(/no memory figures for GPU 2.*grok-imagine/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('sdcpp abort and timeout (criterion 9)', () => {
  it('stops the owned server when the turn is cancelled mid-render', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => rejectOnAbort(init?.signal),
    ) as unknown as typeof fetch;
    const server = fakeServer();
    controller.abort();

    await expect(
      generateSdcppImage({
        backend: sdcppConfig(),
        server: server.handle,
        prompt: 'a fox by the sea',
        alternatives: ['grok-imagine'],
        signal: controller.signal,
        probe: enoughVram,
        fetchImpl,
      }),
    ).rejects.toThrow(
      /the turn was cancelled while a fox by the sea was rendering.*Forge stopped its own sd-server/,
    );
    expect(server.stopCalls()).toBe(1);
  });

  it('leaves an adopted server running and says whose it is', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => rejectOnAbort(init?.signal),
    ) as unknown as typeof fetch;
    const server = fakeServer({ adopted: true });
    controller.abort();

    await expect(
      generateSdcppImage({
        backend: sdcppConfig(),
        server: server.handle,
        prompt: 'fox',
        alternatives: [],
        signal: controller.signal,
        probe: enoughVram,
        fetchImpl,
      }),
    ).rejects.toThrow(
      /the turn was cancelled while fox was rendering.*belongs to another Forge window/,
    );
    expect(server.stopCalls()).toBe(1);
  });

  it('names request_timeout_ms and the alternative backend when the render times out', async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => rejectOnAbort(init?.signal),
    ) as unknown as typeof fetch;
    await expect(
      generateSdcppImage({
        backend: sdcppConfig({ request_timeout_ms: 1 }),
        server: fakeServer().handle,
        prompt: 'fox',
        alternatives: ['grok-imagine'],
        probe: enoughVram,
        fetchImpl,
      }),
    ).rejects.toThrow(/exceeded request_timeout_ms \(1 ms\).*grok-imagine/);
  });
});
