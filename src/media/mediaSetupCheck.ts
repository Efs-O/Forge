import * as fs from 'fs';
import * as path from 'path';
import {
  type MediaConfig,
  type MediaMusicEngineConfig,
  type MediaVideoEngineConfig,
} from '../config/mediaSchema';
import { resolveFfmpeg, type FfmpegTools } from '../tools/ffmpegLocate';

export type MediaPathKind = 'file' | 'directory';

export interface MediaSetupCheckOptions {
  inspectPath?: (candidate: string, kind: MediaPathKind) => boolean;
  resolveFfmpeg?: (configuredPath?: string) => FfmpegTools;
  stillBackendNames?: readonly string[];
}

export interface MediaSetupReport {
  enabled: boolean;
  entries: string[];
  text: string;
}

function inspectPath(candidate: string, kind: MediaPathKind): boolean {
  try {
    const stat = fs.statSync(candidate);
    return kind === 'file' ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
}

function resolvedPath(candidate: string, workspaceRoot: string): string {
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(workspaceRoot, candidate);
}

function addPathCheck(
  entries: string[],
  key: string,
  value: string,
  kind: MediaPathKind,
  workspaceRoot: string,
  inspect: (candidate: string, kind: MediaPathKind) => boolean,
): boolean {
  if (!value.trim()) {
    entries.push(`missing ${key}`);
    return false;
  }
  const candidate = resolvedPath(value, workspaceRoot);
  if (!inspect(candidate, kind)) {
    entries.push(`${kind} not found ${candidate} (${key})`);
    return false;
  }
  return true;
}

function checkEngine(entries: string[], label: string, check: () => void): void {
  const countBefore = entries.length;
  check();
  if (entries.length === countBefore) entries.push(`${label}: configured`);
}

function checkComfyUi(
  entries: string[],
  media: MediaConfig,
  workspaceRoot: string,
  inspect: (candidate: string, kind: MediaPathKind) => boolean,
): void {
  addPathCheck(
    entries,
    'media.comfyui.root',
    media.comfyui.root,
    'directory',
    workspaceRoot,
    inspect,
  );
  addPathCheck(
    entries,
    'media.comfyui.python',
    media.comfyui.python,
    'file',
    workspaceRoot,
    inspect,
  );
}

function checkVideoEngine(
  entries: string[],
  engine: MediaVideoEngineConfig,
  index: number,
  media: MediaConfig,
  workspaceRoot: string,
  inspect: (candidate: string, kind: MediaPathKind) => boolean,
): void {
  const prefix = `media.video.engines[${index}]`;
  checkEngine(entries, `video ${engine.id}`, () => {
    if (engine.kind === 'ltx25') {
      checkComfyUi(entries, media, workspaceRoot, inspect);
      for (const [name, value] of Object.entries(engine.models)) {
        if (name === 'prompt_enhancer' && !value?.trim()) continue;
        addPathCheck(
          entries,
          `${prefix}.models.${name}`,
          value ?? '',
          'file',
          workspaceRoot,
          inspect,
        );
      }
      return;
    }
    checkComfyUi(entries, media, workspaceRoot, inspect);
    addPathCheck(
      entries,
      `${prefix}.models.diffusion`,
      engine.models.diffusion,
      'file',
      workspaceRoot,
      inspect,
    );
    addPathCheck(entries, `${prefix}.workflow`, engine.workflow, 'file', workspaceRoot, inspect);
  });
}

function checkMusicEngine(
  entries: string[],
  engine: MediaMusicEngineConfig,
  index: number,
  media: MediaConfig,
  workspaceRoot: string,
  inspect: (candidate: string, kind: MediaPathKind) => boolean,
): void {
  const prefix = `media.music.engines[${index}]`;
  checkEngine(entries, `music ${engine.id}`, () => {
    if (engine.kind === 'ace_standalone') {
      const rootReady = addPathCheck(
        entries,
        `${prefix}.root`,
        engine.root,
        'directory',
        workspaceRoot,
        inspect,
      );
      addPathCheck(
        entries,
        `${prefix}.checkpoints`,
        engine.checkpoints,
        'directory',
        workspaceRoot,
        inspect,
      );
      if (rootReady) {
        const python = path.join(engine.root, '.venv', 'Scripts', 'python.exe');
        addPathCheck(entries, `${prefix}.root runtime`, python, 'file', workspaceRoot, inspect);
      }
      return;
    }
    checkComfyUi(entries, media, workspaceRoot, inspect);
    addPathCheck(
      entries,
      `${prefix}.checkpoint`,
      engine.checkpoint,
      'file',
      workspaceRoot,
      inspect,
    );
    addPathCheck(
      entries,
      `${prefix}.text_encoder`,
      engine.text_encoder,
      'file',
      workspaceRoot,
      inspect,
    );
  });
}

function checkAnalyzer(
  entries: string[],
  media: MediaConfig,
  workspaceRoot: string,
  inspect: (candidate: string, kind: MediaPathKind) => boolean,
): void {
  const key = 'media.music.analyzer.launcher';
  const launcher = media.music.analyzer.launcher;
  if (!launcher.trim()) {
    entries.push(`missing ${key} (MP3 analysis is unavailable)`);
    return;
  }
  const candidate = resolvedPath(launcher, workspaceRoot);
  const before = entries.length;
  addPathCheck(entries, key, launcher, 'file', workspaceRoot, inspect);
  const python = path.join(path.dirname(candidate), '.venv', 'Scripts', 'python.exe');
  addPathCheck(entries, `${key} runtime`, python, 'file', workspaceRoot, inspect);
  if (entries.length === before) entries.push('music analyzer: configured');
}

function checkFfmpeg(
  entries: string[],
  configured: string,
  workspaceRoot: string,
  resolver: (configuredPath?: string) => FfmpegTools,
): void {
  const commandName = configured.trim().toLowerCase();
  const commandPath =
    commandName === 'ffmpeg' || commandName === 'ffmpeg.exe'
      ? undefined
      : resolvedPath(configured, workspaceRoot);
  try {
    resolver(commandPath);
    entries.push('media.ffmpeg and ffprobe: configured');
  } catch (error) {
    entries.push(`media.ffmpeg: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Inspect configured media paths without starting an engine or creating files. */
export function checkMediaSetup(
  media: MediaConfig | undefined,
  workspaceRoot: string,
  options: MediaSetupCheckOptions = {},
): MediaSetupReport {
  if (!media) {
    const text = 'Media generation is not configured. Add a media: block to config.yaml.';
    return { enabled: false, entries: ['missing media'], text };
  }

  const inspect = options.inspectPath ?? inspectPath;
  const resolve = options.resolveFfmpeg ?? resolveFfmpeg;
  const entries = [`Media generation: ${media.enabled ? 'enabled' : 'disabled'}`];
  checkFfmpeg(entries, media.ffmpeg, workspaceRoot, resolve);

  if (media.video.engines.length === 0)
    entries.push('media.video.engines: no video engine is configured');
  media.video.engines.forEach((engine, index) =>
    checkVideoEngine(entries, engine, index, media, workspaceRoot, inspect),
  );
  if (!media.video.still_backend.trim()) {
    entries.push('missing media.video.still_backend (text-to-video is unavailable)');
  } else if (
    options.stillBackendNames &&
    !options.stillBackendNames.includes(media.video.still_backend)
  ) {
    entries.push(
      `media.video.still_backend: "${media.video.still_backend}" is not a configured sd-server model`,
    );
  }

  if (media.music.engines.length === 0)
    entries.push('media.music.engines: no music engine is configured');
  media.music.engines.forEach((engine, index) =>
    checkMusicEngine(entries, engine, index, media, workspaceRoot, inspect),
  );
  checkAnalyzer(entries, media, workspaceRoot, inspect);

  const text = entries.join('\n');
  return { enabled: media.enabled, entries, text };
}
