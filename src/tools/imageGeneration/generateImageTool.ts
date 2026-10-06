import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SdServerBackend } from '../../backend/SdServerBackend';
import type { ForgeConfig, ImageBackendConfig, ImageGenerationConfig } from '../../config/types';
import type { UserNotificationService } from '../../sidebar/UserNotificationService';
import { resolveRealWorkspacePath } from '../../util/WorkspacePaths';
import type { FfmpegTools } from '../ffmpegLocate';
import type { RunFfmpeg } from './sdcppReferenceInput';
import { GENERATED_IMAGE_PREFIX } from '../../sidebar/toolResultView';
import type { RegisteredTool, ToolHandlerContext } from '../ToolRegistry';
import { MAX_IMAGE_VARIATIONS } from '../../config/imageGenerationSchema';
import { generateCloudImage, type GeneratedImage } from './cloudImageBackend';
import {
  backendCostTag,
  describeWithBackends,
  displayPath,
  pickBackend,
  targetPath,
} from './generateImageToolFormat';
import {
  outputCollidesWithReference,
  prepareLocalReferences,
  renderLocalVariation,
  resolveOutputForCollision,
  type LocalRenderDeps,
} from './generateImageToolLocal';
import type { SdcppGeneratedImage, SdcppImageRequest } from './sdcppImageBackend';
import type { runSdcppImageJob, SdcppJobResult } from './sdcppJobPoll';

const MAX_PROMPT_CHARS = 4_000;
const CAPTION_PROMPT_CHARS = 200;

export interface GenerateImageDeps {
  getConfig: () => ForgeConfig;
  secrets: vscode.SecretStorage | undefined;
  notifications: UserNotificationService;
  /** The window's live `sd-server` owners, by backend name. Absent = no local backend wired. */
  sdServers?: () => ReadonlyMap<string, SdServerBackend>;
  /** Injectable for tests. */
  generate?: typeof generateCloudImage;
  /** Injectable for tests. */
  generateLocal?: (request: SdcppImageRequest) => Promise<SdcppGeneratedImage>;
  /** Injectable for tests: the async reference-editing job path. */
  generateJob?: (request: Parameters<typeof runSdcppImageJob>[0]) => Promise<SdcppJobResult>;
  /** Injectable for tests: proves nothing was spawned for a refused reference. */
  onReferenceSpawn?: (argv: string[]) => void;
  /** Injectable for tests: a located ffmpeg pair, so a unit test never spawns ffmpeg. */
  ffmpegTools?: FfmpegTools;
  /** Injectable for tests: the ffmpeg/ffprobe spawn itself. */
  runReference?: RunFfmpeg;
  /** Injectable for tests; production opens the saved file beside the chat. */
  reveal?: (filePath: string) => Promise<void>;
  now?: () => Date;
  /** Injectable: the real seed is random, so a rerender is not a byte copy. */
  seed?: () => number;
}

