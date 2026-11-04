/**
 * Phase 3 review fixes on `generate_video`: the default engine is the configured
 * LTX-2.5 entry whatever the config order (an H3 entry is reached only by an
 * explicit id), an H3 render always gets its `--reserve-vram` flag including a
 * reserve of 0, and an LTX size off the 64-pixel grid is refused before the GPU
 * lease is taken or anything is spawned (docs/plans/MEDIA_SHIPPED_PLAN.md §1
 * "Each tool" and the lease row of its State x lifecycle ledger).
 *
 * The engines are configured against real files in a temp folder, so the shared
 * `checkMediaSetup` verdict is the real one; only the render process is faked,
 * and in the size-refusal test the lease itself is faked to count takes.
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

import type { MediaConfig } from '../../src/config/mediaSchema';
import { MediaConfigSchema } from '../../src/config/mediaSchema';
import type { MediaToolDeps } from '../../src/tools/media/mediaToolDeps';
import { makeGenerateVideoTool } from '../../src/tools/media/generateVideoTool';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-engine-'));
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

/** H3 is listed FIRST on purpose: config order must not decide the default. */
async function configuredMedia(reserveVramGb: number): Promise<MediaConfig> {
  const comfyRoot = path.join(root, 'comfyui');
  await fixture(path.join(comfyRoot, 'main.py'));
  const python = await fixture(path.join(comfyRoot, '.venv', 'Scripts', 'python.exe'));
  const workflow = await fixture(path.join(comfyRoot, 'workflows', 'h3_i2v.json'));
  const h3Diffusion = await fixture(path.join(comfyRoot, 'models', 'diffusion_models', 'h3.safetensors'));
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
    comfyui: { root: comfyRoot, python },
    video: {
      engines: [
        {
          id: 'h3',
          kind: 'comfyui_workflow',
          models: { diffusion: h3Diffusion },
          workflow,
          cuda_devices: [0],
          reserve_vram_gb: reserveVramGb,
        },
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

interface Started {
  args: readonly string[];
}

interface VideoTool {
  handler: (args: Record<string, unknown>, context?: object) => Promise<string>;
}

function toolFor(
  media: MediaConfig,
  starts: Started[],
  acquireLease?: MediaToolDeps['acquireLease'],
  gpuProbe: NonNullable<MediaToolDeps['gpuProbe']> = async () =>
    [0, 1, 2].map((index) => ({
      index,
      name: `test-gpu-${index}`,
      memoryUsedMb: 0,
      memoryTotalMb: 16_000,
      utilizationPercent: 0,
      temperatureC: 30,
    })),
): VideoTool {
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
      starts.push({ args: spec.args });
      return { id: 'exec-1', status: 'running', pid: 5150, startedAt: Date.now() };
    },
    waitFinished: () => new Promise<unknown>(() => undefined),
  };
  const tool = makeGenerateVideoTool({
    getConfig: () => ({
      active_model: 'primary',
      llama_server: { binary: 'llama-server' },
      models: [{ name: 'primary', gguf_path: '/p.gguf' }],
      media,
    }),
    adaptersDir: path.join(root, 'resources', 'media'),
    workspaceRoot: root,
    lifecycle: {
      loadedModels: () => [],
      isBusy: () => false,
      unloadModel: async () => ({ unloaded: true }),
    },
    leasePath: path.join(root, 'lease.json'),
    leasePid: 10,
    leaseProcessStartTime: 1_000,
    lookupProcessStartTime: async () => 1_000,
    background,
    gpuProbe,
    ffmpegTools: { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' },
    acquireLease: acquireLease ?? fakeAcquireLease,
    log: () => {},
  });
  return tool as unknown as VideoTool;
}

async function jobOf(starts: Started[], index: number): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(starts[index].args[1], 'utf8')) as Record<string, unknown>;
}

