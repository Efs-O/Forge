import * as fs from 'fs/promises';
import * as path from 'path';
import type { ForgeConfig } from '../../config/types';
import { upscaleBlock, type ImageUpscaleConfig } from '../../config/imageUpscaleSchema';
import type { GpuInfo } from '../../system/systemProbes';
import { GENERATED_IMAGE_PREFIX } from '../../sidebar/toolResultView';
import type { UserNotificationService } from '../../sidebar/UserNotificationService';
import { inspectFileForDelivery, MAX_FILE_DELIVERY_BYTES } from '../../util/fileDeliveryValidation';
import { resolveRealWorkspacePath } from '../../util/WorkspacePaths';
import { pngDimensions } from '../browser/browserPrimitives';
import { CLAIM_SUFFIX } from '../renderHtmlToImageTool';
import { resolveFfmpeg, type FfmpegTools } from '../ffmpegLocate';
import type { RegisteredTool, ToolHandlerContext } from '../ToolRegistry';
import { displayPath } from './generateImageToolFormat';
import { probeImageArgv, defaultRunFfmpeg, type RunFfmpeg } from './sdcppReferenceInput';
import { assertDeviceVramAvailable } from './sdcppVramGate';
import { runUpscale, upscaleArgv, type UpscaleRun, type UpscaleRunResult } from './upscaleRunner';

/**
 * `upscale_image` — one ESRGAN ×4 pass over an existing picture
 * (docs/plans/LOCAL_IMAGE_TURBO_3060_PLAN.md §4c).
 *
 * A separate tool rather than a `generate_image` option, so it works on ANY
 * image: a render, a screenshot, a phone photo. It runs `sd-cli` as a one-shot
 * child (not the resident `sd-server`), which frees its VRAM when it exits —
 * measured 864x1536 → 3456x6144 in 47 s using ~0.6 GB on the 3060.
 *
 * The order of the steps is load-bearing: every cheap check (config, path,
 * input size, output name) runs BEFORE the VRAM probe and the spawn, so a
 * refusal costs no GPU time, and the output name is claimed before the child
 * starts so nothing else can take it while the child is writing.
 */

/** ffprobe is a metadata read; longer than this means it is hung, not slow. */
const PROBE_TIMEOUT_MS = 30_000;

/** Config block for the configured upscale, or undefined when absent. */
export function upscaleConfigFor(config: ForgeConfig | undefined): ImageUpscaleConfig | undefined {
  return upscaleBlock(config?.image_generation);
}

export interface UpscaleImageDeps {
  getConfig: () => ForgeConfig;
  notifications: UserNotificationService;
  /** Injectable: the `sd-cli` spawn itself, so a test never needs a GPU. */
  run?: UpscaleRun;
  /** Injectable: the nvidia-smi probe behind the VRAM gate. */
  probe?: () => Promise<GpuInfo[]>;
  /** Injectable: the ffprobe call that sizes a non-PNG input. */
  probeImage?: RunFfmpeg;
  /** Injectable: a located ffmpeg pair, so a unit test never resolves PATH. */
  ffmpegTools?: FfmpegTools;
  /** Injectable: an explicit workspace root, mirroring the path resolvers. */
  workspaceRoot?: string;
}

