import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

const resolveFfmpeg = vi.fn();
const probeVideo = vi.fn();
const extractFrames = vi.fn();

vi.mock('../../src/tools/videoExtract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/videoExtract')>();
  return {
    ...actual,
    resolveFfmpeg: (...args: unknown[]) => resolveFfmpeg(...args),
    probeVideo: (...args: unknown[]) => probeVideo(...args),
    extractFrames: (...args: unknown[]) => extractFrames(...args),
  };
});

import {
  applyRequestedDimension,
  applyRequestedFrameCount,
  applyRequestedWindow,
  makeViewVideoTool,
  resolveVideoOptions,
  summaryLine,
  videoUnavailableMessage,
  VIDEO_DEFAULTS,
} from '../../src/tools/videoTool';

let root: string;

function setWorkspace(folder: string): void {
  const workspace = vscode.workspace as unknown as {
    workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
  };
  workspace.workspaceFolders = [{ uri: { fsPath: folder } }];
}

const PROBE = { durationSeconds: 5, width: 1920, height: 1088, hasAudio: true };

function writeClip(relative: string): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'not really a video, ffmpeg is mocked');
  return target;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-view-video-')));
  setWorkspace(root);
  resolveFfmpeg.mockReturnValue({ ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' });
  probeVideo.mockResolvedValue(PROBE);
  extractFrames.mockResolvedValue({
    probe: PROBE,
    frames: [
      { jpegBase64: 'AAA', timeSeconds: 0.833 },
      { jpegBase64: 'BBB', timeSeconds: 2.5 },
      { jpegBase64: 'CCC', timeSeconds: 4.166 },
    ],
  });
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('view_video handler', () => {
  it('returns a labelled frame sequence as multimodal content', async () => {
    writeClip('clips/ss01.mp4');
    const result = await makeViewVideoTool().handler({ path: 'clips/ss01.mp4' });

    if (typeof result === 'string') throw new Error('expected multimodal result');
    expect(result.content).toHaveLength(7); // summary + 3 x (label, image)
    expect(result.content[0]).toEqual({ type: 'text', text: result.text });
    expect(result.content[1]).toEqual({ type: 'text', text: 'Frame 1 of 3 — t=0.8s' });
    expect(result.content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,AAA' },
    });
    expect(result.content[5]).toEqual({ type: 'text', text: 'Frame 3 of 3 — t=4.2s' });
  });

  it('interleaves a label before every frame, in time order', async () => {
    writeClip('clips/ss01.mp4');
    const result = await makeViewVideoTool().handler({ path: 'clips/ss01.mp4' });
    if (typeof result === 'string') throw new Error('expected multimodal result');

    const kinds = result.content.map((part) => part.type);
    expect(kinds).toEqual([
      'text',
      'text',
      'image_url',
      'text',
      'image_url',
      'text',
      'image_url',
    ]);
  });

  it('tells the model these are stills, not motion, and carry no audio', async () => {
    writeClip('clips/ss01.mp4');
    const result = await makeViewVideoTool().handler({ path: 'clips/ss01.mp4' });
    if (typeof result === 'string') throw new Error('expected multimodal result');
    expect(result.text).toMatch(/stills, not motion/);
    expect(result.text).toMatch(/no audio/);
  });

  it('rejects paths outside the workspace', async () => {
    await expect(
      makeViewVideoTool().handler({ path: path.join(root, '..', 'outside.mp4') }),
    ).rejects.toThrow(/outside the workspace/);
    expect(probeVideo).not.toHaveBeenCalled();
  });

  it('rejects a non-video extension before spawning anything', async () => {
    writeClip('notes.txt');
    await expect(makeViewVideoTool().handler({ path: 'notes.txt' })).rejects.toThrow(
      /not a supported video container/,
    );
    expect(resolveFfmpeg).not.toHaveBeenCalled();
  });

  it('rejects an empty path', async () => {
    await expect(makeViewVideoTool().handler({ path: '   ' })).rejects.toThrow(/non-empty string/);
  });

  it('passes the configured ffmpeg path through to discovery', async () => {
    writeClip('clips/ss01.mp4');
    await makeViewVideoTool(() => ({ ffmpeg_path: '/opt/ffmpeg/ffmpeg' })).handler({
      path: 'clips/ss01.mp4',
    });
    expect(resolveFfmpeg).toHaveBeenCalledWith('/opt/ffmpeg/ffmpeg');
  });

  it('reads config at call time so a reload takes effect', async () => {
    writeClip('clips/ss01.mp4');
    let dimension = 640;
    const tool = makeViewVideoTool(() => ({ frame_max_dimension: dimension }));

    await tool.handler({ path: 'clips/ss01.mp4' });
    expect(extractFrames.mock.calls[0]?.[3]).toMatchObject({ frameMaxDimension: 640 });

    dimension = 384;
    await tool.handler({ path: 'clips/ss01.mp4' });
    expect(extractFrames.mock.calls[1]?.[3]).toMatchObject({ frameMaxDimension: 384 });
  });

  it('threads the caller abort signal into probe and extraction', async () => {
    writeClip('clips/ss01.mp4');
    const controller = new AbortController();
    await makeViewVideoTool().handler(
      { path: 'clips/ss01.mp4' },
      { beforeMutate: () => undefined, abortSignal: controller.signal },
    );
    expect(probeVideo.mock.calls[0]?.[2]).toBe(controller.signal);
    expect(extractFrames.mock.calls[0]?.[4]).toBe(controller.signal);
  });

  it('is a read tool, like view_image', () => {
    expect(makeViewVideoTool().permission).toBe('read');
  });
});

describe('resolveVideoOptions', () => {
  it('falls back to the documented defaults when the block is absent', () => {
    expect(resolveVideoOptions(undefined)).toEqual(VIDEO_DEFAULTS);
  });

  it('overrides only the fields the user set', () => {
    expect(resolveVideoOptions({ frame_max_dimension: 384 })).toEqual({
      ...VIDEO_DEFAULTS,
      frameMaxDimension: 384,
    });
  });
});

describe('applyRequestedFrameCount', () => {
  it('records the request without touching the configured ceiling', () => {
    const applied = applyRequestedFrameCount(VIDEO_DEFAULTS, 6);
    expect(applied.requestedFrames).toBe(6);
    expect(applied.maxFrames).toBe(VIDEO_DEFAULTS.maxFrames);
  });

  it('records a request above the ceiling; frameCountFor clamps it', () => {
    expect(applyRequestedFrameCount(VIDEO_DEFAULTS, 40).requestedFrames).toBe(40);
    expect(applyRequestedFrameCount(VIDEO_DEFAULTS, 40).maxFrames).toBe(VIDEO_DEFAULTS.maxFrames);
  });

  it('ignores absent or nonsensical values', () => {
    expect(applyRequestedFrameCount(VIDEO_DEFAULTS, undefined)).toEqual(VIDEO_DEFAULTS);
    expect(applyRequestedFrameCount(VIDEO_DEFAULTS, 0)).toEqual(VIDEO_DEFAULTS);
    expect(applyRequestedFrameCount(VIDEO_DEFAULTS, -5)).toEqual(VIDEO_DEFAULTS);
    expect(applyRequestedFrameCount(VIDEO_DEFAULTS, 'lots')).toEqual(VIDEO_DEFAULTS);
    expect(applyRequestedFrameCount(VIDEO_DEFAULTS, Number.NaN)).toEqual(VIDEO_DEFAULTS);
  });
});

describe('summaryLine', () => {
  it('states length, resolution and every sample time', () => {
    const line = summaryLine('clips/a.mp4', PROBE, [0.8, 2.5, 4.2]);
    expect(line).toContain('5.0s');
    expect(line).toContain('1920x1088');
    expect(line).toContain('0.8s, 2.5s, 4.2s');
    expect(line).toContain('3 still frames');
  });

  it('does not say "1 still frames"', () => {
    expect(summaryLine('clips/a.mp4', PROBE, [2.5])).toContain('1 still frame sampled');
  });
});

describe('videoUnavailableMessage', () => {
  it('names the sanctioned alternative instead of refusing bare', () => {
    const message = videoUnavailableMessage('qwen3.8-27b-text');
    expect(message).toContain('mmproj_path');
    expect(message).toContain('vision-capable model');
    expect(message).toMatch(/Do not try to read the video with another tool/);
  });
});

describe('max_frames reaches ffmpeg (regression: the 11s clip that always gave 3)', () => {
  it('passes the requested count through to extraction', async () => {
    writeClip('clips/ss01.mp4');
    await makeViewVideoTool().handler({ path: 'clips/ss01.mp4', max_frames: 10 });
    expect(extractFrames.mock.calls[0]?.[3]).toMatchObject({
      requestedFrames: 10,
      maxFrames: VIDEO_DEFAULTS.maxFrames,
    });
  });

  it('leaves requestedFrames unset when the caller does not ask', async () => {
    writeClip('clips/ss01.mp4');
    await makeViewVideoTool().handler({ path: 'clips/ss01.mp4' });
    const options = extractFrames.mock.calls[0]?.[3] as { requestedFrames?: number };
    expect(options.requestedFrames).toBeUndefined();
  });

  it('explains the ceiling when it clipped the request, instead of leaving it to guess', () => {
    const line = summaryLine('clips/a.mp4', PROBE, [0.8, 2.5, 4.2], {
      ...VIDEO_DEFAULTS,
      maxFrames: 3,
      requestedFrames: 10,
    });
    expect(line).toContain('You asked for 10');
    expect(line).toContain('video.max_frames');
  });

  it('says the count came from clip length when nothing was requested', () => {
    const line = summaryLine('clips/a.mp4', PROBE, [0.8, 2.5, 4.2], VIDEO_DEFAULTS);
    expect(line).toContain('chosen from the clip length');
    expect(line).toContain('max_frames');
  });

  it('stays quiet when the request was honoured exactly', () => {
    const line = summaryLine('clips/a.mp4', PROBE, [0.8, 2.5, 4.2], {
      ...VIDEO_DEFAULTS,
      requestedFrames: 3,
    });
    expect(line).not.toContain('You asked for');
    expect(line).not.toContain('chosen from the clip length');
  });
});

describe('per-call ffmpeg overrides', () => {
  it('advertises the three tunable knobs', () => {
    const params = makeViewVideoTool().definition.function.parameters as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(params.properties).sort()).toEqual([
      'end_seconds',
      'frame_max_dimension',
      'max_frames',
      'path',
      'start_seconds',
    ]);
  });

  it('passes a raised resolution through to extraction', async () => {
    writeClip('clips/ss01.mp4');
    await makeViewVideoTool().handler({ path: 'clips/ss01.mp4', frame_max_dimension: 1024 });
    expect(extractFrames.mock.calls[0]?.[3]).toMatchObject({ frameMaxDimension: 1024 });
  });

  it('clamps an absurd resolution instead of failing the call', () => {
    expect(applyRequestedDimension(VIDEO_DEFAULTS, 99999).frameMaxDimension).toBe(4096);
    expect(applyRequestedDimension(VIDEO_DEFAULTS, 1).frameMaxDimension).toBe(64);
  });

  it('ignores a non-numeric resolution', () => {
    expect(applyRequestedDimension(VIDEO_DEFAULTS, 'big')).toEqual(VIDEO_DEFAULTS);
    expect(applyRequestedDimension(VIDEO_DEFAULTS, undefined)).toEqual(VIDEO_DEFAULTS);
  });

  it('passes a time window through to extraction', async () => {
    writeClip('clips/ss01.mp4');
    await makeViewVideoTool().handler({
      path: 'clips/ss01.mp4',
      start_seconds: 8,
      end_seconds: 11,
    });
    expect(extractFrames.mock.calls[0]?.[3]).toMatchObject({ startSeconds: 8, endSeconds: 11 });
  });

  it('accepts a start with no end', () => {
    expect(applyRequestedWindow(VIDEO_DEFAULTS, 4, undefined)).toMatchObject({ startSeconds: 4 });
    expect(applyRequestedWindow(VIDEO_DEFAULTS, 4, undefined).endSeconds).toBeUndefined();
  });

  it('ignores non-numeric window values', () => {
    expect(applyRequestedWindow(VIDEO_DEFAULTS, 'start', 'end')).toEqual(VIDEO_DEFAULTS);
  });

  it('combines all three overrides in one call', async () => {
    writeClip('clips/ss01.mp4');
    await makeViewVideoTool().handler({
      path: 'clips/ss01.mp4',
      max_frames: 12,
      frame_max_dimension: 1024,
      start_seconds: 2,
      end_seconds: 9,
    });
    expect(extractFrames.mock.calls[0]?.[3]).toMatchObject({
      requestedFrames: 12,
      frameMaxDimension: 1024,
      startSeconds: 2,
      endSeconds: 9,
    });
  });

  it('says in the summary that only part of the clip was sampled', () => {
    const line = summaryLine('clips/a.mp4', PROBE, [4.2, 4.6], {
      ...VIDEO_DEFAULTS,
      startSeconds: 4,
      endSeconds: 5,
    });
    expect(line).toContain('Sampled only 4.0s-5.0s of the clip, not all of it.');
  });

  it('stays quiet about the window when the whole clip was sampled', () => {
    const line = summaryLine('clips/a.mp4', PROBE, [0.8, 2.5, 4.2], VIDEO_DEFAULTS);
    expect(line).not.toContain('Sampled only');
  });

  it('defaults the frame ceiling to 26', () => {
    expect(VIDEO_DEFAULTS.maxFrames).toBe(26);
  });
});
