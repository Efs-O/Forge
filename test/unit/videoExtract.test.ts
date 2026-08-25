import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  computeScale,
  extractFrames,
  FfmpegMissingError,
  frameArgv,
  frameCountFor,
  frameTimes,
  MAX_VIDEO_FRAMES_BYTES,
  probeVideo,
  resolveFfmpeg,
  tailOf,
  type FfmpegTools,
  type RunFfmpeg,
  type VideoOptions,
  type VideoProbe,
} from '../../src/tools/videoExtract';

const EXE = process.platform === 'win32' ? '.exe' : '';
const tempDirs: string[] = [];

function makeFakeInstall(options: { ffprobe?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ffmpeg-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, `ffmpeg${EXE}`), '');
  if (options.ffprobe !== false) fs.writeFileSync(path.join(dir, `ffprobe${EXE}`), '');
  return dir;
}

/** Records every invocation so tests can assert on argv, the real contract. */
function fakeRunner(
  reply: { code?: number; stdout?: string; stderr?: string } = {},
): RunFfmpeg & { calls: { bin: string; argv: string[] }[] } {
  const calls: { bin: string; argv: string[] }[] = [];
  const run = (async (bin: string, argv: string[]) => {
    calls.push({ bin, argv });
    return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
  }) as RunFfmpeg & { calls: { bin: string; argv: string[] }[] };
  run.calls = calls;
  return run;
}

const TOOLS: FfmpegTools = { ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveFfmpeg', () => {
  it('prefers an explicitly configured path over PATH', () => {
    const configured = makeFakeInstall();
    const onPath = makeFakeInstall();
    const previous = process.env['PATH'];
    process.env['PATH'] = onPath;
    try {
      const resolved = resolveFfmpeg(path.join(configured, `ffmpeg${EXE}`));
      expect(resolved.ffmpeg).toBe(path.join(configured, `ffmpeg${EXE}`));
      expect(resolved.ffprobe).toBe(path.join(configured, `ffprobe${EXE}`));
    } finally {
      process.env['PATH'] = previous;
    }
  });

  it('falls back to PATH when no path is configured', () => {
    const dir = makeFakeInstall();
    const previous = process.env['PATH'];
    process.env['PATH'] = dir;
    try {
      expect(resolveFfmpeg().ffmpeg).toBe(path.join(dir, `ffmpeg${EXE}`));
      expect(resolveFfmpeg('').ffmpeg).toBe(path.join(dir, `ffmpeg${EXE}`));
    } finally {
      process.env['PATH'] = previous;
    }
  });

  it('rejects a configured path that does not exist', () => {
    expect(() => resolveFfmpeg(path.join(os.tmpdir(), 'forge-no-such-ffmpeg'))).toThrow(
      FfmpegMissingError,
    );
  });

  it('rejects an ffmpeg with no ffprobe beside it', () => {
    const dir = makeFakeInstall({ ffprobe: false });
    expect(() => resolveFfmpeg(path.join(dir, `ffmpeg${EXE}`))).toThrow(FfmpegMissingError);
  });

  it('skips a PATH entry whose ffmpeg has no sibling ffprobe', () => {
    const broken = makeFakeInstall({ ffprobe: false });
    const good = makeFakeInstall();
    const previous = process.env['PATH'];
    process.env['PATH'] = [broken, good].join(path.delimiter);
    try {
      expect(resolveFfmpeg().ffmpeg).toBe(path.join(good, `ffmpeg${EXE}`));
    } finally {
      process.env['PATH'] = previous;
    }
  });

  it('throws the typed error when ffmpeg is nowhere, and names the fix', () => {
    const previous = process.env['PATH'];
    const previousLocal = process.env['LOCALAPPDATA'];
    process.env['PATH'] = path.join(os.tmpdir(), 'forge-empty-path-dir');
    process.env['LOCALAPPDATA'] = path.join(os.tmpdir(), 'forge-empty-localappdata');
    try {
      expect(() => resolveFfmpeg()).toThrow(FfmpegMissingError);
      expect(() => resolveFfmpeg()).toThrow(/video\.ffmpeg_path/);
    } finally {
      process.env['PATH'] = previous;
      if (previousLocal === undefined) delete process.env['LOCALAPPDATA'];
      else process.env['LOCALAPPDATA'] = previousLocal;
    }
  });
});

