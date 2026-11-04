/**
 * The job file the shipped media adapters read (`resources/media/media_job.py`).
 *
 * The adapter owns no Forge configuration: every runtime path and every engine
 * parameter is resolved here and written into one JSON file, so a render can be
 * replayed from the run folder alone (docs/plans/MEDIA_SHIPPED_PLAN.md §2 and
 * its ledger row "Job file `job.json` in the run folder"). Field names and the
 * per-engine key sets below are the adapter's own validation, copied exactly:
 * `validate_job` refuses an unknown key and `_comfy_settings`, `_ace_settings`,
 * `_settings` and `_analyzer_settings` refuse a missing one, so a drift here
 * fails at the child's first line rather than halfway through a GPU job.
 */
import * as path from 'path';
import { writeFileAtomic } from '../../util/atomicWrite';

export const MEDIA_JOB_SCHEMA_VERSION = 1;

/**
 * ComfyUI's own start budget, and the per-job budget the adapter enforces while
 * it polls `/history`. `media:` has no timeout key yet (the plan's config block
 * defines none), so these constants are the shipped values; the ledger's
 * "the per-job timeout from config ends it" row is served by them until a
 * `timeout_seconds` key is added.
 */
export const COMFYUI_STARTUP_TIMEOUT_SECONDS = 120;
export const COMFYUI_JOB_TIMEOUT_SECONDS = 3_600;
/** The Flamingo DLT launcher's own budget. */
export const ANALYZER_TIMEOUT_SECONDS = 3_600;
/** ACE-Step's standalone runtime budget, passed as ace.timeout_seconds. */
export const ACE_TIMEOUT_SECONDS = 3_600;

/** ACE-Step's own caption and lyrics ceilings, enforced again by the adapter. */
export const ACE_CAPTION_LIMIT_CHARS = 512;
export const ACE_LYRICS_LIMIT_CHARS = 4_096;
/** `generate_video`'s motion-text ceiling (the plan's bounded prompt). */
export const VIDEO_PROMPT_LIMIT_CHARS = 2_000;

/**
 * Proven LTX-2.5 graph parameters (the Ssuno `ltx25_i2v.py` recipe), kept as
 * constants because `media:` has no keys for them. `prompt_enhance` stays off:
 * it needs a second model file the plan names no config key for.
 */
export const VIDEO_BLOCK_DEFAULTS = {
  image_compression: 10,
  base_strength: 0.7,
  refine_strength: 1.0,
  prompt_enhance: false,
  negative_prompt: '',
} as const;

/** Proven Stable Audio 3 Medium post-trained settings (HANDOFF.md: 8 steps, lcm/simple, CFG 1, tiled VAE 256/32). */
export const SA3_BLOCK_DEFAULTS = {
  mode: 'instrumental',
  steps: 8,
  cfg: 1,
  sampler_name: 'lcm',
  scheduler: 'simple',
  tile_size: 256,
  overlap: 32,
  mp3_bitrate_kbps: 320,
  negative_prompt: 'vocals, singing, spoken words, lyrics',
  batch_size: 1,
  denoise: 1,
  clip_type: 'stable_audio',
  clip_device: 'default',
  save_format: 'flac',
} as const;

/** Proven ACE-Step 1.5 Turbo parameters; `config_path` names the Turbo preset. */
export const ACE_BLOCK_DEFAULTS = {
  config_path: 'acestep-v15-turbo',
  task_type: 'text2music',
  instrumental: false,
  vocal_language: 'en',
  inference_steps: 8,
  thinking: false,
  use_cot_metas: false,
  use_cot_caption: false,
  use_cot_language: false,
  offload_to_cpu: true,
  offload_dit_to_cpu: false,
  batch_size: 1,
  audio_format: 'flac',
  mp3_bitrate_kbps: 320,
} as const;

/** What ACE wants when nobody asked for words; the adapter still needs a lyrics file. */
export const ACE_INSTRUMENTAL_LYRICS = '[Instrumental]';

export interface MediaJobFile {
  schema_version: number;
  run_id: string;
  run_dir: string;
  kind: 'video' | 'music';
  engine: string;
  prompt?: string;
  /** Tool-side edits or trims carried into the final adapter manifest. */
  tool_reports?: readonly string[];
  seconds?: number;
  seed?: number;
  cuda_devices: readonly number[];
  ffmpeg: string;
  ffprobe: string;
  comfyui?: MediaComfyUiBlock;
  models?: Record<string, string>;
  inputs?: Record<string, string>;
  video?: MediaVideoBlock;
  music?: MediaMusicBlock;
  ace?: MediaAceBlock;
  analyzer?: MediaAnalyzerBlock;
}

/** Every key `media_comfy._COMFY_KEYS` requires. */
export interface MediaComfyUiBlock {
  root: string;
  python: string;
  host: string;
  port: number;
  input_dir: string;
  output_dir: string;
  temp_dir: string;
  user_dir: string;
  startup_args: readonly string[];
  startup_timeout_seconds: number;
  job_timeout_seconds: number;
}

export interface MediaVideoBlock {
  width: number;
  height: number;
  fps: number;
  image_compression: number;
  base_strength: number;
  refine_strength: number;
  prompt_enhance: boolean;
  negative_prompt: string;
}

