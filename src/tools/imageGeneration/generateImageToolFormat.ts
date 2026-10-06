import * as path from 'path';
import * as vscode from 'vscode';
import type { ToolDefinition } from '../../llm/types';
import type { ImageBackendConfig, ImageGenerationConfig } from '../../config/types';
import type { GeneratedImage } from './cloudImageBackend';

/**
 * Naming, description and cost-label helpers for `generate_image`, split out of
 * `generateImageTool.ts` so the run path stays reviewable and both files stay
 * under the 500-line gate. Everything here is pure: no fs, no server, no GPU.
 */

export const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
};
export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

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
export function modelLabel(modelPath: string): string {
  const base = path.win32.basename(modelPath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * The saved path as the result states it: workspace-relative with `/`
 * separators, so the sidebar can turn it into a thumbnail URL. A model may pass
 * an absolute path inside the workspace; the result still reports it relative.
 */
export function displayPath(absolute: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const relative = root ? path.relative(root, absolute) : absolute;
  return relative.split(path.sep).join('/');
}

/**
 * Workspace-relative save path, with the extension taken from the real bytes.
 *
 * `variationIndex` exists because `targetPath` returns `requested` unchanged
 * whenever `path` is given: with `count: 2` and an explicit path, both
 * variations would land on the same file and the second would overwrite the
 * first. So the suffix is applied on BOTH branches, default name and explicit
 * path alike, and a defined index always numbers the file — `count: 2` gives
 * `name-1` and `name-2`, never `name` plus `name-2`. `undefined` keeps the
 * historical single-image name byte-identical.
 */
export function targetPath(
  config: ImageGenerationConfig,
  requested: unknown,
  prompt: string,
  image: GeneratedImage,
  now: Date,
  variationIndex?: number,
): string {
  const extension = EXTENSION_BY_MIME[image.mime] ?? '.img';
  const suffix =
    variationIndex !== undefined && variationIndex >= 0 ? `-${variationIndex + 1}` : '';
  if (typeof requested === 'string' && requested.trim()) {
    const raw = requested.trim();
    const current = path.extname(raw).toLowerCase();
    const stem = IMAGE_EXTENSIONS.has(current) ? raw.slice(0, -current.length) : raw;
    return stem + suffix + extension;
  }
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const slug =
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'image';
  return path.posix.join(
    config.output_dir.replace(/\\/g, '/'),
    `${stamp}-${slug}${suffix}${extension}`,
  );
}

export function describeWithBackends(
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
