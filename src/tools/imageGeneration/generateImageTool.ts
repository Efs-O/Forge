import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { SdServerBackend } from '../../backend/SdServerBackend';
import type { ForgeConfig, ImageBackendConfig, ImageGenerationConfig } from '../../config/types';
import type { ToolDefinition } from '../../llm/types';
import type { UserNotificationService } from '../../sidebar/UserNotificationService';
import { resolveRealWorkspacePath } from '../../util/WorkspacePaths';
import { GENERATED_IMAGE_PREFIX } from '../../sidebar/toolResultView';
import type { RegisteredTool, ToolHandlerContext } from '../ToolRegistry';
import { generateCloudImage, type GeneratedImage } from './cloudImageBackend';
import {
  generateSdcppImage,
  type SdcppGeneratedImage,
  type SdcppImageRequest,
} from './sdcppImageBackend';

const MAX_PROMPT_CHARS = 4_000;
const CAPTION_PROMPT_CHARS = 200;

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
};
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

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
  /** Injectable for tests; production opens the saved file beside the chat. */
  reveal?: (filePath: string) => Promise<void>;
  now?: () => Date;
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

  const image =
    backend.provider === 'sdcpp'
      ? await generateLocal(deps, backend, prompt, args['size'], alternatives, context)
      : await (deps.generate ?? generateCloudImage)({
          backend,
          prompt,
          secrets: deps.secrets,
          ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
        });

  const target = targetPath(
    config,
    args['path'],
    prompt,
    image,
    (deps.now ?? (() => new Date()))(),
  );
  const absolute = await resolveRealWorkspacePath(target, undefined, { allowMissing: true });
  context?.beforeMutate([absolute]);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, image.bytes);

  await (deps.reveal ?? revealBeside)(absolute).catch(() => undefined);
  // A cloud render may run with no prompt (`confirm_each: false`), so the
  // caption and the result are where the user learns it was billed.
  const paid = backend.provider === 'sdcpp' ? '' : ` (paid ${backend.provider} API)`;
  const caption = `🖼 ${backend.name}${paid}: ${prompt.slice(0, CAPTION_PROMPT_CHARS)}${prompt.length > CAPTION_PROMPT_CHARS ? '…' : ''}`;
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

  const lines = [
    `${GENERATED_IMAGE_PREFIX}${displayPath(absolute)} (${image.mime}, ${image.bytes.length.toLocaleString()} bytes) with backend ${backend.name}.`,
    // "Queued", not "Sent": deliverImage returns the number of chats the send
    // was queued for on the turn's tail. The send runs later and can still
    // fail, so claiming it was sent overclaims — the same reason send_file and
    // render_html_to_image say Queued.
    delivery.kind === 'refused'
      ? `Saved to ${displayPath(absolute)}, not sent: per-turn file limit (${delivery.reason})`
      : delivery.chats > 0
        ? `Queued for ${delivery.chats} remote chat(s).`
        : 'No remote chat is watching this turn, so nothing was sent to a phone.',
  ];
  if (paid) lines.push(`This was a paid ${backend.provider} API call, billed per image.`);
  if (isLocalImage(image)) {
    lines.push(`Rendered locally at ${image.width}x${image.height}, seed ${image.seed}.`);
  } else if (sizeRequested) {
    lines.push('The size argument applies to local backends only, so this backend ignored it.');
  }
  if (image.revisedPrompt) lines.push(`The provider rewrote the prompt as: ${image.revisedPrompt}`);
  lines.push('To inspect it, call view_image on that path.');
  return lines.join('\n');
}

/**
 * Only the local backend reports how it rendered. A predicate rather than
 * `'seed' in image`: `SdcppGeneratedImage` is an intersection, so `in` does not
 * pick it out of the union and `width`/`height` stay invisible to the compiler.
 */
function isLocalImage(image: GeneratedImage | SdcppGeneratedImage): image is SdcppGeneratedImage {
  return 'seed' in image;
}

/** Provider dispatch for the `sdcpp` half. No fallback: a local refusal is an error. */
async function generateLocal(
  deps: GenerateImageDeps,
  backend: Extract<ImageBackendConfig, { provider: 'sdcpp' }>,
  prompt: string,
  size: unknown,
  alternatives: readonly string[],
  context: ToolHandlerContext | undefined,
): Promise<SdcppGeneratedImage> {
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
  return (deps.generateLocal ?? generateSdcppImage)({
    backend,
    server,
    prompt,
    alternatives,
    ...(size !== undefined ? { size } : {}),
    ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
  });
}

/**
 * The saved path as the result states it: workspace-relative with `/`
 * separators, so the sidebar can turn it into a thumbnail URL. A model may pass
 * an absolute path inside the workspace; the result still reports it relative.
 */
function displayPath(absolute: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const relative = root ? path.relative(root, absolute) : absolute;
  return relative.split(path.sep).join('/');
}

export function pickBackend(
  config: ImageGenerationConfig,
  requested: unknown,
): ImageBackendConfig | undefined {
  const name =
    typeof requested === 'string' && requested.trim() ? requested.trim() : config.default;
  if (name === undefined) return config.backends[0];
  return config.backends.find((backend) => backend.name === name);
}

/**
 * The cost tag the model sees for each backend, derived from `provider` alone —
 * no new config field. An `sdcpp` entry has no `model`, so printing
 * `backend.model` here would advertise `undefined`.
 */
export function backendCostTag(backend: ImageBackendConfig): string {
  if (backend.provider === 'sdcpp') {
    return `local · free · sdcpp · ${modelLabel(backend.diffusion_model)}`;
  }
  return `cloud · billed per image · ${backend.provider} · ${backend.model}`;
}

/** `V:/models/qwen_image_2.1-Q4_K.gguf` -> `qwen_image_2.1-Q4_K`. */
function modelLabel(modelPath: string): string {
  const base = path.win32.basename(modelPath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Workspace-relative save path, with the extension taken from the real bytes. */
export function targetPath(
  config: ImageGenerationConfig,
  requested: unknown,
  prompt: string,
  image: GeneratedImage,
  now: Date,
): string {
  const extension = EXTENSION_BY_MIME[image.mime] ?? '.img';
  if (typeof requested === 'string' && requested.trim()) {
    const raw = requested.trim();
    const current = path.extname(raw).toLowerCase();
    return (IMAGE_EXTENSIONS.has(current) ? raw.slice(0, -current.length) : raw) + extension;
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'image';
  return path.posix.join(config.output_dir.replace(/\\/g, '/'), `${stamp}-${slug}${extension}`);
}

function describeWithBackends(
  base: ToolDefinition,
  config: ImageGenerationConfig | undefined,
): ToolDefinition {
  if (!config) return base;
  const names = config.backends.map((backend) => backend.name);
  const fallback = config.default ?? names[0];
  const listing = config.backends
    .map((backend) => `${backend.name} (${backendCostTag(backend)})`)
    .join('; ');
  const properties = base.function.parameters['properties'] as Record<string, unknown>;
  return {
    ...base,
    function: {
      ...base.function,
      parameters: {
        ...base.function.parameters,
        properties: {
          ...properties,
          backend: {
            type: 'string',
            enum: names,
            description: `Image backend. Omit for the default (${fallback}). Available: ${listing}.`,
          },
        },
      },
    },
  };
}

async function revealBeside(filePath: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), {
    preview: true,
    preserveFocus: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
}