describe('probeVideo', () => {
  const videoAndAudio = JSON.stringify({
    streams: [
      { codec_type: 'video', width: 1920, height: 1088, duration: '5.041000' },
      { codec_type: 'audio' },
    ],
    format: { duration: '5.045000' },
  });

  it('asks ffprobe for JSON, not a stderr banner', async () => {
    const run = fakeRunner({ stdout: videoAndAudio });
    await probeVideo(TOOLS, '/clips/ss01.mp4', undefined, run);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.bin).toBe('/fake/ffprobe');
    expect(run.calls[0]?.argv).toContain('-of');
    expect(run.calls[0]?.argv).toContain('json');
    expect(run.calls[0]?.argv.at(-1)).toBe('/clips/ss01.mp4');
  });

  it('reads dimensions, duration and audio presence in one call', async () => {
    const probe = await probeVideo(TOOLS, '/clips/ss01.mp4', undefined, fakeRunner({ stdout: videoAndAudio }));
    expect(probe).toEqual({
      durationSeconds: 5.045,
      width: 1920,
      height: 1088,
      hasAudio: true,
    });
  });

  it('reports hasAudio false when the container carries no audio stream', async () => {
    const stdout = JSON.stringify({
      streams: [{ codec_type: 'video', width: 640, height: 360 }],
      format: { duration: '3.900000' },
    });
    const probe = await probeVideo(TOOLS, '/clips/mute.mp4', undefined, fakeRunner({ stdout }));
    expect(probe.hasAudio).toBe(false);
    expect(probe.durationSeconds).toBeCloseTo(3.9);
  });

  it('prefers container duration, which MP4 streams routinely omit', async () => {
    const stdout = JSON.stringify({
      streams: [{ codec_type: 'video', width: 640, height: 360 }],
      format: { duration: '7.200000' },
    });
    const probe = await probeVideo(TOOLS, '/clips/a.mp4', undefined, fakeRunner({ stdout }));
    expect(probe.durationSeconds).toBeCloseTo(7.2);
  });

  it('falls back to stream duration when the container has none', async () => {
    const stdout = JSON.stringify({
      streams: [{ codec_type: 'video', width: 640, height: 360, duration: '2.500000' }],
      format: {},
    });
    const probe = await probeVideo(TOOLS, '/clips/a.mkv', undefined, fakeRunner({ stdout }));
    expect(probe.durationSeconds).toBeCloseTo(2.5);
  });

  it('refuses a file with no video stream and points at view_image', async () => {
    const stdout = JSON.stringify({
      streams: [{ codec_type: 'audio' }],
      format: { duration: '5.0' },
    });
    await expect(probeVideo(TOOLS, '/clips/a.wav', undefined, fakeRunner({ stdout }))).rejects.toThrow(
      /view_image/,
    );
  });

  it('surfaces a non-zero ffprobe exit rather than swallowing it', async () => {
    const run = fakeRunner({ code: 1, stderr: 'Invalid data found when processing input' });
    await expect(probeVideo(TOOLS, '/clips/notes.txt', undefined, run)).rejects.toThrow(
      /Invalid data found/,
    );
  });

  it('rejects unparseable ffprobe output instead of guessing', async () => {
    await expect(
      probeVideo(TOOLS, '/clips/a.mp4', undefined, fakeRunner({ stdout: 'not json' })),
    ).rejects.toThrow(/not JSON/);
  });

  it('rejects a clip whose duration cannot be determined', async () => {
    const stdout = JSON.stringify({
      streams: [{ codec_type: 'video', width: 640, height: 360 }],
      format: {},
    });
    await expect(probeVideo(TOOLS, '/clips/trunc.mp4', undefined, fakeRunner({ stdout }))).rejects.toThrow(
      /duration/,
    );
  });
});

describe('tailOf', () => {
  it('returns short stderr unchanged', () => {
    expect(tailOf('  boom  ')).toBe('boom');
  });

  it('keeps the tail, which is where ffmpeg puts the actual error', () => {
    const long = `${'x'.repeat(500)}THE-REAL-ERROR`;
    const tail = tailOf(long, 100);
    expect(tail).toContain('THE-REAL-ERROR');
    expect(tail.length).toBeLessThanOrEqual(101);
  });
});

