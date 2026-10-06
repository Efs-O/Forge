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
import type { FfmpegTools } from '../../src/tools/ffmpegLocate';
import { makeGenerateImageTool } from '../../src/tools/imageGeneration/generateImageTool';
import { targetPath } from '../../src/tools/imageGeneration/generateImageToolFormat';
import type { SdcppImageRequest } from '../../src/tools/imageGeneration/sdcppImageBackend';
import type { SdcppJobRequest, SdcppJobResult } from '../../src/tools/imageGeneration/sdcppJobPoll';
import type { RunFfmpeg } from '../../src/tools/imageGeneration/sdcppReferenceInput';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';

/**
 * The tool layer of reference editing: which request shape a reference takes,
 * what the result says, and what is refused before a single GPU cycle is spent.
 * The input rules themselves are in `SdcppReferenceInput.test.ts` and the job
 * loop in `SdcppJobPoll.test.ts`; this file owns the seams between them.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let root: string;

function backendWith(overrides: Record<string, unknown> = {}) {
  return {
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
    vision_encoder: 'V:/models/Qwen-Image-2.1/mmproj-Qwen3VL-8B-Instruct-F16.gguf',
    ...overrides,
  };
}

function localConfig(overrides: Record<string, unknown> = {}): ImageGenerationConfig {
  return ImageGenerationConfigSchema.parse({
    default: 'qwen-local',
    backends: [
      backendWith(overrides),
      {
        name: 'grok-imagine',
        provider: 'xai',
        model: 'grok-imagine-image-2.0',
        api_key_secret: 'xai',
      },
    ],
  }) as ImageGenerationConfig;
}

const TOOLS: FfmpegTools = { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' };

/** ffprobe answers 1280x1253; ffmpeg answers with the PNG header. Nothing is spawned. */
function fakeFfmpeg(): RunFfmpeg & { calls: { bin: string; argv: string[] }[] } {
  const calls: { bin: string; argv: string[] }[] = [];
  const run = (async (bin: string, argv: string[]) => {
    calls.push({ bin, argv });
    if (bin === 'ffprobe.exe') {
      return {
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 1280, height: 1253 }] }),
        stderr: '',
      };
    }
    fs.writeFileSync(argv[argv.length - 1] as string, PNG);
    return { code: 0, stdout: '', stderr: '' };
  }) as RunFfmpeg & { calls: typeof calls };
  run.calls = calls;
  return run;
}

function jobResult(seed: number): SdcppJobResult {
  return {
    bytes: PNG,
    mime: 'image/png',
    seed,
    width: 768,
    height: 768,
    seconds: 71.4,
    jobId: `job_${seed}`,
  };
}

interface RigOptions {
  config?: ImageGenerationConfig;
  job?: (request: SdcppJobRequest) => Promise<SdcppJobResult>;
  seeds?: number[];
}

function rig(options: RigOptions = {}) {
  const config = options.config ?? localConfig();
  const job = vi.fn(options.job ?? (async (request: SdcppJobRequest) => jobResult(request.seed)));
  const generateLocal = vi.fn(async (request: SdcppImageRequest & { seed?: () => number }) => ({
    bytes: PNG,
    mime: 'image/png',
    // The shipped sync path receives a seed thunk; echo it so the result's
    // reported seed is the one that was actually asked for.
    seed: request.seed ? request.seed() : 1111,
    width: 1024,
    height: 1024,
  }));
  const ffmpeg = fakeFfmpeg();
  const spawns: string[][] = [];
  const server = {
    startApproval: () => undefined,
    baseUrl: () => 'http://127.0.0.1:8093',
  } as unknown as SdServerBackend;
  const tool = makeGenerateImageTool({
    getConfig: () =>
      ({ image_generation: config, video: { ffmpeg_path: '' } }) as unknown as ForgeConfig,
    secrets: undefined,
    notifications: new UserNotificationService(),
    sdServers: () => new Map([[config.backends[0]!.name, server]]),
    generateLocal,
    generateJob: job,
    onReferenceSpawn: (argv) => spawns.push(argv),
    ffmpegTools: TOOLS,
    runReference: ffmpeg,
    reveal: async () => undefined,
    now: () => new Date('2026-09-14T10:20:30Z'),
    seed: (() => {
      const queue = [...(options.seeds ?? [1111, 2222])];
      return () => (queue.length > 1 ? (queue.shift() as number) : (queue[0] as number));
    })(),
  });
  return { tool, job, generateLocal, ffmpeg, spawns };
}

