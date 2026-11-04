/**
 * `generate_video`'s text-to-video path: the still comes from the configured
 * image backend — `media.video.still_backend` naming an `image_generation.backends[]`
 * entry, rendered through the same local sd-server route `generate_image` uses
 * (docs/plans/MEDIA_SHIPPED_PLAN.md §2 "still from sd-server (configured) → image
 * → video below") — and it lands inside the run folder, so the clip's inputs
 * stay with the clip.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

import { MediaConfigSchema } from '../../src/config/mediaSchema';
import { acquireMediaGpuLease } from '../../src/media/mediaGpuLease';
import { makeGenerateVideoTool } from '../../src/tools/media/generateVideoTool';
import type { MediaToolDeps } from '../../src/tools/media/mediaToolDeps';
import type { SdcppImageBackendConfig } from '../../src/config/types';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-video-'));
});
afterEach(async () => {
  // A detached render chain can still be writing when the test ends.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(candidate: string): Promise<string> {
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.writeFile(candidate, 'fixture', 'utf8');
  return candidate;
}

async function configuredMedia(): Promise<ReturnType<typeof MediaConfigSchema.parse>> {
  const comfyRoot = path.join(root, 'comfyui');
  await fixture(path.join(comfyRoot, 'main.py'));
  await fixture(path.join(comfyRoot, '.venv', 'Scripts', 'python.exe'));
  const models = path.join(comfyRoot, 'models');
  for (const name of [
    'diffusion_models/ltx.gguf',
    'vae/video.safetensors',
    'vae/audio.safetensors',
    'text_encoders/encoder.safetensors',
    'latent_upscale_models/upscaler.safetensors',
  ]) {
    await fixture(path.join(models, name));
  }
  return MediaConfigSchema.parse({
    enabled: true,
    comfyui: { root: comfyRoot, python: path.join(comfyRoot, '.venv', 'Scripts', 'python.exe') },
    video: {
      still_backend: 'sdcpp-local',
      engines: [
        {
          id: 'ltx25',
          kind: 'ltx25',
          models: {
            diffusion: path.join(models, 'diffusion_models/ltx.gguf'),
            video_vae: path.join(models, 'vae/video.safetensors'),
            audio_vae: path.join(models, 'vae/audio.safetensors'),
            text_encoder: path.join(models, 'text_encoders/encoder.safetensors'),
            latent_upscaler: path.join(models, 'latent_upscale_models/upscaler.safetensors'),
          },
          cuda_devices: [2],
        },
      ],
    },
  });
}

async function mediaWithH3(reserveVramGb = 0): Promise<ReturnType<typeof MediaConfigSchema.parse>> {
  const media = await configuredMedia();
  const workflow = await fixture(path.join(root, 'h3-workflow.json'));
  const diffusion = await fixture(path.join(root, 'models', 'minimax_h3_nvfp4.safetensors'));
  return MediaConfigSchema.parse({
    ...media,
    video: {
      ...media.video,
      engines: [
        {
          id: 'h3',
          kind: 'comfyui_workflow',
          models: { diffusion },
          workflow,
          cuda_devices: [0],
          reserve_vram_gb: reserveVramGb,
        },
        ...media.video.engines,
      ],
    },
  });
}

const BACKEND: SdcppImageBackendConfig = {
  name: 'sdcpp-local',
  provider: 'sdcpp',
  binary: '/bin/sd-server',
  diffusion_model: '/models/diffusion.gguf',
  text_encoder: '/models/text.gguf',
  vae: '/models/vae.gguf',
  cuda_device: 2,
  text_encoder_on_cpu: true,
  auto_fit: true,
  port: 8191,
  min_free_vram_mb: 1_000,
  idle_timeout_ms: 60_000,
  request_timeout_ms: 300_000,
  max_reference_edge_px: 1_024,
  confirm_on_start: false,
  confirm_each: false,
  media_gpu_lease_enabled: false,
  defaults: { steps: 20, cfg_scale: 5, sampler: 'euler', width: 1152, height: 896, seed: 1 },
  extra_args: [],
};

interface Started {
  args: readonly string[];
}

function toolFor(
  media: ReturnType<typeof MediaConfigSchema.parse>,
  started: Started[],
  stillCalls: { sizeName: string; outDir: string }[],
  acquireLease?: MediaToolDeps['acquireLease'],
): RegisteredTool {
  const fakeAcquireLease: NonNullable<MediaToolDeps['acquireLease']> = async (owner, gpu) => ({
    record: {
      pid: 10,
      process_start_time: 1_000,
      owner,
      gpu,
      started_at: new Date().toISOString(),
    },
    transfer: async () => undefined,
    release: async () => undefined,
  });
  const background = {
    start: (spec: { command: string; args: readonly string[] }) => {
      started.push({ args: spec.args });
      return { id: 'exec-1', status: 'running', pid: 5150, startedAt: Date.now() };
    },
    waitFinished: () => new Promise<unknown>(() => undefined),
  };
  return makeGenerateVideoTool({
    getConfig: () => ({
      active_model: 'primary',
      llama_server: { binary: 'llama-server' },
      models: [{ name: 'primary', gguf_path: '/p.gguf' }],
      image_generation: { backends: [BACKEND], output_dir: 'images' },
      media,
    }),
    adaptersDir: path.join(root, 'resources', 'media'),
    workspaceRoot: root,
    sdServers: () => new Map([['sdcpp-local', {}]]),
    lifecycle: {
      loadedModels: () => [{ name: 'strata', gpus: [0, 1] }],
      isBusy: () => false,
      unloadModel: async () => ({ unloaded: true }),
    },
    leasePath: path.join(root, 'lease.json'),
    acquireLease: acquireLease ?? fakeAcquireLease,
    leasePid: 10,
    leaseProcessStartTime: 1000,
    lookupProcessStartTime: async () => 1000,
    background,
    gpuProbe: async () =>
      [0, 1, 2].map((index) => ({
        index,
        name: `test-gpu-${index}`,
        memoryUsedMb: 0,
        memoryTotalMb: 16_000,
        utilizationPercent: 0,
        temperatureC: 30,
      })),
    ffmpegTools: { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' },
    renderStill: async (request) => {
      stillCalls.push({ sizeName: request.sizeName, outDir: request.outDir });
      const target = path.join(request.outDir, 'still.png');
      await fs.writeFile(target, 'fake png bytes', 'utf8');
      return { path: target, seed: request.seed, width: 1152, height: 896 };
    },
    log: () => {},
  });
}

interface RegisteredTool {
  handler: (args: Record<string, unknown>, context?: object) => Promise<string>;
}

describe('generate_video: the still comes from the configured image backend', () => {
  it('renders the still into the run folder and hands the adapter that path', async () => {
    const media = await configuredMedia();
    const started: Started[] = [];
    const stillCalls: { sizeName: string; outDir: string }[] = [];
    const tool = toolFor(media, started, stillCalls);
    const text = await tool.handler(
      { prompt: 'Slow lateral move over a neutral landscape.' },
      { conversationId: 'conversation-1' },
    );
    expect(stillCalls).toHaveLength(1);
    expect(stillCalls[0].sizeName).toBe('landscape');
    expect(stillCalls[0].outDir).toContain(path.join('media', 'video'));
    const job = JSON.parse(await fs.readFile(started[0].args[1], 'utf8')) as Record<
      string,
      unknown
    >;
    expect(job.engine).toBe('ltx25');
    const stillPath = (job.inputs as Record<string, string>).image_path;
    expect(stillPath).toContain(path.join('input', 'still.png'));
    expect(text).toContain('made by image_generation.backends.sdcpp-local');
  });

  it('refuses text-to-video when still_backend names no sd-server, and honours an image_path', async () => {
    const media = await configuredMedia();
    const withoutBackend = MediaConfigSchema.parse({
      ...media,
      video: { ...media.video, still_backend: '' },
    });
    const tool = toolFor(withoutBackend, [], []);
    await expect(
      tool.handler({ prompt: 'A still that cannot be made.' }, { conversationId: 'c' }),
    ).rejects.toThrow(/still_backend/);

    const image = await fixture(path.join(root, 'given.png'));
    const started: Started[] = [];
    const stillCalls: { sizeName: string; outDir: string }[] = [];
    const withImage = toolFor(media, started, stillCalls);
    await withImage.handler(
      { prompt: 'Animate the picture I attached.', image_path: image },
      { conversationId: 'c' },
    );
    expect(stillCalls).toHaveLength(0);
    const job = JSON.parse(await fs.readFile(started[0].args[1], 'utf8')) as Record<
      string,
      unknown
    >;
    const copiedStill = (job.inputs as Record<string, string>).image_path;
    expect(copiedStill).toContain(path.join('input', 'source-still.png'));
    expect(await fs.readFile(copiedStill, 'utf8')).toBe('fixture');
  });

  it('passes H3 reserve-vram explicitly, including zero', async () => {
    const image = await fixture(path.join(root, 'h3-input.png'));
    for (const reserve of [0, 1.5]) {
      const media = await mediaWithH3(reserve);
      const started: Started[] = [];
      const tool = toolFor(media, started, []);
      await tool.handler(
        { prompt: 'A slow move.', image_path: image, engine: 'h3' },
        { conversationId: 'c' },
      );
      const job = JSON.parse(await fs.readFile(started[0].args[1], 'utf8')) as {
        comfyui: { startup_args: string[] };
      };
      expect(job.comfyui.startup_args).toEqual(
        expect.arrayContaining(['--reserve-vram', String(reserve)]),
      );
    }
  });

  it('rejects an off-grid LTX dimension before acquiring the GPU lease', async () => {
    const media = await configuredMedia();
    let leaseCalls = 0;
    const acquireLease: NonNullable<MediaToolDeps['acquireLease']> = async (...args) => {
      leaseCalls += 1;
      return acquireMediaGpuLease(...args);
    };
    const started: Started[] = [];
    const tool = toolFor(media, started, [], acquireLease);
    await expect(
      tool.handler({ prompt: 'A still frame.', width: 1000 }, { conversationId: 'c' }),
    ).rejects.toThrow(/not a multiple of 64[\s\S]*No GPU lease was taken/);
    expect(leaseCalls).toBe(0);
    expect(started).toHaveLength(0);
  });

  it('accepts LTX dimensions on the 64-pixel grid', async () => {
    const media = await configuredMedia();
    for (const width of [64, 960, 1024]) {
      const started: Started[] = [];
      const tool = toolFor(media, started, []);
      await tool.handler(
        { prompt: 'A valid grid size.', width, height: 1024 },
        { conversationId: 'c' },
      );
      const job = JSON.parse(await fs.readFile(started[0].args[1], 'utf8')) as {
        video: { width: number; height: number };
      };
      expect(job.video).toMatchObject({ width, height: 1024 });
    }
  });
});
