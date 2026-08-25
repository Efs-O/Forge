import * as fs from 'fs';
import * as path from 'path';

/**
 * Where ffmpeg lives. Split from `videoExtract.ts` because locating a binary and
 * driving it are separate concerns with separate failure modes — this half is
 * pure filesystem probing and never spawns anything.
 */

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * ffmpeg is absent. Typed rather than a bare Error so the tool layer can name
 * the fix instead of surfacing a spawn ENOENT — a refusal that does not say
 * what to install teaches the agent the capability does not exist.
 */
export class FfmpegMissingError extends Error {
  constructor(detail: string) {
    super(
      `view_video requires ffmpeg and ffprobe, which were not found. ${detail} ` +
        'Install ffmpeg (Windows: `winget install Gyan.FFmpeg`; macOS: `brew install ffmpeg`; ' +
        'Linux: your package manager) and make sure it is on PATH, or set `video.ffmpeg_path` ' +
        'in Forge config to the ffmpeg executable.',
    );
    this.name = 'FfmpegMissingError';
  }
}

const IS_WINDOWS = process.platform === 'win32';
const EXE = IS_WINDOWS ? '.exe' : '';
/** Bound on the WinGet package walk. Matches the value proven on this machine. */
const WINGET_MAX_DIRS = 2500;

function isExecutableFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function readDirNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** ffprobe is expected beside ffmpeg; every distribution ships them together. */
function pairFrom(ffmpegPath: string): FfmpegTools | undefined {
  const ffprobe = path.join(path.dirname(ffmpegPath), `ffprobe${EXE}`);
  return isExecutableFile(ffprobe) ? { ffmpeg: ffmpegPath, ffprobe } : undefined;
}

function fromConfiguredPath(configured: string): FfmpegTools {
  const candidate = configured.trim();
  if (!isExecutableFile(candidate)) {
    throw new FfmpegMissingError(`Configured video.ffmpeg_path does not exist: ${candidate}.`);
  }
  const pair = pairFrom(candidate);
  if (!pair) {
    throw new FfmpegMissingError(
      `Found ffmpeg at ${candidate} but no ffprobe${EXE} beside it; both are required.`,
    );
  }
  return pair;
}

function fromPath(): FfmpegTools | undefined {
  const entries = (process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of entries) {
    const candidate = path.join(dir, `ffmpeg${EXE}`);
    if (!isExecutableFile(candidate)) continue;
    const pair = pairFrom(candidate);
    if (pair) return pair;
  }
  return undefined;
}

/**
 * Windows WinGet installs land under a versioned package directory that is not
 * added to PATH by default, which is exactly the state this machine was in.
 * Bounded breadth-first walk so a large Packages tree cannot stall a tool round.
 */
function fromWinGet(): FfmpegTools | undefined {
  if (!IS_WINDOWS) return undefined;
  const root = path.join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'WinGet', 'Packages');
  if (!isDirectory(root)) return undefined;

  const queue: string[] = [root];
  let visited = 0;
  while (queue.length > 0 && visited < WINGET_MAX_DIRS) {
    const dir = queue.shift();
    if (dir === undefined) break;
    visited += 1;
    const candidate = path.join(dir, `ffmpeg${EXE}`);
    if (isExecutableFile(candidate)) {
      const pair = pairFrom(candidate);
      if (pair) return pair;
    }
    for (const child of readDirNames(dir)) queue.push(path.join(dir, child));
  }
  return undefined;
}

/**
 * Resolution order: explicit config, then PATH, then (Windows) the WinGet
 * package tree. No silent fallback — an unresolved ffmpeg throws.
 */
export function resolveFfmpeg(configuredPath?: string): FfmpegTools {
  if (configuredPath && configuredPath.trim()) return fromConfiguredPath(configuredPath);
  const found = fromPath() ?? fromWinGet();
  if (!found) {
    throw new FfmpegMissingError(`Searched PATH${IS_WINDOWS ? ' and WinGet packages.' : '.'}`);
  }
  return found;
}