function writeReference(name: string, bytes: Buffer = PNG): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

const noSnapshot = { beforeMutate: (): void => undefined };

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-image-refs-')));
  (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = [
    { uri: { fsPath: root } },
  ];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('reference_paths at the tool layer (A2, A8, A15, A22, A26)', () => {
  it('refuses when the backend sets no vision_encoder, naming the mmproj and the alternative', async () => {
    const { tool, job, generateLocal, ffmpeg } = rig({
      config: localConfig({ vision_encoder: undefined }),
    });
    const reference = writeReference('sketch.png');
    await expect(
      tool.handler({ prompt: 'make it 3d', reference_paths: [reference] }, noSnapshot),
    ).rejects.toThrow(
      /qwen-local: reference images need image_generation\.backends\.qwen-local\.vision_encoder.*mmproj-.*grok-imagine/s,
    );
    // The refusal is free: no probe, no decode, no server, no render.
    expect(ffmpeg.calls).toHaveLength(0);
    expect(job).not.toHaveBeenCalled();
    expect(generateLocal).not.toHaveBeenCalled();
  });

  it('sends a reference through the async job endpoint, never txt2img (A15)', async () => {
    const { tool, job, generateLocal } = rig();
    const reference = writeReference('sketch.png');
    const result = await tool.handler(
      { prompt: 'make it a 3d render', reference_paths: [reference], size: 'square' },
      noSnapshot,
    );
    expect(generateLocal).not.toHaveBeenCalled();
    expect(job).toHaveBeenCalledTimes(1);
    const request = job.mock.calls[0]?.[0] as SdcppJobRequest;
    expect(request.referenceImages).toHaveLength(1);
    expect(request.width).toBe(1328);
    expect(request.height).toBe(1328);
    expect(result).toContain(
      'Rendered locally through img_gen(ref_images) with 1 reference image(s).',
    );
  });

  it('reports the downscale it performed, so a resized reference is never silent (A8, A26)', async () => {
    const { tool } = rig();
    const reference = writeReference('sketch.png');
    const result = await tool.handler({ prompt: 'x', reference_paths: [reference] }, noSnapshot);
    expect(result).toContain(
      'reference sketch.png: 1280x1253 downscaled to 768x736 (long edge cap)',
    );
  });

  it('de-duplicates reference paths at the tool layer and says so (A24)', async () => {
    const { tool, job } = rig();
    const reference = writeReference('sketch.png');
    // Another casing is the same file only on Windows; on Linux it is a
    // different (missing) file, so repeat the exact path there.
    const respelled = process.platform === 'win32' ? reference.toUpperCase() : reference;
    const result = await tool.handler(
      { prompt: 'x', reference_paths: [reference, respelled, reference] },
      noSnapshot,
    );
    expect((job.mock.calls[0]?.[0] as SdcppJobRequest).referenceImages).toHaveLength(1);
    expect(result).toContain('1 reference image(s), 2 duplicate path removed.');
  });

  it('refuses an output that resolves to the reference, before any render (A22)', async () => {
    // The ordinary shape: a workspace-relative `path` beside an absolute
    // reference. Comparing the two spellings without resolving both misses it.
    const reference = writeReference('sketch.png');
    const { tool, job, ffmpeg } = rig();
    await expect(
      tool.handler({ prompt: 'x', path: 'sketch.png', reference_paths: [reference] }, noSnapshot),
    ).rejects.toThrow(
      /the output ".*sketch\.png" is the reference image ".*sketch\.png"\. An edit cannot overwrite its own source/s,
    );
    expect(job).not.toHaveBeenCalled();
    expect(ffmpeg.calls.filter((call) => call.bin === 'ffmpeg.exe')).toHaveLength(1);
  });

  it('refuses an output that reaches the reference through a junction (A22)', async () => {
    // `saveImage` resolves its target with `resolveRealWorkspacePath`, which
    // follows a junction inside the workspace. A lexical collision check let
    // `path: "link/sketch.png"` (link -> the reference's own folder) write over
    // the picture the edit was reading. Both sides must be realpaths.
    let link: string;
    try {
      link = path.join(root, 'link');
      fs.symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Junctions are unavailable on some filesystems; skip rather than fail.
      return;
    }
    const reference = writeReference('sketch.png');
    const { tool, job } = rig();
    let message = '';
    try {
      await tool.handler(
        { prompt: 'x', path: 'link/sketch.png', reference_paths: [reference] },
        noSnapshot,
      );
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toMatch(/cannot overwrite its own source/s);
    // Decisive: the refusal names the RESOLVED destination. If the guard were
    // still lexical it would quote `link/sketch.png` and find no collision, and
    // the render would overwrite the picture it was reading.
    expect(message).not.toContain('link');
    expect(job).not.toHaveBeenCalled();
    expect(fs.readFileSync(reference)).toEqual(PNG);
    fs.rmSync(link, { recursive: true, force: true });
  });

  it('lets an edit save beside the reference under a different name (A22)', async () => {
    const reference = writeReference('sketch.png');
    const { tool, job } = rig();
    const result = await tool.handler(
      { prompt: 'x', path: 'sketch-render.png', reference_paths: [reference] },
      noSnapshot,
    );
    expect(job).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(root, 'sketch-render.png'))).toEqual(PNG);
    expect(fs.readFileSync(reference)).toEqual(PNG);
    expect(result).toContain('sketch-render.png');
  });
});