export function makeUpscaleImageTool(deps: UpscaleImageDeps): RegisteredTool {
  const block = (): ImageUpscaleConfig | undefined => upscaleConfigFor(deps.getConfig());
  const tool: RegisteredTool = {
    // Canonical literal: scripts/tool-audit-catalog.mjs extracts it statically,
    // so it stays inline and free of computed strings.
    definition: {
      type: 'function',
      function: {
        name: 'upscale_image',
        description:
          'Upscale an existing image 4x with the configured ESRGAN model, saving `<name>_x4.png` beside the input. One-shot local GPU job; works on any image — a generate_image render, a screenshot, a phone photo. The output is saved and queued to the watching remote chat, and is NOT added to your context, so call view_image to see it.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'The picture to upscale: workspace-relative, or absolute inside the workspace. The `_x4.png` lands beside it; a taken name gets a `-2` suffix, never overwritten.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'fetch',
    additionalPermissions: ['write'],
    // The output name is only known once the no-overwrite rule has chosen it, so
    // the handler snapshots through `beforeMutate` instead of declaring it here.
    mutation: { paths: () => [], showDiff: false },
    // Self-suppressing as well as unregistered-when-absent. `registerAllTools`
    // runs once per activation, so this is what stops advertisement after the
    // owner deletes the block and reloads config without reloading the window.
    advertise: () => block() !== undefined,
    handler: (args, context) => runUpscaleImage(deps, args, context),
  };
  return tool;
}

/** The input's size and how it was measured, so the refusal can be trusted. */
interface InputDimensions {
  width: number;
  height: number;
  /** Which reader produced the number, named in the refusal. */
  via: 'its PNG header' | 'ffprobe';
}

async function runUpscaleImage(
  deps: UpscaleImageDeps,
  args: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
): Promise<string> {
  const config = upscaleConfigFor(deps.getConfig());
  if (!config) {
    throw new Error(
      'upscale_image: no image_generation.upscale block in config.yaml, so nothing was upscaled. ' +
        'Add that block (binary, model, cuda_device, min_free_vram_mb), or send the picture as it ' +
        'is with send_file.',
    );
  }
  const input = await resolveInput(deps, args['path']);
  const size = await readImageSize(input, deps);
  const longest = Math.max(size.width, size.height);
  if (longest > config.max_input_edge_px) {
    throw new Error(
      `upscale_image: "${displayPath(input)}" is ${size.width}x${size.height} — long edge ` +
        `${longest.toLocaleString()} px, read from ${size.via} — over the configured ` +
        `image_generation.upscale.max_input_edge_px of ${config.max_input_edge_px.toLocaleString()} px. ` +
        `A ×4 pass would write 16× the pixels (${(longest * 4).toLocaleString()} px on the long edge). ` +
        `Shrink it first — \`ffmpeg -i "${input}" -vf scale=${Math.floor(size.width / (longest / config.max_input_edge_px))}:` +
        `${Math.floor(size.height / (longest / config.max_input_edge_px))} smaller.png\` — then upscale that.`,
    );
  }

  const output = await claimOutput(input);
  try {
    await gateVram(config, deps);
    // Keep/Undo covers the new file from here on: the snapshot happens before
    // the child writes a byte, so Undo removes the `_x4.png` rather than
    // restoring a half-written one. It is deliberately AFTER the gate: a refusal
    // that writes nothing should not open a checkpoint for a path that never
    // existed.
    context?.beforeMutate([output]);
    const startedAt = Date.now();
    const run = await spawnUpscale(deps, config, input, output, context);
    if (!run.ok) {
      // upscaleRunner waited for the child's exit before resolving, so the
      // partial output cannot still be open when this delete runs.
      await fs.rm(output, { force: true });
      throw new Error(
        `upscale_image: ${describeFailure(run, config)}` +
          ` No upscaled file was left at "${displayPath(output)}".`,
      );
    }
    return await deliver(deps, config, input, output, size, startedAt, context);
  } finally {
    // The claim has done its job either way: the file exists, or nothing was
    // written and the next call should get the base name. Never throws.
    await releaseClaim(output);
  }
}

/**
 * Resolve the input. Workspace-only for now (owner's call, 2026-10-12): a phone
 * attachment under `.forge/remote-inbox/` is refused with the fix named rather
 * than silently written to outside the write sandbox.
 */
async function resolveInput(deps: UpscaleImageDeps, requested: unknown): Promise<string> {
  const raw = typeof requested === 'string' ? requested.trim() : '';
  if (!raw) {
    throw new Error('upscale_image: path must name one image file to upscale.');
  }
  try {
    const absolute = await resolveRealWorkspacePath(raw, deps.workspaceRoot);
    // A directory realpaths fine, so the type has to be checked: otherwise the
    // first thing that fails is a raw EISDIR from the header read.
    if (!(await fs.stat(absolute)).isFile()) {
      throw new Error(`"${absolute}" is a directory, not one picture file`);
    }
    return absolute;
  } catch (error) {
    throw new Error(
      `upscale_image: "${raw}" is not a file inside the workspace ` +
        `(${error instanceof Error ? error.message : String(error)}). Copy the picture into the ` +
        'workspace and upscale that path, or use send_file to deliver it as it is.',
    );
  }
}

/**
 * Read the size without decoding the image: PNG is a header read (the format
 * `generate_image` writes and the one an upscale output is always in), anything
 * else goes through ffprobe — the existing image-dimension reader, reused
 * rather than a second header parser per format.
 */
async function readImageSize(input: string, deps: UpscaleImageDeps): Promise<InputDimensions> {
  const head = await readHead(input);
  if (isPng(head)) {
    const dims = pngDimensions(head);
    if (dims.width > 0 && dims.height > 0) {
      return { width: dims.width, height: dims.height, via: 'its PNG header' };
    }
  }
  const tools: FfmpegTools = deps.ffmpegTools ?? resolveFfmpeg('');
  const run = deps.probeImage ?? defaultRunFfmpeg;
  const probed = await run(tools.ffprobe, probeImageArgv(input), { timeoutMs: PROBE_TIMEOUT_MS });
  const dims = parseFfprobeSize(probed.stdout);
  if (!dims) {
    throw new Error(
      `upscale_image: ffprobe gave no width and height for "${displayPath(input)}" (exit ` +
        `${probed.code})` +
        `${probed.stderr.trim() ? `: ${probed.stderr.trim().slice(-300)}` : ''}. It may not be an ` +
        'image file; a HEIC or TIFF phone photo must be converted to PNG or JPEG first.',
    );
  }
  return { ...dims, via: 'ffprobe' };
}

/** First bytes of the file — enough for a PNG IHDR, cheap for a big photo. */
async function readHead(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The output's real pixels. Falls back to the ×4 arithmetic when the file has
 * no readable IHDR, so the result never claims 0x0 for a file that exists.
 */
async function readWrittenSize(
  output: string,
  fallback: { width: number; height: number },
): Promise<{ width: number; height: number }> {
  const dims = pngDimensions(await readHead(output));
  return dims.width > 0 && dims.height > 0 ? dims : fallback;
}

function isPng(head: Buffer): boolean {
  return (
    head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
  );
}

/** ffprobe's `-show_entries stream=width,height` JSON, validated not trusted. */
function parseFfprobeSize(stdout: string): { width: number; height: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const streams = (parsed as { streams?: unknown }).streams;
  const first = Array.isArray(streams) ? streams[0] : undefined;
  const width = (first as { width?: unknown } | undefined)?.width;
  const height = (first as { height?: unknown } | undefined)?.height;
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    return undefined;
  }
  return { width, height };
}

/** `<dir>/<stem>_x4.png`, keeping the input's folder and stem. Exported for tests. */
export function upscaleOutputName(input: string): string {
  const base = path.basename(input);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return path.join(path.dirname(input), `${stem}_x4.png`);
}

/**
 * Choose and hold the output name: `<stem>_x4.png`, or `-2`, `-3` … when that
 * name is already a real file (never overwritten) or is claimed by a concurrent
 * call. The hold is an exclusive `wx` create of a sidecar, the same shape
 * `render_html_to_image` uses, so it holds across two Forge windows on one
 * workspace where a stat-then-write sequence would race.
 */
async function claimOutput(input: string): Promise<string> {
  const wanted = upscaleOutputName(input);
  const dir = path.dirname(wanted);
  const stem = path.basename(wanted, '.png');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? wanted : path.join(dir, `${stem}-${attempt + 1}.png`);
    try {
      await fs.stat(candidate);
      continue; // a real file already owns this name
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      await fs.writeFile(`${candidate}${CLAIM_SUFFIX}`, '', { flag: 'wx' });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(
    `upscale_image: ${path.basename(wanted)} and 99 numbered variants already exist. Delete some, ` +
      'or upscale a copy under a different name.',
  );
}

/** Free the hold so a failed call does not burn a filename. Never throws. */
async function releaseClaim(absolute: string): Promise<void> {
  try {
    await fs.rm(`${absolute}${CLAIM_SUFFIX}`, { force: true });
  } catch {
    // Best-effort, as in render_html_to_image: a leftover hold blocks only its
    // own numbered name.
  }
}

/**
 * The same fail-closed VRAM gate `generate_image` uses, filled from the upscale
 * block. A resident `sd-server` on this device is exactly what usually trips
 * it, which is why the refusal names the holders.
 */
async function gateVram(config: ImageUpscaleConfig, deps: UpscaleImageDeps): Promise<void> {
  await assertDeviceVramAvailable({
    label: 'upscale_image',
    configKey: 'image_generation.upscale',
    cudaDevice: config.cuda_device,
    minFreeVramMb: config.min_free_vram_mb,
    modelPath: config.model,
    alternatives: ['send_file to deliver the picture unupscaled'],
    nothingRan: 'no image was upscaled',
    holdersHint: 'an idle sd-server, whisper, a game',
    ...(deps.probe ? { probe: deps.probe } : {}),
  });
}

/** One `sd-cli` pass. Never more than one attempt: no silent fallback. */
function spawnUpscale(
  deps: UpscaleImageDeps,
  config: ImageUpscaleConfig,
  input: string,
  output: string,
  context: ToolHandlerContext | undefined,
): Promise<UpscaleRunResult> {
  const run: UpscaleRun = deps.run ?? runUpscale;
  return run({
    binary: config.binary,
    args: upscaleArgv(config.model, input, output),
    cudaDevice: config.cuda_device,
    timeoutMs: config.timeout_ms,
    ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
  });
}

/** Failure voice per kind, always with the child's own words when it said any. */
function describeFailure(run: UpscaleRunResult, config: ImageUpscaleConfig): string {
  const said = run.stderr ? ` It said: ${run.stderr}` : '';
  switch (run.kind) {
    case 'cancelled':
      return (
        'the upscale was cancelled and the sd-cli process Forge started was killed by its PID' +
        `${run.pid ? ` (${run.pid})` : ''}.`
      );
    case 'timeout':
      return (
        `sd-cli did not finish within image_generation.upscale.timeout_ms of ` +
        `${config.timeout_ms.toLocaleString()} ms, so Forge killed the process it started` +
        `${run.pid ? ` (PID ${run.pid})` : ''}.${said}`
      );
    case 'spawn_error':
      return (
        `sd-cli at "${config.binary}" could not be started — check image_generation.upscale.binary` +
        `${said}`
      );
    default:
      return (
        `sd-cli exited with code ${run.exitCode ?? 'unknown'}` +
        ` (model "${path.win32.basename(config.model)}")${said}`
      );
  }
}

/**
 * Verify what the child wrote, then deliver it. A ×4 output can exceed the
 * 50 MB document ceiling — 8192 px on the long edge does — and then the rule is
 * saved-but-not-sent, said out loud, not a silent failure.
 */
async function deliver(
  deps: UpscaleImageDeps,
  config: ImageUpscaleConfig,
  input: string,
  output: string,
  size: InputDimensions,
  startedAt: number,
  context: ToolHandlerContext | undefined,
): Promise<string> {
  const inspected = await inspectFileForDelivery(output);
  if (!inspected.ok && inspected.reason !== 'too-large') {
    // A run that exited 0 without a usable file still failed, and the plan's
    // rule is that a failed upscale leaves no `_x4.png` behind.
    await fs.rm(output, { force: true });
    throw new Error(
      `upscale_image: sd-cli exited 0 but left ${inspected.reason === 'empty' ? 'an empty file' : 'no file'} ` +
        `at "${displayPath(output)}", so nothing was sent. The original "${displayPath(input)}" is ` +
        `untouched. Check that image_generation.upscale.model ("${path.win32.basename(config.model)}") ` +
        'is a real 4x model file.',
    );
  }
  const bytes = inspected.ok ? inspected.size : (inspected.size ?? 0);
  // Report the size the file actually has, not 4× the input: the configured
  // model is a 4x model today, and the day it is not, the result must not lie.
  const written = await readWrittenSize(output, { width: size.width * 4, height: size.height * 4 });
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const head =
    `${GENERATED_IMAGE_PREFIX}${displayPath(output)} (PNG, ${bytes.toLocaleString()} bytes) at ` +
    `${written.width}x${written.height}, from ${size.width}x${size.height}, in ${seconds} s.`;
  const footer =
    'Upscaled locally with ESRGAN in one sd-cli pass, no fallback; the original ' +
    `"${displayPath(input)}" is untouched. To inspect it, call view_image on that path.`;
  if (!inspected.ok) {
    return (
      `${head}\nSaved but NOT sent: ${bytes.toLocaleString()} bytes is over the ` +
      `${MAX_FILE_DELIVERY_BYTES.toLocaleString()}-byte ceiling for a chat attachment, so it stays on ` +
      `disk. Give the user "${displayPath(output)}" instead.\n${footer}`
    );
  }
  const delivery = await deps.notifications.deliverFile({
    ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
    text: `🖼 upscaled ×4: ${path.win32.basename(output)}`,
    imagePath: output,
  });
  const deliveryLine =
    delivery.kind === 'refused'
      ? `Saved to ${displayPath(output)}, not sent: per-turn file limit (${delivery.reason})`
      : delivery.chats > 0
        ? `Queued for ${delivery.chats} remote chat(s).`
        : 'No remote chat is watching this turn, so nothing was sent to a phone.';
  return `${head}\n${deliveryLine}\n${footer}`;
}
