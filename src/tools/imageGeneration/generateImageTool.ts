import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig, ImageBackendConfig, ImageGenerationConfig } from '../../config/types';
import type { ToolDefinition } from '../../llm/types';
import type { UserNotificationService } from '../../sidebar/UserNotificationService';
import { resolveWorkspacePath } from '../../util/WorkspacePaths';
import { GENERATED_IMAGE_PREFIX } from '../../sidebar/toolResultView';
import type { RegisteredTool, ToolHandlerContext } from '../ToolRegistry';
import { generateCloudImage, type GeneratedImage } from './cloudImageBackend';

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
  /** Injectable for tests. */
  generate?: typeof generateCloudImage;
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
          'Generate an image from a text prompt with a configured image model and save it into the workspace. Each call asks the user to approve it, and cloud backends bill per image, so write one good prompt rather than retrying variations. The image is opened in the editor and sent to the remote chat watching this turn, if any. It is NOT added to your context: call view_image on the saved path if you need to look at it.',
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
      return {
        dangerous: backend.confirm_each,
        detail:
          `${backend.name} (${backend.provider} · ${backend.model})` +
          `${backend.confirm_each ? ' — billed per image' : ''}\n\n${prompt.slice(0, 600)}`,
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

  const image = await (deps.generate ?? generateCloudImage)({
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
  const absolute = resolveWorkspacePath(target, { mustBeInsideWorkspace: true });
  context?.beforeMutate([absolute]);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, image.bytes);

  await (deps.reveal ?? revealBeside)(absolute).catch(() => undefined);
  const caption = `🖼 ${backend.name}: ${prompt.slice(0, CAPTION_PROMPT_CHARS)}${prompt.length > CAPTION_PROMPT_CHARS ? '…' : ''}`;
  const reached = await deps.notifications.deliverImage({
    ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
    text: caption,
    imagePath: absolute,
  });

  const lines = [
    `${GENERATED_IMAGE_PREFIX}${displayPath(absolute)} (${image.mime}, ${image.bytes.length.toLocaleString()} bytes) with backend ${backend.name}.`,
    reached > 0
      ? `Sent to ${reached} remote chat(s).`
      : 'No remote chat is watching this turn, so nothing was sent to a phone.',
  ];
  if (image.revisedPrompt) lines.push(`The provider rewrote the prompt as: ${image.revisedPrompt}`);
  lines.push('To inspect it, call view_image on that path.');
  return lines.join('\n');
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
    .map((backend) => `${backend.name} (${backend.provider} · ${backend.model})`)
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