describe('frameCountFor', () => {
  it('scales with duration', () => {
    expect(frameCountFor(5, 8)).toBe(3);
    expect(frameCountFor(20, 8)).toBe(4);
    expect(frameCountFor(30, 8)).toBe(6);
  });

  it('never drops below the minimum for a very short clip', () => {
    expect(frameCountFor(1, 8)).toBe(3);
    expect(frameCountFor(0.4, 8)).toBe(3);
  });

  it('honours the cap, including a cap below the minimum', () => {
    expect(frameCountFor(300, 8)).toBe(8);
    expect(frameCountFor(300, 2)).toBe(2);
    expect(frameCountFor(1, 1)).toBe(1);
  });
});

describe('frameTimes', () => {
  it('samples slice centres, not boundaries', () => {
    expect(frameTimes(10, 4)).toEqual([1.25, 3.75, 6.25, 8.75]);
  });

  it('never lands on the very first or very last instant', () => {
    const times = frameTimes(6, 3);
    expect(times[0]).toBeGreaterThan(0);
    expect(times.at(-1)).toBeLessThan(6);
  });

  it('clamps against the end guard on a clip shorter than the guard', () => {
    for (const time of frameTimes(0.1, 3)) {
      expect(time).toBeGreaterThanOrEqual(0);
      expect(time).toBeLessThanOrEqual(0.1);
    }
  });

  it('returns times in ascending order', () => {
    const times = frameTimes(11, 5);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('computeScale', () => {
  it('leaves a source that already fits alone', () => {
    expect(computeScale(568, 320, 640)).toBeUndefined();
    expect(computeScale(640, 360, 640)).toBeUndefined();
  });

  it('fits the longest edge to the cap, preserving aspect', () => {
    expect(computeScale(1920, 1088, 640)).toEqual({ width: 640, height: 362 });
  });

  it('scales portrait video by its height', () => {
    expect(computeScale(1080, 1920, 640)).toEqual({ width: 360, height: 640 });
  });

  it('produces even dimensions', () => {
    const scaled = computeScale(1920, 1088, 384);
    expect(scaled?.width ?? 0).toBe(384);
    expect((scaled?.height ?? 1) % 2).toBe(0);
  });
});

const OPTIONS: VideoOptions = {
  maxFrames: 8,
  frameMaxDimension: 640,
  frameQuality: 3,
  maxDurationSeconds: 30,
};

const PROBE_HD: VideoProbe = {
  durationSeconds: 5,
  width: 1920,
  height: 1088,
  hasAudio: true,
};

describe('frameArgv', () => {
  it('seeks before the input so ffmpeg jumps instead of decoding forward', () => {
    const argv = frameArgv('/clips/a.mp4', 1.25, '/tmp/f.jpg', PROBE_HD, OPTIONS);
    expect(argv.indexOf('-ss')).toBeLessThan(argv.indexOf('-i'));
    expect(argv[argv.indexOf('-ss') + 1]).toBe('1.250');
  });

  it('never inherits stdin, the shape behind the upstream Windows hang', () => {
    expect(frameArgv('/clips/a.mp4', 1, '/tmp/f.jpg', PROBE_HD, OPTIONS)).toContain('-nostdin');
  });

  it('passes the configured quality and writes a single frame', () => {
    const argv = frameArgv('/clips/a.mp4', 1, '/tmp/f.jpg', PROBE_HD, {
      ...OPTIONS,
      frameQuality: 5,
    });
    expect(argv[argv.indexOf('-q:v') + 1]).toBe('5');
    expect(argv[argv.indexOf('-frames:v') + 1]).toBe('1');
    expect(argv.at(-1)).toBe('/tmp/f.jpg');
  });

  it('downscales to the configured dimension', () => {
    const argv = frameArgv('/clips/a.mp4', 1, '/tmp/f.jpg', PROBE_HD, OPTIONS);
    expect(argv[argv.indexOf('-vf') + 1]).toBe('scale=640:362:flags=lanczos');
  });

  it('omits the scale filter entirely when the source already fits', () => {
    const small: VideoProbe = { durationSeconds: 4, width: 568, height: 320, hasAudio: false };
    expect(frameArgv('/clips/a.mp4', 1, '/tmp/f.jpg', small, OPTIONS)).not.toContain('-vf');
  });
});

/** Runner that also writes the JPEG ffmpeg would have written. */
function fakeFrameRunner(
  bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb]),
): RunFfmpeg & { calls: { bin: string; argv: string[] }[] } {
  const calls: { bin: string; argv: string[] }[] = [];
  const run = (async (bin: string, argv: string[]) => {
    calls.push({ bin, argv });
    fs.writeFileSync(String(argv.at(-1)), bytes);
    return { code: 0, stdout: '', stderr: '' };
  }) as RunFfmpeg & { calls: { bin: string; argv: string[] }[] };
  run.calls = calls;
  return run;
}

describe('extractFrames', () => {
  it('returns ordered frames with their timestamps', async () => {
    const result = await extractFrames(
      TOOLS,
      '/clips/a.mp4',
      PROBE_HD,
      OPTIONS,
      undefined,
      fakeFrameRunner(),
    );
    expect(result.frames).toHaveLength(3);
    expect(result.frames.map((frame) => frame.timeSeconds)).toEqual(frameTimes(5, 3));
    expect(result.frames[0]?.jpegBase64).toBe(Buffer.from([0xff, 0xd8, 0xff, 0xdb]).toString('base64'));
    expect(result.probe).toBe(PROBE_HD);
  });

  it('honours a lowered max_frames', async () => {
    const probe: VideoProbe = { ...PROBE_HD, durationSeconds: 30 };
    const result = await extractFrames(
      TOOLS,
      '/clips/a.mp4',
      probe,
      { ...OPTIONS, maxFrames: 2 },
      undefined,
      fakeFrameRunner(),
    );
    expect(result.frames).toHaveLength(2);
  });

  it('removes the temp directory after success', async () => {
    const run = fakeFrameRunner();
    await extractFrames(TOOLS, '/clips/a.mp4', PROBE_HD, OPTIONS, undefined, run);
    const dir = path.dirname(String(run.calls[0]?.argv.at(-1)));
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes the temp directory after failure too', async () => {
    let dir = '';
    const run: RunFfmpeg = async (_bin, argv) => {
      dir = path.dirname(String(argv.at(-1)));
      return { code: 1, stdout: '', stderr: 'decoder blew up' };
    };
    await expect(
      extractFrames(TOOLS, '/clips/a.mp4', PROBE_HD, OPTIONS, undefined, run),
    ).rejects.toThrow(/decoder blew up/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('rejects a clip longer than the configured limit, and says how to change it', async () => {
    const probe: VideoProbe = { ...PROBE_HD, durationSeconds: 120 };
    await expect(
      extractFrames(TOOLS, '/clips/long.mp4', probe, OPTIONS, undefined, fakeFrameRunner()),
    ).rejects.toThrow(/max_duration_seconds/);
  });

  it('propagates the abort signal to every ffmpeg call', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const controller = new AbortController();
    const run: RunFfmpeg = async (_bin, argv, opts) => {
      seen.push(opts.signal);
      fs.writeFileSync(String(argv.at(-1)), Buffer.from([0xff, 0xd8]));
      return { code: 0, stdout: '', stderr: '' };
    };
    await extractFrames(TOOLS, '/clips/a.mp4', PROBE_HD, OPTIONS, controller.signal, run);
    expect(seen).toHaveLength(3);
    expect(seen.every((signal) => signal === controller.signal)).toBe(true);
  });

  it('fails loudly rather than returning a truncated frame set', async () => {
    const huge = Buffer.alloc(MAX_VIDEO_FRAMES_BYTES + 1);
    await expect(
      extractFrames(TOOLS, '/clips/a.mp4', PROBE_HD, OPTIONS, undefined, fakeFrameRunner(huge)),
    ).rejects.toThrow(/frame_max_dimension/);
  });

  it('reports a silent ffmpeg that exits zero without writing a frame', async () => {
    const run: RunFfmpeg = async () => ({ code: 0, stdout: '', stderr: '' });
    await expect(
      extractFrames(TOOLS, '/clips/a.mp4', PROBE_HD, OPTIONS, undefined, run),
    ).rejects.toThrow(/wrote no frame/);
  });
});
