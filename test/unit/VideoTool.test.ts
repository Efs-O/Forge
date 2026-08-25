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
  applyRequestedFrameCap,
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

describe('applyRequestedFrameCap', () => {
  it('lets the model lower the cap', () => {
    expect(applyRequestedFrameCap(VIDEO_DEFAULTS, 3).maxFrames).toBe(3);
  });

  it('never lets the model raise it past the configured limit', () => {
    expect(applyRequestedFrameCap(VIDEO_DEFAULTS, 40).maxFrames).toBe(VIDEO_DEFAULTS.maxFrames);
  });

  it('ignores absent or nonsensical values', () => {
    expect(applyRequestedFrameCap(VIDEO_DEFAULTS, undefined)).toEqual(VIDEO_DEFAULTS);
    expect(applyRequestedFrameCap(VIDEO_DEFAULTS, 0)).toEqual(VIDEO_DEFAULTS);
    expect(applyRequestedFrameCap(VIDEO_DEFAULTS, -5)).toEqual(VIDEO_DEFAULTS);
    expect(applyRequestedFrameCap(VIDEO_DEFAULTS, 'lots')).toEqual(VIDEO_DEFAULTS);
    expect(applyRequestedFrameCap(VIDEO_DEFAULTS, Number.NaN)).toEqual(VIDEO_DEFAULTS);
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