export interface MediaMusicBlock {
  mode: string;
  steps: number;
  cfg: number;
  sampler_name: string;
  scheduler: string;
  tile_size: number;
  overlap: number;
  mp3_bitrate_kbps: number;
  negative_prompt: string;
  max_seconds: number;
  batch_size: number;
  denoise: number;
  clip_type: string;
  clip_device: string;
  save_format: string;
}

export interface MediaAceBlock {
  root: string;
  python: string;
  checkpoints_dir: string;
  config_path: string;
  task_type: string;
  instrumental: boolean;
  vocal_language: string;
  bpm: number;
  keyscale: string;
  timesignature: string;
  inference_steps: number;
  thinking: boolean;
  use_cot_metas: boolean;
  use_cot_caption: boolean;
  use_cot_language: boolean;
  offload_to_cpu: boolean;
  offload_dit_to_cpu: boolean;
  batch_size: number;
  audio_format: string;
  mp3_bitrate_kbps: number;
  timeout_seconds: number;
}

export interface MediaAnalyzerBlock {
  launcher: string;
  python: string;
  powershell: string;
  limit: number;
  timeout_seconds: number;
}

/**
 * The adapter's absolute-path rule (`media_job._absolute_path` refuses a
 * relative one). A relative config value resolves against the workspace root,
 * which is what `checkMediaSetup` resolves it against too, so the setup report
 * and the job file can never name two different files.
 */
export function absolutePath(candidate: string, workspaceRoot: string): string {
  return path.isAbsolute(candidate)
    ? path.normalize(candidate)
    : path.resolve(workspaceRoot, candidate);
}

/**
 * ComfyUI insists its input and output folders are the configured root's own
 * (`media_comfy.start_owned_comfyui`), and that its temp and user folders lie
 * inside this run, so a render leaves no state in a shared folder.
 */
export function comfyUiBlock(
  comfyui: { root: string; python: string; port: number },
  runDir: string,
  workspaceRoot: string,
): MediaComfyUiBlock {
  const root = absolutePath(comfyui.root, workspaceRoot);
  return {
    root,
    python: absolutePath(comfyui.python, workspaceRoot),
    host: '127.0.0.1',
    port: comfyui.port,
    input_dir: path.join(root, 'input'),
    output_dir: path.join(root, 'output'),
    temp_dir: path.join(runDir, 'temp'),
    user_dir: path.join(runDir, 'user'),
    startup_args: ['--disable-auto-launch'],
    startup_timeout_seconds: COMFYUI_STARTUP_TIMEOUT_SECONDS,
    job_timeout_seconds: COMFYUI_JOB_TIMEOUT_SECONDS,
  };
}

export function videoBlock(size: { width: number; height: number }, fps: number): MediaVideoBlock {
  return { width: size.width, height: size.height, fps, ...VIDEO_BLOCK_DEFAULTS };
}

export function musicBlock(maxSeconds: number): MediaMusicBlock {
  return { max_seconds: maxSeconds, ...SA3_BLOCK_DEFAULTS };
}

/**
 * BPM, key and time signature come from the Flamingo analysis when there is one
 * and stay labelled as estimates in the result (the plan's rule); the adapter
 * requires all three, so an unanalysed render uses plain defaults.
 */
export function aceBlock(
  engine: { root: string; checkpoints: string },
  workspaceRoot: string,
  estimates: { bpm?: number; keyscale?: string; timesignature?: string },
): MediaAceBlock {
  const root = absolutePath(engine.root, workspaceRoot);
  return {
    root,
    python: path.join(root, '.venv', 'Scripts', 'python.exe'),
    checkpoints_dir: absolutePath(engine.checkpoints, workspaceRoot),
    bpm: estimates.bpm ?? 120,
    keyscale: estimates.keyscale ?? 'B Major',
    timesignature: estimates.timesignature ?? '4',
    ...ACE_BLOCK_DEFAULTS,
    timeout_seconds: ACE_TIMEOUT_SECONDS,
  };
}

/**
 * The Flamingo launcher is a PowerShell script; its worker interpreter lives
 * beside it the way `mediaSetupCheck` checks it (`<launcher dir>/.venv/
 * Scripts/python.exe`), so the job file and the setup report agree.
 */
export function analyzerBlock(
  analyzer: { launcher: string },
  powershell: string,
  workspaceRoot: string,
): MediaAnalyzerBlock {
  const launcher = absolutePath(analyzer.launcher, workspaceRoot);
  return {
    launcher,
    python: path.join(path.dirname(launcher), '.venv', 'Scripts', 'python.exe'),
    powershell,
    limit: 1,
    timeout_seconds: ANALYZER_TIMEOUT_SECONDS,
  };
}

/**
 * Write the job file atomically before the adapter starts, so the child never
 * reads a partial file (ledger row: "atomic write: the adapter never sees a
 * partial file"). `job.json` is the render stage; a run that analysed first
 * keeps its analysis stage beside it as `job.analyze.json` for forensics.
 */
export async function writeJobFile(
  runDir: string,
  job: MediaJobFile,
  fileName = 'job.json',
): Promise<string> {
  const target = path.join(runDir, fileName);
  await writeFileAtomic(target, `${JSON.stringify(job, null, 2)}\n`);
  return target;
}
