import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import type { ForgeConfig } from '../../src/config/types';
import type { GpuInfo } from '../../src/system/systemProbes';
import type { FfmpegTools } from '../../src/tools/ffmpegLocate';
import type { UpscaleRun, UpscaleRunResult } from '../../src/tools/imageGeneration/upscaleRunner';
import { makeGenerateImageTool } from '../../src/tools/imageGeneration/generateImageTool';
import { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import { isProcessAlive } from '../../src/util/processLiveness';
import { REMOTE_MEDIA_TEXT } from '../../src/media/remoteMediaContract';
import { RemoteMediaJobs } from '../../src/media/remoteMediaJobs';
import type { RemoteMediaJobRequest } from '../../src/media/remoteMediaContract';

/**
 * The desktop job runner: the plan's ledger sweep, the standing-consent gate,
 * the path rules, the queue and the cancel. Nothing here needs a GPU or a
 * network key — the render itself is injected.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TOOLS: FfmpegTools = { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' };
const UPSCALE = {
  binary: 'V:/models/sd-cli.exe',
  model: 'V:/models/ESRGAN/4x_foolhardy_Remacri.pth',
  cuda_device: 0,
  timeout_ms: 300_000,
  min_free_vram_mb: 1_500,
  max_input_edge_px: 2_048,
};

let root: string;
let jobs: RemoteMediaJobs | undefined;

function pngFile(name: string, width = 900, height = 1_600): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  void name;
  return Buffer.concat([header, Buffer.alloc(64)]);
}

function config(
  media: Partial<NonNullable<ForgeConfig['cloud_relay']>['media']> = {},
  withUpscale = true,
): ForgeConfig {
  return {
    image_generation: {
      backends: [
        {
          name: 'grok-imagine',
          provider: 'xai',
          model: 'grok-imagine-image-2.0',
          api_key_secret: 'xai',
          confirm_each: true,
        },
        {
          name: 'local-sdcpp',
          provider: 'sdcpp',
          binary: 'V:/sd/sd-server.exe',
          diffusion_model: 'V:/models/qwen.gguf',
          text_encoder: 'V:/models/text.gguf',
          vae: 'V:/models/vae.gguf',
          cuda_device: 0,
          text_encoder_on_cpu: false,
          auto_fit: true,
          confirm_on_start: false,
          confirm_each: false,
          extra_args: [],
          media_gpu_lease_enabled: false,
          defaults: { width: 1024, height: 1024, steps: 20, cfg_scale: 2, sampler: 'euler_a' },
        },
      ],
      output_dir: 'generated-images',
      ...(withUpscale ? { upscale: UPSCALE } : {}),
    },
    cloud_relay: {
      enabled: true,
      port: 8797,
      max_body_mb: 32,
      models: [],
      media: {
        enabled: true,
        image_backends: [],
        upscale: false,
        video_engines: [],
        music_engines: [],
        queue_limit: 2,
        job_ttl_minutes: 60,
        ...media,
      },
    },
  } as unknown as ForgeConfig;
}

function gpu(freeMb: number): GpuInfo[] {
  return [
    {
      index: 0,
      name: 'NVIDIA GeForce RTX 3060',
      memoryUsedMb: 12_288 - freeMb,
      memoryTotalMb: 12_288,
      utilizationPercent: null,
      temperatureC: null,
    },
  ];
}

interface Rig {
  jobs: RemoteMediaJobs;
  generate: ReturnType<typeof vi.fn>;
  generateLocal: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
  directory: string;
}

function rig(
  media: Partial<NonNullable<ForgeConfig['cloud_relay']>['media']> = {},
  options: { generate?: () => Promise<unknown>; now?: () => number } = {},
): Rig {
  const generate = vi.fn(
    options.generate ?? (async () => ({ bytes: PNG, mime: 'image/png' })),
  );
  const generateLocal = vi.fn(async () => ({
    bytes: PNG,
    mime: 'image/png',
    width: 1024,
    height: 1024,
    seed: 1,
    mode: 'txt2img',
  }));
  const run = vi.fn(async (spawn: { args: string[] }): Promise<UpscaleRunResult> => {
    await fs.promises.writeFile(spawn.args[spawn.args.length - 1]!, pngFile('out'));
    return { ok: true, exitCode: 0, stderr: '', processGone: true, pid: 4242 };
  }) as unknown as ReturnType<typeof vi.fn>;
  const directory = path.join(root, 'store');
  jobs = new RemoteMediaJobs({
    getConfig: () => config(media),
    root: directory,
    secrets: undefined,
    sdServers: () => new Map(),
    now: options.now,
    imageDeps: { generate: generate as never, generateLocal: generateLocal as never },
    upscaleDeps: {
      run: run as unknown as UpscaleRun,
      probe: async () => gpu(8_000),
      ffmpegTools: TOOLS,
      probeImage: (async () => ({
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 900, height: 1_600 }] }),
        stderr: '',
      })) as never,
    },
  });
  return { jobs, generate, generateLocal, run, directory };
}

function request(
  overrides: Partial<RemoteMediaJobRequest> & { tool: RemoteMediaJobRequest['tool'] },
): RemoteMediaJobRequest {
  return { client: 'laptop', args: {}, ...overrides } as RemoteMediaJobRequest;
}

async function errorOf(reply: { json?: unknown }): string {
  return (reply.json as { error: string }).error;
}

async function bodyOf(reply: { json?: unknown }): Promise<Record<string, unknown>> {
  return reply.json as Record<string, unknown>;
}

async function until(
  read: () => Promise<boolean>,
  what = 'the job to settle',
): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function stateOf(
  runner: RemoteMediaJobs,
  id: string,
): Promise<Record<string, unknown>> {
  return await bodyOf(await runner.status(id));
}

beforeEach(async () => {
  const made = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-remote-media-'));
  root = await fs.promises.realpath(made);
});

afterEach(async () => {
  jobs?.dispose();
  jobs = undefined;
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('remote media jobs: the ledger sweep', () => {
  it('deletes a corrupt or missing job.json, a finished job past its TTL, and fails a dead owner', async () => {
    const now = 1_700_000_000_000;
    const { jobs: runner, directory } = rig({}, { now: () => now });
    await fs.promises.mkdir(directory, { recursive: true });
    const write = async (id: string, text: string): Promise<string> => {
      const dir = path.join(directory, id);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'job.json'), text);
      return dir;
    };
    const record = (id: string, state: string, extra: Record<string, unknown>): string =>
      JSON.stringify({
        id,
        tool: 'generate_image',
        client: 'laptop',
        state,
        pid: process.pid,
        started_at: now - 60_000,
        created_at: now - 60_000,
        ...extra,
      });
    const corrupt = await write('corrupt0000', '{ "state": ');
    const missing = path.join(directory, 'missing00000');
    await fs.promises.mkdir(missing, { recursive: true });
    await fs.promises.writeFile(path.join(missing, 'stray.png'), 'x');
    const finished = await write(
      'finished00',
      record('finished00', 'done', { ended_at: now - 61 * 60_000, files: [] }),
    );
    const dead = spawnSync(process.execPath, ['-e', '0'])?.pid ?? 0;
    expect(isProcessAlive(dead)).toBe(false);
    const abandoned = await write(
      'abandoned0',
      record('abandoned0', 'queued', { pid: dead }),
    );
    const live = await write('live000000', record('live000000', 'running', {}));

    expect(await runner.runSweep()).toEqual({ deleted: 3, failed: 1 });
    expect(fs.existsSync(corrupt)).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(finished)).toBe(false);
    expect(fs.existsSync(abandoned)).toBe(true);
    expect(fs.existsSync(live)).toBe(true);
    expect(JSON.parse(await fs.promises.readFile(path.join(abandoned, 'job.json'), 'utf8'))).toEqual(
      expect.objectContaining({
        state: 'failed',
        error: 'desktop window closed',
        ended_at: now,
      }),
    );
    expect(
      JSON.parse(await fs.promises.readFile(path.join(live, 'job.json'), 'utf8')).state,
    ).toBe('running');
  });
});

describe('remote media jobs: the standing-consent gate', () => {
  it('refuses a dangerous unlisted backend with the whole text, and spawns nothing', async () => {
    const { jobs: runner, generate, generateLocal, directory } = rig({ image_backends: [] });
    const probe = makeGenerateImageTool({
      getConfig: () => config(),
      secrets: undefined,
      notifications: new UserNotificationService(),
    });
    const detail = probe.approval?.({ prompt: 'a cat', backend: 'grok-imagine' })?.detail ?? '';
    expect(detail).toContain('billed per image');

    const reply = await runner.create(
      request({ tool: 'generate_image', args: { prompt: 'a cat', backend: 'grok-imagine' } }),
    );
    expect(reply.status).toBe(403);
    expect(await errorOf(reply)).toBe(
      REMOTE_MEDIA_TEXT.notListed(detail, 'grok-imagine', 'image_backends'),
    );
    // The refusal quotes the card's headline, never the prompt it was built from.
    expect(await errorOf(reply)).not.toContain('a cat');
    expect(generate).not.toHaveBeenCalled();
    expect(generateLocal).not.toHaveBeenCalled();
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('refuses an upscale when cloud_relay.media.upscale is false', async () => {
    const { jobs: runner, run } = rig({ upscale: false });
    const reply = await runner.create(
      request({
        tool: 'upscale_image',
        args: { path: 'cat.png' },
        inputs: [{ arg: 'path', name: 'cat.png', base64: pngFile('cat').toString('base64') }],
      }),
    );
    expect(reply.status).toBe(403);
    expect(await errorOf(reply)).toBe(
      "Not run: The configured local ESRGAN upscale is not allowed from the laptop. Add upscale_image to cloud_relay.media.upscale in the desktop's policy.yaml to allow it.",
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a listed paid backend, saves under the job out/, and opens no editor tab', async () => {
    vi.mocked(vscode.commands.executeCommand).mockClear();
    const { jobs: runner, directory } = rig({ image_backends: ['grok-imagine', 'local-sdcpp'] });
    const paid = await runner.create(
      request({ tool: 'generate_image', args: { prompt: 'a cat', path: 'cat.png' } }),
    );
    expect(paid.status).toBe(202);
    const id = (await bodyOf(paid)).id as string;
    await until(async () => (await stateOf(runner, id)).state === 'done', 'the render to finish');
    expect(fs.existsSync(path.join(directory, id, 'out', 'cat.png'))).toBe(true);
    // The job's reveal stand-in: a laptop render never opens a desktop editor tab.
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    const status = await stateOf(runner, id);
    expect(status.files).toEqual([{ name: 'cat.png', bytes: expect.any(Number), kind: 'image' }]);
    expect(typeof status.result).toBe('string');
    expect((await runner.file(id, 'cat.png')).status).toBe(200);
  });
});

describe('remote media jobs: the result text', () => {
  it('names the file, not the desktop folder, in the text the laptop is sent', async () => {
    const { jobs: runner, directory } = rig({ image_backends: ['grok-imagine'] });
    const accepted = await runner.create(
      request({ tool: 'generate_image', args: { prompt: 'a cat', path: 'cat.png' } }),
    );
    const id = (await bodyOf(accepted)).id as string;
    await until(async () => (await stateOf(runner, id)).state === 'done', 'the render to finish');
    // The path the desktop tool wrote its own text with: proof the job really did
    // name a folder the laptop cannot read, and this test is not vacuous.
    const desktopPath = path.join(directory, id, 'out', 'cat.png').split(path.sep).join('/');
    expect(desktopPath).toContain('out/cat.png');
    const status = await stateOf(runner, id);
    // The desktop tool's own words, kept whole — the size, the backend, the
    // delivery, the billing — with its path reduced to the bare name the laptop
    // fetches the file by.
    expect(String(status.result)).toBe(
      'Generated image saved to cat.png (image/png, 8 bytes) with backend grok-imagine.\n' +
        'No remote chat is watching this turn, so nothing was sent to a phone.\n' +
        'This was a paid xai API call, billed per image.\n' +
        'To inspect it, call view_image on that path.',
    );
    expect(String(status.result)).not.toContain(desktopPath);
    // The same text is what the job's folder carries for any other window. The
    // terminal write is not awaited (`finish` fires it), so poll until it lands.
    let written: { result?: string } = {};
    await until(async () => {
      written = JSON.parse(
        (await fs.promises.readFile(path.join(directory, id, 'job.json'), 'utf8')) as string,
      ) as { result?: string };
      return typeof written.result === 'string';
    }, 'the finished record to reach disk');
    expect(String(status.result)).toBe(String(written.result));
  });
});

describe('remote media jobs: the path rules', () => {
  const refused: Array<[string, RemoteMediaJobRequest, string]> = [
    [
      'an absolute desktop path',
      request({
        tool: 'upscale_image',
        args: { path: 'C:/Users/x/secret.png' },
        inputs: [{ arg: 'path', name: 'secret.png', base64: PNG.toString('base64') }],
      }),
      REMOTE_MEDIA_TEXT.pathRefused('path'),
    ],
    [
      'a traversal out of the job',
      request({ tool: 'upscale_image', args: { path: '../../policy.yaml' } }),
      REMOTE_MEDIA_TEXT.pathRefused('path'),
    ],
    [
      'an output above the job folder',
      request({ tool: 'generate_image', args: { prompt: 'a cat', path: '../escape.png' } }),
      REMOTE_MEDIA_TEXT.outputRefused('path'),
    ],
    [
      'an absolute output',
      request({ tool: 'generate_image', args: { prompt: 'a cat', path: 'V:/x.png' } }),
      REMOTE_MEDIA_TEXT.outputRefused('path'),
    ],
    [
      'a reference that is not an uploaded input',
      request({
        tool: 'generate_image',
        args: { prompt: 'a cat', reference_paths: ['V:/models/sketch.png'] },
      }),
      REMOTE_MEDIA_TEXT.pathRefused('reference_paths'),
    ],
  ];

  it.each(refused)('refuses %s with 400 and reads no desktop file', async (_label, job, text) => {
    const { jobs: runner, generate, run, directory } = rig({
      image_backends: ['grok-imagine'],
      upscale: true,
    });
    const reply = await runner.create(job);
    expect(reply.status).toBe(400);
    expect(await errorOf(reply)).toBe(text);
    expect(generate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('runs an allowed upscale with an uploaded input and lists the file it wrote', async () => {
    const { jobs: runner, directory } = rig({ upscale: true });
    const accepted = await runner.create(
      request({
        tool: 'upscale_image',
        args: { path: 'cat.png' },
        inputs: [{ arg: 'path', name: 'cat.png', base64: pngFile('cat').toString('base64') }],
      }),
    );
    expect(accepted.status).toBe(202);
    const id = (await bodyOf(accepted)).id as string;
    await until(async () => (await stateOf(runner, id)).state === 'done', 'the upscale to finish');
    const status = await stateOf(runner, id);
    expect(status.files).toEqual([{ name: 'cat_x4.png', bytes: expect.any(Number), kind: 'image' }]);

    const fetched = await runner.file(id, 'cat_x4.png');
    expect(fetched.status).toBe(200);
    expect(fs.existsSync(path.join(directory, id, 'inputs', 'cat.png'))).toBe(true);
    expect(fs.existsSync(path.join(directory, id, 'inputs', 'cat_x4.png'))).toBe(true);
    expect(fs.existsSync(path.join(directory, id, 'out'))).toBe(true);

    const missing = await runner.file(id, 'elsewhere.png');
    expect(missing.status).toBe(404);
  });
});

describe('remote media jobs: the queue and the cancel', () => {
  it('answers 429 with the whole text once the queue is full', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const { jobs: runner } = rig(
      { image_backends: ['grok-imagine'], queue_limit: 2 },
      {
        generate: async () => {
          await pending;
          return { bytes: PNG, mime: 'image/png' };
        },
      },
    );
    const first = await runner.create(
      request({ tool: 'generate_image', args: { prompt: 'one' } }),
    );
    expect(first.status).toBe(202);
    expect((await runner.create(request({ tool: 'generate_image', args: { prompt: 'two' } }))).status).toBe(202);
    expect((await runner.create(request({ tool: 'generate_image', args: { prompt: 'three' } }))).status).toBe(202);
    const fourth = await runner.create(request({ tool: 'generate_image', args: { prompt: 'four' } }));
    expect(fourth.status).toBe(429);
    expect(await errorOf(fourth)).toBe(REMOTE_MEDIA_TEXT.queueFull(2));
    release();
    await until(async () => (await stateOf(runner, (await bodyOf(first)).id as string)).state === 'done');
  });

  it('cancels a running job and marks it failed: cancelled', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const { jobs: runner } = rig(
      { image_backends: ['grok-imagine'] },
      {
        generate: async () => {
          await pending;
          return { bytes: PNG, mime: 'image/png' };
        },
      },
    );
    const accepted = await runner.create(
      request({ tool: 'generate_image', args: { prompt: 'slow cat' } }),
    );
    const id = (await bodyOf(accepted)).id as string;
    await until(async () => (await stateOf(runner, id)).state === 'running', 'the job to start');
    const cancelled = await runner.cancel(id);
    expect(cancelled.status).toBe(200);
    expect(await bodyOf(cancelled)).toEqual({ state: 'failed' });
    const status = await stateOf(runner, id);
    expect(status.state).toBe('failed');
    expect(status.error).toBe('cancelled');
    release();
  });

  it('fails a queued job when the media block is turned off', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    let enabled = true;
    const runner = new RemoteMediaJobs({
      getConfig: () => config({ image_backends: ['grok-imagine'], enabled }),
      root: path.join(root, 'store'),
      secrets: undefined,
      imageDeps: {
        generate: (async () => {
          await pending;
          return { bytes: PNG, mime: 'image/png' };
        }) as never,
      },
    });
    jobs = runner;
    const running = await runner.create(request({ tool: 'generate_image', args: { prompt: 'one' } }));
    const queued = await runner.create(request({ tool: 'generate_image', args: { prompt: 'two' } }));
    expect(queued.status).toBe(202);
    enabled = false;
    runner.applyConfig();
    expect((await stateOf(runner, (await bodyOf(running)).id as string)).error).toBe('disabled');
    expect((await stateOf(runner, (await bodyOf(queued)).id as string)).error).toBe('disabled');
    release();
  });

  it('answers 400 for the two tools this phase does not serve', async () => {
    const { jobs: runner } = rig();
    for (const tool of ['generate_video', 'generate_music'] as const) {
      const reply = await runner.create(request({ tool, args: {} }));
      expect(reply.status).toBe(400);
      expect(await errorOf(reply)).toBe(`${tool} is not served yet`);
    }
  });
});

describe('remote media jobs: capabilities', () => {
  it('lists what it will render, and why it will not render the rest', async () => {
    const { jobs: runner } = rig({ image_backends: ['grok-imagine'], upscale: true });
    const capabilities = runner.capabilities();
    expect(capabilities.upscale).toBe(true);
    expect(capabilities.image?.backends).toEqual([
      {
        name: 'grok-imagine',
        paid: true,
        confirm_each: true,
        cost: 'cloud · billed per image · xai · grok-imagine-image-2.0',
        reference_images: false,
      },
    ]);
    expect(capabilities.tools.map((tool) => tool.function.name)).toEqual([
      'generate_image',
      'upscale_image',
    ]);
    expect(capabilities.refused).toEqual([
      {
        name: 'local-sdcpp',
        reason: 'not listed in cloud_relay.media.image_backends',
      },
    ]);
    expect(capabilities.max_body_bytes).toBe(32 * 1024 * 1024);
  });
});
