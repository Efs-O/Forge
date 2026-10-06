import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageGenerationConfigSchema } from '../../src/config/imageGenerationSchema';
import type { SdcppImageBackendConfig } from '../../src/config/types';
import { FfmpegMissingError, resolveFfmpeg, type FfmpegTools } from '../../src/tools/ffmpegLocate';
import {
  ACCEPTED_REFERENCE_FORMATS,
  DIMENSION_MULTIPLE,
  MAX_REFERENCE_INPUT_BYTES,
  computeReferenceScale,
  describePreparedReferences,
  prepareReferences,
  referenceArgv,
  type RunFfmpeg,
} from '../../src/tools/imageGeneration/sdcppReferenceInput';
import {
  outputCollidesWithReference,
  resolveReferencePaths,
} from '../../src/tools/imageGeneration/generateImageToolLocal';

/**
 * Reference-input rules tested without a server, a GPU, or a port: the resize
 * rule is the highest-value, most-likely-to-regress logic in reference editing.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.from('VP8L'),
]);
// Not sniffed by mimeFromHeader at all — the HEIC case the plan refuses by name.
const HEIC = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]);

let root: string;
const tools: FfmpegTools = { ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' };

function fakeRun(
  responses: { dimensions?: { width: number; height: number }; code?: number; stderr?: string } = {},
): RunFfmpeg & { calls: { bin: string; argv: string[] }[] } {
  const calls: { bin: string; argv: string[] }[] = [];
  const run = (async (bin: string, argv: string[]) => {
    calls.push({ bin, argv });
    if (bin === 'ffprobe.exe') {
      const size = responses.dimensions ?? { width: 1280, height: 1253 };
      return {
        code: responses.code ?? 0,
        stdout: JSON.stringify({ streams: [size] }),
        stderr: responses.stderr ?? '',
      };
    }
    // Real ffmpeg writes the PNG to the output path (the last argv entry);
    // stdout carries nothing, and spawnAndWait would corrupt binary there.
    if ((responses.code ?? 0) === 0) fs.writeFileSync(argv[argv.length - 1] as string, PNG);
    return { code: responses.code ?? 0, stdout: '', stderr: responses.stderr ?? '' };
  }) as RunFfmpeg & { calls: typeof calls };
  run.calls = calls;
  return run;
}

function write(name: string, bytes: Buffer): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ref-input-')));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function sdcppConfig(overrides: Record<string, unknown> = {}): SdcppImageBackendConfig {
  const result = ImageGenerationConfigSchema.parse({
    backends: [
      {
        name: 'qwen-local',
        provider: 'sdcpp',
        binary: 'sd-server.exe',
        diffusion_model: 'diffusion.gguf',
        text_encoder: 'text-encoder.gguf',
        vae: 'vae.safetensors',
        cuda_device: 2,
        text_encoder_on_cpu: true,
        port: 8093,
        min_free_vram_mb: 7000,
        idle_timeout_ms: 61_000,
        request_timeout_ms: 1000,
        defaults: { steps: 20, cfg_scale: 6, sampler: 'euler', width: 1024, height: 1024 },
        extra_args: [],
        confirm_on_start: false,
        confirm_each: false,
        vision_encoder: 'mmproj.gguf',
        ...overrides,
      },
    ],
  });
  const backend = result.backends[0];
  if (!backend || backend.provider !== 'sdcpp') throw new Error('config did not parse as sdcpp.');
  return backend;
}

describe('reference downscale rule (A7, A27)', () => {
  it('shrinks a 1280x1253 reference to a 768 long edge with both sides divisible by 32', () => {
    const scale = computeReferenceScale(1280, 1253, 768);
    expect(scale).toBeDefined();
    const { width, height } = scale as { width: number; height: number };
    expect(Math.max(width, height)).toBeLessThanOrEqual(768);
    expect(width % DIMENSION_MULTIPLE).toBe(0);
    expect(height % DIMENSION_MULTIPLE).toBe(0);
    // Aspect kept: 1253/1280 is 0.979, so the short edge lands just under.
    expect(height).toBeLessThan(width);
  });

  it('leaves a source that already fits untouched, and never upscales', () => {
    expect(computeReferenceScale(768, 768, 768)).toBeUndefined();
    expect(computeReferenceScale(512, 288, 768)).toBeUndefined();
  });

  it('rounds a tiny source up to the multiple instead of to zero', () => {
    const scale = computeReferenceScale(1000, 40, 768) as { width: number; height: number };
    expect(scale.width % DIMENSION_MULTIPLE).toBe(0);
    expect(scale.height).toBeGreaterThanOrEqual(DIMENSION_MULTIPLE);
    expect(Math.max(scale.width, scale.height)).toBeLessThanOrEqual(768);
  });

  it('honours the configured edge rather than a literal (A27)', () => {
    // Two different configured caps must produce two different results, which a
    // hardcoded fallback inside the module could not.
    const at768 = computeReferenceScale(1536, 1536, 768) as { width: number; height: number };
    const at1536 = computeReferenceScale(2048, 2048, 1536) as { width: number; height: number };
    expect(at768.width).toBe(768);
    expect(at1536.width).toBe(1536);
  });

  it('bounds max_reference_edge_px in the schema, defaulting to 768', () => {
    expect(sdcppConfig().max_reference_edge_px).toBe(768);
    for (const edge of [255, 1537]) {
      const result = ImageGenerationConfigSchema.safeParse({
        backends: [
          {
            name: 'qwen-local',
            provider: 'sdcpp',
            binary: 'b',
            diffusion_model: 'd',
            text_encoder: 't',
            vae: 'v',
            cuda_device: 0,
            text_encoder_on_cpu: true,
            port: 8093,
            min_free_vram_mb: 1,
            idle_timeout_ms: 61_000,
            request_timeout_ms: 1000,
            defaults: { steps: 20, cfg_scale: 6, sampler: 'euler', width: 1024, height: 1024 },
            extra_args: [],
            confirm_on_start: false,
            confirm_each: false,
            max_reference_edge_px: edge,
          },
        ],
      });
      expect(result.success).toBe(false);
    }
  });

  it('builds ffmpeg argv that scales and writes a PNG file, never binary on stdout', () => {
    const argv = referenceArgv('a.jpg', { width: 768, height: 736 }, 'out.png');
    expect(argv).toContain('-nostdin');
    expect(argv).toContain('scale=768:736:flags=lanczos');
    expect(argv.slice(-4)).toEqual(['-vcodec', 'png', '-y', 'out.png']);
    expect(argv).not.toContain('-');
    expect(referenceArgv('a.jpg', undefined, 'out.png')).not.toContain('-vf');
  });
});

describe('prepareReferences validation (A8, A13, A14, A28)', () => {
  it('reports the downscale it performed (A8)', async () => {
    const file = write('sketch.jpg', JPEG);
    const run = fakeRun({ dimensions: { width: 1280, height: 1253 } });
    const prepared = await prepareReferences([file], 'qwen-local', { maxEdgePx: 768, tools, run });
    expect(prepared).toHaveLength(1);
    const entry = prepared[0] as (typeof prepared)[0];
    expect(entry.downscaled).toBe(true);
    expect(entry.sourceWidth).toBe(1280);
    expect(entry.width % DIMENSION_MULTIPLE).toBe(0);
    const [note] = describePreparedReferences(prepared);
    expect(note).toMatch(/sketch\.jpg: 1280x1253 downscaled to \d+x\d+ \(long edge cap\)/);
  });

  it('says when a reference was sent at full size (A8)', async () => {
    const file = write('small.png', PNG);
    const run = fakeRun({ dimensions: { width: 512, height: 512 } });
    const prepared = await prepareReferences([file], 'qwen-local', { maxEdgePx: 768, tools, run });
    expect(describePreparedReferences(prepared)[0]).toBe(
      `reference small.png: 512x512 sent at full size`,
    );
  });

  it('accepts a path outside the workspace (A13)', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ref-outside-'));
    try {
      const file = path.join(outside, 'upload.webp');
      fs.writeFileSync(file, WEBP);
      const prepared = await prepareReferences([file], 'qwen-local', {
        maxEdgePx: 768,
        tools,
        run: fakeRun(),
      });
      expect(prepared).toHaveLength(1);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a nonexistent path, naming the path', async () => {
    await expect(
      prepareReferences([path.join(root, 'missing.png')], 'qwen-local', {
        maxEdgePx: 768,
        tools,
        run: fakeRun(),
      }),
    ).rejects.toThrow(/qwen-local: reference image .*missing\.png.* could not be read/s);
  });

  it.each([
    ['HEIC', HEIC, 'heic'],
    ['a text file', Buffer.from('not an image at all, definitely not bytes'), 'txt'],
  ])('refuses an unsupported format (%s) before spawning anything (A14)', async (_label, bytes, name) => {
    const file = write(`bad-${name}`, bytes);
    const run = fakeRun();
    await expect(
      prepareReferences([file], 'qwen-local', { maxEdgePx: 768, tools, run }),
    ).rejects.toThrow(
      new RegExp(
        `qwen-local: generate_image refused a reference image.*Accepted formats: ${ACCEPTED_REFERENCE_FORMATS.join(', ')}`,
        's',
      ),
    );
    // Refused before any decode, so no process was spawned for it at all.
    expect(run.calls).toHaveLength(0);
  });

  it('refuses a file over the byte cap before spawning anything (A14)', async () => {
    const file = path.join(root, 'huge.png');
    const handle = fs.openSync(file, 'w');
    fs.writeSync(handle, PNG);
    fs.ftruncateSync(handle, MAX_REFERENCE_INPUT_BYTES + 1);
    fs.closeSync(handle);
    const run = fakeRun();
    await expect(
      prepareReferences([file], 'qwen-local', { maxEdgePx: 768, tools, run }),
    ).rejects.toThrow(/24 MB limit/);
    expect(run.calls).toHaveLength(0);
  });

  it('names the backend and the failing stage when ffprobe rejects the file (A14)', async () => {
    const file = write('corrupt.png', PNG);
    await expect(
      prepareReferences([file], 'qwen-local', {
        maxEdgePx: 768,
        tools,
        run: fakeRun({ code: 1, stderr: 'Invalid data found when processing input' }),
      }),
    ).rejects.toThrow(/qwen-local: ffprobe refused a reference image.*corrupt\.png/s);
  });

  // A28: the ffmpeg failure path names the stage and the exit, and a missing
  // binary surfaces as FfmpegMissingError (which already names the fix).
  it('names ffmpeg and its exit code when the decode fails (A28)', async () => {
    const file = write('sketch.jpg', JPEG);
    const run: RunFfmpeg = async (bin) =>
      bin === 'ffprobe.exe'
        ? { code: 0, stdout: JSON.stringify({ streams: [{ width: 800, height: 600 }] }), stderr: '' }
        : { code: 222, stdout: '', stderr: 'vp8: Invalid data found' };
    await expect(
      prepareReferences([file], 'qwen-local', { maxEdgePx: 768, tools, run }),
    ).rejects.toThrow(/qwen-local: ffmpeg refused a reference image.*exit 222.*Invalid data/s);
  });

  it('surfaces an unresolvable ffmpeg as FfmpegMissingError (A28)', () => {
    // Kept thin on purpose: the resolution order and its error type are owned by
    // ffmpegLocate, and this only proves the reference path reuses that one owner.
    expect(() => resolveFfmpeg(path.join(root, 'no-such-ffmpeg.exe'))).toThrow(FfmpegMissingError);
  });

  it('decodes every reference in order and keeps one ffmpeg pass each', async () => {
    const a = write('a.jpg', JPEG);
    const b = write('b.png', PNG);
    const run = fakeRun();
    const prepared = await prepareReferences([a, b], 'qwen-local', { maxEdgePx: 768, tools, run });
    expect(prepared.map((entry) => path.basename(entry.sourcePath))).toEqual(['a.jpg', 'b.png']);
    expect(run.calls.filter((call) => call.bin === 'ffmpeg.exe')).toHaveLength(2);
  });

  it('sends the exact bytes ffmpeg wrote and removes its scratch file', async () => {
    // The encode used to be read back from stdout, which spawnAndWait decodes
    // as UTF-8 and caps — every real PNG arrived corrupted. Byte equality here
    // is the regression guard.
    const file = write('sketch.jpg', JPEG);
    const run = fakeRun();
    const [entry] = await prepareReferences([file], 'qwen-local', { maxEdgePx: 768, tools, run });
    expect(Buffer.from(entry?.base64 ?? '', 'base64')).toEqual(PNG);
    const ffmpegCall = run.calls.find((call) => call.bin === 'ffmpeg.exe');
    const output = ffmpegCall?.argv[ffmpegCall.argv.length - 1] as string;
    expect(fs.existsSync(path.dirname(output))).toBe(false);
  });

  it('names a directory as a directory, before spawning anything', async () => {
    const dir = path.join(root, 'photos');
    fs.mkdirSync(dir);
    const run = fakeRun();
    await expect(
      prepareReferences([dir], 'qwen-local', { maxEdgePx: 768, tools, run }),
    ).rejects.toThrow(/reference image .*photos" is a directory/s);
    expect(run.calls).toHaveLength(0);
  });
});

describe('reference path rules (A9, A24)', () => {
  it('refuses more than 4 distinct references with a named reason (A9)', () => {
    const paths = ['a', 'b', 'c', 'd', 'e'].map((name) => path.join(root, name));
    expect(() => resolveReferencePaths(paths, sdcppConfig(), root)).toThrow(
      /at most 4 reference images; 5 distinct paths were given/,
    );
  });

  it('de-duplicates case-insensitively and says so (A24)', () => {
    const { paths, note } = resolveReferencePaths(
      [path.join(root, 'Sketch.JPG'), path.join(root, 'sketch.jpg'), path.join(root, 'other.png')],
      sdcppConfig(),
      root,
    );
    expect(paths).toHaveLength(2);
    expect(note).toBe('2 reference image(s), 1 duplicate path removed.');
  });

  it('applies the cap after de-duplication (A24)', () => {
    const five = [
      path.join(root, 'a.png'),
      path.join(root, 'A.PNG'),
      path.join(root, 'b.png'),
      path.join(root, 'c.png'),
      path.join(root, 'd.png'),
    ];
    const { paths } = resolveReferencePaths(five, sdcppConfig(), root);
    expect(paths).toHaveLength(4);
    expect(() => resolveReferencePaths([...five, path.join(root, 'e.png')], sdcppConfig(), root)).toThrow(
      /at most 4 reference images/,
    );
  });

  it('refuses an output that resolves to a reference, case-insensitively (A22)', () => {
    const reference = path.join(root, 'Sketch.JPG');
    expect(outputCollidesWithReference(path.join(root, 'sketch.png'), [reference])).toBe(reference);
    expect(outputCollidesWithReference(path.join(root, 'other.png'), [reference])).toBeUndefined();
    // A path with no extension at all still collides.
    expect(outputCollidesWithReference(path.join(root, 'sketch'), [reference])).toBe(reference);
  });
});
