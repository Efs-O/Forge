import { describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import { MediaConfigSchema } from '../../src/config/mediaSchema';
import { checkMediaSetup } from '../../src/media/mediaSetupCheck';
import { defaultVideoEngineMessage, resolveVideoEngine } from '../../src/tools/media/mediaEngineSetup';

const validFfmpeg = () => ({
  ffmpeg: 'C:/tools/ffmpeg.exe',
  ffprobe: 'C:/tools/ffprobe.exe',
});

function emptyEnginesConfig() {
  return MediaConfigSchema.parse({
    enabled: true,
    video: {
      engines: [
        { id: 'ltx25', kind: 'ltx25' },
        { id: 'h3', kind: 'comfyui_workflow' },
      ],
    },
    music: {
      analyzer: { kind: 'flamingo_dlt', launcher: '' },
      engines: [
        { id: 'ace_step', kind: 'ace_standalone' },
        { id: 'stable_audio', kind: 'comfyui_sa3' },
      ],
    },
  });
}

describe('MediaConfigSchema', () => {
  it('defaults the optional media block to disabled when present', () => {
    const config = MediaConfigSchema.parse({});

    expect(config.enabled).toBe(false);
    expect(config.output_dir).toBe('media');
    expect(config.comfyui.port).toBe(8190);
    expect(config.video.default_size).toEqual([1344, 768]);
    expect(config.music.analyzer.launcher).toBe('');
  });

  it('rejects unknown keys and duplicate engine ids', () => {
    expect(MediaConfigSchema.safeParse({ surprise: true }).success).toBe(false);
    const duplicate = MediaConfigSchema.safeParse({
      video: {
        engines: [
          { id: 'same', kind: 'ltx25' },
          { id: 'same', kind: 'ltx25' },
        ],
      },
    });
    expect(duplicate.success).toBe(false);
  });

  it('requires LTX dimensions to match its 64-pixel grid', () => {
    expect(MediaConfigSchema.safeParse({ video: { default_size: [1360, 768] } }).success).toBe(
      false,
    );
  });
});

describe('checkMediaSetup', () => {
  it('names every unset engine field and explains optional text-to-video and analysis gaps', () => {
    const report = checkMediaSetup(emptyEnginesConfig(), 'C:/workspace', {
      inspectPath: () => true,
      resolveFfmpeg: vi.fn(validFfmpeg),
    });

    for (const key of [
      'media.comfyui.root',
      'media.comfyui.python',
      'media.video.engines[0].models.diffusion',
      'media.video.engines[0].models.video_vae',
      'media.video.engines[0].models.audio_vae',
      'media.video.engines[0].models.text_encoder',
      'media.video.engines[0].models.latent_upscaler',
      'media.video.engines[1].workflow',
      'media.music.engines[0].root',
      'media.music.engines[0].checkpoints',
      'media.music.engines[1].checkpoint',
      'media.music.engines[1].text_encoder',
      'media.music.analyzer.launcher',
      'media.video.still_backend',
    ]) {
      expect(report.text).toContain(`missing ${key}`);
    }
    expect(report.enabled).toBe(true);
  });

  it('reports resolved paths when configured files or folders are absent', () => {
    const workspaceRoot = path.resolve('media-setup-test');
    const comfyRoot = path.join(workspaceRoot, 'ComfyUI');
    const ltxModel = path.join(workspaceRoot, 'models', 'ltx.gguf');
    const analyzerLauncher = path.join(workspaceRoot, 'Flamingo', 'Start-DLT.ps1');
    const media = MediaConfigSchema.parse({
      enabled: true,
      comfyui: { root: comfyRoot, python: path.join(comfyRoot, '.venv', 'Scripts', 'python.exe') },
      video: {
        still_backend: 'sd-local',
        engines: [
          {
            id: 'ltx25',
            kind: 'ltx25',
            models: {
              diffusion: ltxModel,
              video_vae: path.join(workspaceRoot, 'models', 'video.safetensors'),
              audio_vae: path.join(workspaceRoot, 'models', 'audio.safetensors'),
              text_encoder: path.join(workspaceRoot, 'models', 'text.safetensors'),
              latent_upscaler: path.join(workspaceRoot, 'models', 'upscaler.safetensors'),
            },
          },
        ],
      },
      music: {
        analyzer: { kind: 'flamingo_dlt', launcher: analyzerLauncher },
      },
    });
    const report = checkMediaSetup(media, workspaceRoot, {
      inspectPath: () => false,
      resolveFfmpeg: vi.fn(validFfmpeg),
      stillBackendNames: ['sd-local'],
    });

    expect(report.text).toContain(`directory not found ${comfyRoot} (media.comfyui.root)`);
    expect(report.text).toContain(
      `file not found ${ltxModel} (media.video.engines[0].models.diffusion)`,
    );
    expect(report.text).toContain(
      `file not found ${analyzerLauncher} (media.music.analyzer.launcher)`,
    );
  });

  it('surfaces the ffmpeg resolver explanation instead of hiding a missing executable', () => {
    const report = checkMediaSetup(MediaConfigSchema.parse({}), 'C:/workspace', {
      inspectPath: () => true,
      resolveFfmpeg: () => {
        throw new Error('ffmpeg and ffprobe were not found on PATH');
      },
    });

    expect(report.text).toContain('media.ffmpeg: ffmpeg and ffprobe were not found on PATH');
  });

  it('reports a still backend name that is not a configured sd-server model', () => {
    const media = MediaConfigSchema.parse({ video: { still_backend: 'missing-model' } });
    const report = checkMediaSetup(media, 'C:/workspace', {
      inspectPath: () => true,
      resolveFfmpeg: vi.fn(validFfmpeg),
      stillBackendNames: ['sd-local'],
    });

    expect(report.text).toContain(
      'media.video.still_backend: "missing-model" is not a configured sd-server model',
    );
  });

  it('reports an absent media block without registering behavior', () => {
    const report = checkMediaSetup(undefined, 'C:/workspace');

    expect(report.enabled).toBe(false);
    expect(report.text).toContain('Add a media: block to config.yaml');
  });
});

describe('resolveVideoEngine: LTX-2.5 is the default, H3 only by id', () => {
  it('picks the LTX entry when an H3 entry is listed first', () => {
    const media = MediaConfigSchema.parse({
      video: {
        engines: [
          { id: 'h3', kind: 'comfyui_workflow' },
          { id: 'ltx25', kind: 'ltx25' },
        ],
      },
    });
    const selection = resolveVideoEngine(media);
    expect(selection?.id).toBe('ltx25');
    expect(selection?.index).toBe(1);
    expect(selection?.engine.kind).toBe('ltx25');
  });

  it('refuses a default request when only an H3 entry is configured', () => {
    const media = MediaConfigSchema.parse({
      video: { engines: [{ id: 'h3', kind: 'comfyui_workflow' }] },
    });
    expect(resolveVideoEngine(media)).toBeUndefined();
    const message = defaultVideoEngineMessage(media, 'generate_video');
    expect(message).toContain('no LTX-2.5 video engine (kind: ltx25)');
    expect(message).toContain('h3 (kind comfyui_workflow)');
    expect(message).toContain('engine: "h3"');
  });

  it('still resolves an H3 entry by explicit id, and nothing by a wrong one', () => {
    const media = MediaConfigSchema.parse({
      video: { engines: [{ id: 'h3', kind: 'comfyui_workflow' }] },
    });
    const selection = resolveVideoEngine(media, 'h3');
    expect(selection?.id).toBe('h3');
    expect(selection?.engine.kind).toBe('comfyui_workflow');
    expect(resolveVideoEngine(media, 'ltx25')).toBeUndefined();
  });
});
