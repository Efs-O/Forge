/**
 * What the desktop advertises to a laptop (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md).
 *
 * Split from `remoteMediaJobs.ts` by the 500-line gate and by the concern: this
 * file answers "what do you have, what will you render, and why not the rest",
 * and reads nothing but the config and the tool definitions the job runner
 * would build. The laptop's `Check connection` line is built from this payload.
 */
import * as path from 'path';
import type { ForgeConfig, ImageBackendConfig } from '../config/types';
import type { ToolDefinition } from '../llm/types';
import { backendCostTag } from '../tools/imageGeneration/generateImageToolFormat';
import {
  SDCPP_SIZES,
  SDCPP_SIZE_NAMES,
  type SdcppSizeName,
} from '../tools/imageGeneration/sdcppImageBackend';
import type { RegisteredTool } from '../tools/ToolRegistry';
import type { RemoteMediaCapabilities, RemoteMediaTool } from './remoteMediaContract';

/** True when a local backend's configured paths are relative: with the job
 *  folder as the workspace root they would resolve inside it, so the backend
 *  cannot be served and the laptop is told so instead of failing mid-render. */
function hasRelativePaths(backend: ImageBackendConfig): boolean {
  if (backend.provider !== 'sdcpp') return false;
  return [backend.binary, backend.diffusion_model, backend.text_encoder, backend.vae].some(
    (value) => !path.isAbsolute(value) && !/^[a-zA-Z]:[\\/]/u.test(value),
  );
}

function sizeListing(backend: ImageBackendConfig): string[] | undefined {
  if (backend.provider !== 'sdcpp') return undefined;
  const sizes = backend.sizes ?? SDCPP_SIZES;
  return SDCPP_SIZE_NAMES.map(
    (name: SdcppSizeName) => `${name} ${sizes[name].width}x${sizes[name].height}`,
  );
}

/**
 * The capabilities payload.
 *
 * `tools[]` carries the job-scoped instances' own definitions, so the argument
 * schema has one owner (the desktop tool) and a desktop upgrade reaches the
 * laptop with no laptop edit. `instances` is the job runner's own builder, so
 * what is advertised is exactly what would run.
 */
export function buildCapabilities(
  config: ForgeConfig,
  instances: (root: string) => Partial<Record<RemoteMediaTool, RegisteredTool>>,
): RemoteMediaCapabilities {
  const relay = config.cloud_relay;
  const media = relay?.media;
  const image = config.image_generation;
  const listed = new Set(media?.image_backends ?? []);
  const refused: Array<{ name: string; reason: string }> = [];
  const backends: NonNullable<RemoteMediaCapabilities['image']>['backends'] = [];
  const served: RemoteMediaTool[] = [];
  for (const backend of image?.backends ?? []) {
    if (!listed.has(backend.name)) {
      refused.push({
        name: backend.name,
        reason: 'not listed in cloud_relay.media.image_backends',
      });
      continue;
    }
    if (hasRelativePaths(backend)) {
      refused.push({
        name: backend.name,
        reason: 'its configured paths are relative, so they would resolve inside the job folder',
      });
      continue;
    }
    const sizes = sizeListing(backend);
    backends.push({
      name: backend.name,
      paid: backend.provider !== 'sdcpp',
      confirm_each: backend.confirm_each,
      cost: backendCostTag(backend),
      reference_images: backend.provider === 'sdcpp' && backend.vision_encoder !== undefined,
      ...(sizes ? { sizes } : {}),
    });
    if (!served.includes('generate_image')) served.push('generate_image');
  }
  const upscaleConfigured = image?.upscale !== undefined;
  const upscale = media?.upscale === true && upscaleConfigured;
  if (upscaleConfigured && !upscale) {
    refused.push({ name: 'upscale_image', reason: 'cloud_relay.media.upscale is false' });
  }
  if (upscale && !served.includes('upscale_image')) served.push('upscale_image');
  for (const engine of config.media?.video?.engines ?? []) {
    refused.push({ name: engine.id, reason: 'generate_video is not served yet' });
  }
  for (const engine of config.media?.music?.engines ?? []) {
    refused.push({ name: engine.id, reason: 'generate_music is not served yet' });
  }
  const built = instances('');
  const definitions: Partial<Record<RemoteMediaTool, ToolDefinition>> = {};
  for (const tool of served) {
    const instance = built[tool];
    if (instance) definitions[tool] = instance.definition;
  }
  const tools = served.flatMap((tool) => {
    const definition = definitions[tool];
    // Only a definition that really carries this tool's name is advertised: the
    // laptop's schema for `generate_image` must be `generate_image`'s own.
    if (!definition || definition.function.name !== tool) return [];
    return [{ ...definition, function: { ...definition.function, name: tool } }];
  });
  return {
    tools,
    ...(backends.length
      ? {
          image: {
            ...(image?.default ? { default: image.default } : {}),
            backends,
          },
        }
      : {}),
    upscale,
    refused,
    max_body_bytes: (relay?.max_body_mb ?? 32) * 1024 * 1024,
  };
}