export function makeGenerateImageTool(deps: GenerateImageDeps): RegisteredTool {
  const imageConfig = (): ImageGenerationConfig | undefined => deps.getConfig().image_generation;
  const tool: RegisteredTool = {
    // Canonical literal: scripts/tool-audit-catalog.mjs extracts it statically,
    // so it stays inline and free of computed strings.
    definition: {
      type: 'function',
      function: {
        name: 'generate_image',
        description:
          'Generate an image from a text prompt with a configured image model and save it into the workspace. Cloud backends ask for approval and bill per image; local backends are free. Write one good prompt rather than retrying variations. The image is opened in the editor and sent to the remote chat watching this turn, if any. It is NOT added to your context: call view_image on the saved path if you need to look at it. For text-heavy graphics with exact layout (posters, cards, invites, diagrams), use render_html_to_image instead — diffusion models garble text.',
        parameters: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'What to draw: subject, style, composition, lighting. At most 4000 characters.',
            },
            backend: {
              type: 'string',
              description: 'Configured image backend to use. Omit for the default.',
            },
            path: {
              type: 'string',
              description:
                'Where to save, relative to the workspace root (the first workspace folder, which may not be the project you are working in). The extension is set from the returned format. Omit to save under the configured output folder.',
            },
            size: {
              type: 'string',
              // Inlined literally: scripts/tool-audit-catalog.mjs extracts this
              // definition statically and cannot evaluate a spread. The
              // GenerateImageTool test asserts it equals SDCPP_SIZE_NAMES.
              enum: ['square', 'portrait', 'landscape'],
              description:
                'Local backends only: 1328x1328, 928x1664, 1664x928. Cloud backends ignore it.',
            },
            reference_paths: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Local backends only, and only when that backend sets vision_encoder: 1-4 image paths to condition the render on — an edit, a style, or a character to keep. Out-of-workspace paths are accepted (where phone uploads live). Each is downscaled to the configured long-edge cap; the result says so. Slow: ~175s per 768x768 image.',
            },
            count: {
              type: 'integer',
              minimum: 1,
              maximum: 2,
              description: `Variations from one prompt, 1-${MAX_IMAGE_VARIATIONS}. Each gets its own reported seed and its own file (-1/-2), and costs a full render.`,
            },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
      },
    },
    permission: 'fetch',
    additionalPermissions: ['write'],
    // Paths are only known once the provider says which format it returned,
    // so the handler snapshots through `beforeMutate` instead.
    mutation: { paths: () => [], showDiff: false },
    advertise: () => imageConfig() !== undefined,
    describe: () => describeWithBackends(tool.definition, imageConfig()),
    approval: (args) => {
      const config = imageConfig();
      const backend = config ? pickBackend(config, args['backend']) : undefined;
      if (!backend) return undefined;
      const prompt = typeof args['prompt'] === 'string' ? args['prompt'] : '';
      const detail = `${backend.name} (${backendCostTag(backend)})`;
      // A cold local backend needs one more thing from the user: the server is
      // about to occupy a GPU. `startApproval()` says so only when a spawn is
      // actually needed, so a warm server asks nothing extra.
      const starting =
        backend.provider === 'sdcpp'
          ? deps.sdServers?.().get(backend.name)?.startApproval()
          : undefined;
      return {
        // `confirm_on_start` must actually ask: with `confirm_each: false` the
        // start notice alone sat in a detail no prompt showed.
        dangerous: backend.confirm_each || starting !== undefined,
        detail:
          `${detail}${starting ? `\n${starting.detail}` : ''}` +
          `${backend.provider !== 'sdcpp' && backend.confirm_each ? ' — billed per image' : ''}\n\n${prompt.slice(0, 600)}`,
      };
    },
    handler: (args, context) => runGenerateImage(deps, imageConfig(), args, context),
  };
  return tool;
}

async function runGenerateImage(
  deps: GenerateImageDeps,
  config: ImageGenerationConfig | undefined,
  args: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
): Promise<string> {
  if (!config) {
    throw new Error('generate_image: no image_generation block in config.yaml.');
  }
  const prompt = typeof args['prompt'] === 'string' ? args['prompt'].trim() : '';
  if (!prompt) throw new Error('generate_image: prompt must be a non-empty string.');
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `generate_image: prompt is ${prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}.`,
    );
  }
  const backend = pickBackend(config, args['backend']);
  if (!backend) {
    const names = config.backends.map((entry) => entry.name).join(', ');
    throw new Error(
      `generate_image: unknown backend "${String(args['backend'])}". Configured: ${names}.`,
    );
  }
  const alternatives = config.backends
    .filter((entry) => entry.name !== backend.name)
    .map((entry) => entry.name);
  const sizeRequested = typeof args['size'] === 'string' && args['size'].trim() !== '';
  const count = parseCount(args['count']);
  const now = (deps.now ?? (() => new Date()))();

  if (backend.provider === 'sdcpp') {
    return runLocalVariations(
      deps,
      config,
      backend,
      prompt,
      args,
      alternatives,
      count,
      now,
      context,
    );
  }

  const image = await (deps.generate ?? generateCloudImage)({
    backend,
    prompt,
    secrets: deps.secrets,
    ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
  });

  const paid = ` (paid ${backend.provider} API)`;
  const target = targetPath(config, args['path'], prompt, image, now);
  const saved = await saveImage(
    deps,
    backend,
    target,
    image.bytes,
    context,
    captionFor(backend, prompt, paid),
  );
  const lines = [
    `${GENERATED_IMAGE_PREFIX}${saved.display} (${image.mime}, ${image.bytes.length.toLocaleString()} bytes) with backend ${backend.name}.`,
    saved.deliveryLine,
    `This was a paid ${backend.provider} API call, billed per image.`,
  ];
  if (sizeRequested) {
    lines.push('The size argument applies to local backends only, so this backend ignored it.');
  }
  if (image.revisedPrompt) lines.push(`The provider rewrote the prompt as: ${image.revisedPrompt}`);
  lines.push('To inspect it, call view_image on that path.');
  return lines.join('\n');
}