describe('count / variations at the tool layer (A10, A11, A23, A25)', () => {
  it('refuses a count outside 1-2 instead of clamping it (A10)', async () => {
    const { tool, job, generateLocal } = rig();
    await expect(tool.handler({ prompt: 'x', count: 3 }, noSnapshot)).rejects.toThrow(
      /count must be an integer from 1 to 2; got 3/,
    );
    await expect(tool.handler({ prompt: 'x', count: 0 }, noSnapshot)).rejects.toThrow(
      /count must be an integer from 1 to 2; got 0/,
    );
    expect(job).not.toHaveBeenCalled();
    expect(generateLocal).not.toHaveBeenCalled();
  });

  it('renders count: 2 as two files with two distinct reported seeds (A10)', async () => {
    const { tool, generateLocal } = rig({ seeds: [1111, 2222] });
    const result = await tool.handler({ prompt: 'a red fox', count: 2 }, noSnapshot);
    expect(generateLocal).toHaveBeenCalledTimes(2);
    expect(fs.readdirSync(path.join(root, 'generated-images')).sort()).toEqual([
      '20260914-102030-a-red-fox-1.png',
      '20260914-102030-a-red-fox-2.png',
    ]);
    expect(result).toContain('seed 1111');
    expect(result).toContain('seed 2222');
  });

  it('splits an explicit path into -1/-2 so two variations never share a file (A11, A23)', () => {
    const config = localConfig();
    const image = { bytes: PNG, mime: 'image/png' };
    const at = new Date('2026-09-14T10:20:30Z');
    expect(targetPath(config, 'art/fox.png', 'a fox', image, at, 0)).toBe('art/fox-1.png');
    expect(targetPath(config, 'art/fox.png', 'a fox', image, at, 1)).toBe('art/fox-2.png');
    // A path with no known extension still gets the real extension plus the suffix.
    expect(targetPath(config, 'art/fox', 'a fox', image, at, 1)).toBe('art/fox-2.png');
    // count: 1 (no index) keeps the historical single-image name byte-identical,
    // and the extension still comes from the bytes the backend returned.
    expect(targetPath(config, 'art/fox.jpg', 'a fox', image, at)).toBe('art/fox.png');
  });

  it('reports what it did save when a later variation fails (A25)', async () => {
    let attempt = 0;
    const { tool } = rig({
      job: async (request) => {
        attempt += 1;
        if (attempt === 2) throw new Error('out of memory on GPU 2');
        return jobResult(request.seed);
      },
    });
    const reference = writeReference('sketch.png');
    const result = await tool.handler(
      { prompt: 'a red fox', count: 2, reference_paths: [reference] },
      noSnapshot,
    );
    expect(fs.readdirSync(path.join(root, 'generated-images'))).toEqual([
      '20260914-102030-a-red-fox-1.png',
    ]);
    expect(result).toContain('Variation 2 of 2 was not produced: out of memory on GPU 2');
    expect(result).toContain('20260914-102030-a-red-fox-1.png');
  });

  it('fails the whole call when the first variation fails, saving nothing', async () => {
    const { tool } = rig({
      job: async () => {
        throw new Error('sd-server returned HTTP 500');
      },
    });
    const reference = writeReference('sketch.png');
    await expect(
      tool.handler({ prompt: 'x', count: 2, reference_paths: [reference] }, noSnapshot),
    ).rejects.toThrow(/sd-server returned HTTP 500/);
    expect(fs.existsSync(path.join(root, 'generated-images'))).toBe(false);
  });
});