describe('generate_video: the engine default, the reserve flag and the size grid', () => {
  it('defaults to the LTX-2.5 entry even when H3 is configured first', async () => {
    const media = await configuredMedia(0);
    const still = await fixture(path.join(root, 'still.png'));
    const starts: Started[] = [];
    const tool = toolFor(media, starts);
    await tool.handler({ prompt: 'A slow lateral move over the still.', image_path: still }, {
      conversationId: 'conversation-1',
    });
    const job = await jobOf(starts, 0);
    expect(job.engine).toBe('ltx25');
    expect(job.kind).toBe('video');
  });

  it('renders on H3 only by its id, and always passes --reserve-vram', async () => {
    for (const reserveVramGb of [0, 2.5]) {
      const media = await configuredMedia(reserveVramGb);
      const still = await fixture(path.join(root, 'still.png'));
      const starts: Started[] = [];
      const tool = toolFor(media, starts);
      await tool.handler(
        { prompt: 'A slow lateral move over the still.', image_path: still, engine: 'h3' },
        { conversationId: 'conversation-1' },
      );
      const job = await jobOf(starts, 0);
      expect(job.engine).toBe('h3');
      expect(job.models).toEqual({ diffusion: path.join(root, 'comfyui', 'models', 'diffusion_models', 'h3.safetensors') });
      const inputs = job.inputs as Record<string, string>;
      expect(inputs.workflow_path).toBe(path.join(root, 'comfyui', 'workflows', 'h3_i2v.json'));
      expect(inputs.image_path).toContain(path.join(root, 'media', 'video'));
      expect(inputs.image_path).toMatch(/input[\\/]source-still\.png$/);
      const comfy = job.comfyui as Record<string, unknown>;
      expect(comfy.startup_args).toEqual([
        '--disable-auto-launch',
        '--reserve-vram',
        String(reserveVramGb),
      ]);
    }
  });

  it('accepts LTX sizes on the 64-pixel grid', async () => {
    const media = await configuredMedia(0);
    const still = await fixture(path.join(root, 'still.png'));
    for (const [width, height] of [[64, 64], [1_024, 768], [960, 576]]) {
      const starts: Started[] = [];
      const tool = toolFor(media, starts);
      await tool.handler(
        { prompt: 'A slow lateral move over the still.', image_path: still, width, height },
        { conversationId: 'conversation-1' },
      );
      const job = await jobOf(starts, 0);
      const video = job.video as Record<string, unknown>;
      expect([video.width, video.height], `${width}x${height} is on the grid`).toEqual([
        width,
        height,
      ]);
    }
  });

  it('refuses an LTX size off the grid before taking the lease or spawning', async () => {
    const media = await configuredMedia(0);
    const still = await fixture(path.join(root, 'still.png'));
    let leaseTakes = 0;
    const starts: Started[] = [];
    const tool = toolFor(media, starts, async () => {
      leaseTakes += 1;
      return {
        record: {
          pid: 10,
          process_start_time: 1_000,
          owner: 'media:video:ltx25',
          gpu: 2,
          started_at: new Date().toISOString(),
        },
        transfer: async () => undefined,
        release: async () => undefined,
      };
    });
    await expect(
      tool.handler(
        { prompt: 'A slow lateral move over the still.', image_path: still, width: 1_000, height: 768 },
        { conversationId: 'conversation-1' },
      ),
    ).rejects.toThrow(/multiple of 64/);
    expect(leaseTakes).toBe(0);
    expect(starts).toHaveLength(0);
  });

  it('refuses low free VRAM before taking the lease or spawning', async () => {
    const media = await configuredMedia(0);
    const still = await fixture(path.join(root, 'still.png'));
    const starts: Started[] = [];
    let leaseTakes = 0;
    const tool = toolFor(
      media,
      starts,
      async () => {
        leaseTakes += 1;
        throw new Error('lease must not be reached');
      },
      async () => [
        {
          index: 2,
          name: 'RTX test',
          memoryUsedMb: 6_000,
          memoryTotalMb: 16_000,
          utilizationPercent: 0,
          temperatureC: 30,
        },
      ],
    );
    await expect(
      tool.handler(
        { prompt: 'A slow lateral move over the still.', image_path: still },
        { conversationId: 'conversation-1' },
      ),
    ).rejects.toThrow(/only 10[.,]000 MB free.*11[.,]000 MB is required/);
    expect(leaseTakes).toBe(0);
    expect(starts).toHaveLength(0);
  });
});