function captionFor(
  backend: ImageBackendConfig,
  prompt: string,
  paid = backend.provider === 'sdcpp' ? '' : ` (paid ${backend.provider} API)`,
): string {
  // A cloud render may run with no prompt (`confirm_each: false`), so the
  // caption and the result are where the user learns it was billed.
  return `🖼 ${backend.name}${paid}: ${prompt.slice(0, CAPTION_PROMPT_CHARS)}${prompt.length > CAPTION_PROMPT_CHARS ? '…' : ''}`;
}

/** `count` validated, not clamped: a silent clamp renders a different number of images than the caller asked for. */
function parseCount(requested: unknown): number {
  if (requested === undefined || requested === null) return 1;
  const value = typeof requested === 'number' ? requested : Number(String(requested).trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_IMAGE_VARIATIONS) {
    throw new Error(
      `generate_image: count must be an integer from 1 to ${MAX_IMAGE_VARIATIONS}; got ` +
        `${String(requested)}. Each variation is a full render, so ask for at most ` +
        `${MAX_IMAGE_VARIATIONS}.`,
    );
  }
  return value;
}

interface SavedImage {
  absolute: string;
  display: string;
  deliveryLine: string;
}

/**
 * Write one image and queue it for the watching chats, with the shipped
 * delivery rule: a `confirm_each` backend sends unbudgeted, anything else goes
 * through the per-turn file budget.
 */
async function saveImage(
  deps: GenerateImageDeps,
  backend: ImageBackendConfig,
  target: string,
  bytes: Buffer,
  context: ToolHandlerContext | undefined,
  caption: string,
): Promise<SavedImage> {
  const absolute = await resolveRealWorkspacePath(target, undefined, { allowMissing: true });
  context?.beforeMutate([absolute]);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, bytes);
  await (deps.reveal ?? revealBeside)(absolute).catch(() => undefined);
  const deliveryEvent = {
    ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
    text: caption,
    imagePath: absolute,
  };
  const delivery =
    backend.confirm_each === true
      ? {
          kind: 'queued' as const,
          chats: await deps.notifications.deliverImageUnbudgeted('confirm_each', deliveryEvent),
        }
      : await deps.notifications.deliverFile(deliveryEvent);
  return {
    absolute,
    display: displayPath(absolute),
    // "Queued", not "Sent": deliverImage returns the number of chats the send
    // was queued for on the turn's tail. The send runs later and can still
    // fail, so claiming it was sent overclaims — the same reason send_file and
    // render_html_to_image say Queued.
    deliveryLine:
      delivery.kind === 'refused'
        ? `Saved to ${displayPath(absolute)}, not sent: per-turn file limit (${delivery.reason})`
        : delivery.chats > 0
          ? `Queued for ${delivery.chats} remote chat(s).`
          : 'No remote chat is watching this turn, so nothing was sent to a phone.',
  };
}

/**
 * Provider dispatch for the `sdcpp` half: references, then one render per
 * variation, then save. No fallback: a local refusal is an error.
 */
async function runLocalVariations(
  deps: GenerateImageDeps,
  config: ImageGenerationConfig,
  backend: Extract<ImageBackendConfig, { provider: 'sdcpp' }>,
  prompt: string,
  args: Record<string, unknown>,
  alternatives: readonly string[],
  count: number,
  now: Date,
  context: ToolHandlerContext | undefined,
): Promise<string> {
  const server = deps.sdServers?.().get(backend.name);
  if (!server) {
    throw new Error(
      `generate_image: this Forge window built no sd-server for image_generation.backends.` +
        `${backend.name}, so nothing was rendered. ` +
        (process.platform === 'win32'
          ? 'Reload the window after adding the backend, or use '
          : 'sdcpp backends need Windows, so remove this backend here, or use ') +
        `${alternatives.length ? `backend ${alternatives.join(' or ')}` : 'a cloud image backend'}.`,
    );
  }
  const localDeps: LocalRenderDeps = {
    ...(deps.generateLocal ? { generateLocal: deps.generateLocal } : {}),
    ...(deps.generateJob ? { generateJob: deps.generateJob } : {}),
    ...(deps.onReferenceSpawn ? { onReferenceSpawn: deps.onReferenceSpawn } : {}),
    ...(deps.ffmpegTools ? { ffmpegTools: deps.ffmpegTools } : {}),
    ...(deps.runReference ? { runReference: deps.runReference } : {}),
    ffmpegPath: deps.getConfig().video?.ffmpeg_path ?? '',
  };
  // References are read and downscaled BEFORE any GPU work, so a bad path, an
  // unsupported format, or a missing ffmpeg costs no render.
  const references = await prepareLocalReferences(
    backend,
    Array.isArray(args['reference_paths']) ? args['reference_paths'] : [],
    {
      deps: localDeps,
      alternatives,
      ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
    },
  );

  // Data-loss guard (A22): an edit must never write over the picture it reads.
  // The real extension is only known after the render, so the comparison runs on
  // the extension-stripped stem, here, before the first render. Both sides are
  // made absolute first: `targetPath` answers workspace-relative while the
  // references are absolute, and comparing the two spellings directly would miss
  // the ordinary case of `path: "sketch.png"` against an absolute reference.
  if (references) {
    for (let index = 0; index < count; index += 1) {
      const probe = targetPath(
        config,
        args['path'],
        prompt,
        PNG_PROBE,
        now,
        count > 1 ? index : undefined,
      );
      // Resolve the output exactly as `saveImage` will (realpath-aware), so a
      // junction inside the workspace cannot slip a write onto a reference.
      const realOutput = await resolveOutputForCollision(probe);
      if (!realOutput) continue;
      const collision = outputCollidesWithReference(realOutput, references.absolutePaths);
      if (collision) {
        throw new Error(
          `generate_image: the output "${realOutput}" is the reference image "${collision}". An edit ` +
            'cannot overwrite its own source — choose a different `path`, or leave it out.',
        );
      }
    }
  }

  const seeds = distinctSeeds(count, deps.seed);
  const saved: Array<
    SavedImage & {
      seed: number;
      width: number;
      height: number;
      mime: string;
      bytes: number;
      mode: string;
    }
  > = [];
  let partialNote: string | undefined;
  for (let index = 0; index < count; index += 1) {
    let image;
    try {
      image = await renderLocalVariation({
        backend,
        server,
        prompt,
        size: args['size'],
        seed: seeds[index] as number,
        alternatives,
        ...(references ? { references } : {}),
        deps: localDeps,
        ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
      });
    } catch (error) {
      if (saved.length === 0) throw error;
      // A25: an earlier variation is already on disk. Name what was saved and
      // say plainly that the rest was not produced.
      partialNote =
        `Variation ${index + 1} of ${count} was not produced: ` +
        `${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    const target = targetPath(
      config,
      args['path'],
      prompt,
      image,
      now,
      count > 1 ? index : undefined,
    );
    const entry = await saveImage(
      deps,
      backend,
      target,
      image.bytes,
      context,
      captionFor(backend, prompt, ''),
    );
    saved.push({
      ...entry,
      seed: image.seed,
      width: image.width,
      height: image.height,
      mime: image.mime,
      bytes: image.bytes.length,
      mode: image.mode,
    });
  }

  const lines = saved.map((entry) =>
    [
      `${GENERATED_IMAGE_PREFIX}${entry.display} (${entry.mime}, ${entry.bytes.toLocaleString()} bytes) ` +
        `with backend ${backend.name}.`,
      entry.deliveryLine,
      `Rendered locally at ${entry.width}x${entry.height}, seed ${entry.seed}.`,
    ].join('\n'),
  );
  lines.push(
    `Rendered locally through ${saved[0]?.mode ?? 'txt2img'}` +
      `${references ? ` with ${references.prepared.length} reference image(s)` : ''}.`,
  );
  for (const note of references?.notes ?? []) lines.push(note);
  if (partialNote) lines.push(partialNote);
  lines.push('To inspect it, call view_image on that path.');
  return lines.join('\n');
}

/** A stand-in for the naming rules before the real format is known. */
const PNG_PROBE: GeneratedImage = { bytes: Buffer.alloc(0), mime: 'image/png' };

/** Distinct seeds, reported so a good one can be re-run exactly. */
function distinctSeeds(count: number, seed: (() => number) | undefined): number[] {
  const draw = seed ?? randomSeed;
  const seeds = new Set<number>();
  while (seeds.size < count) seeds.add(draw());
  return [...seeds];
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

/**
 * Naming and description helpers moved to `generateImageToolFormat.ts` (one
 * implementation per concern) and re-exported here so existing importers and
 * tests keep working unchanged.
 */
export { backendCostTag, pickBackend, targetPath } from './generateImageToolFormat';

async function revealBeside(filePath: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), {
    preview: true,
    preserveFocus: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
}
