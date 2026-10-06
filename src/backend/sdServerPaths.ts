import * as fs from 'fs/promises';
import type { SdcppImageBackendConfig } from '../config/types';

/**
 * The configured files an `sdcpp` backend needs, checked before the server is
 * spawned. Split from `SdServerBackend.ts` so the list of required paths has one
 * owner and one test surface, and so growing it (the vision tower) does not grow
 * the process-ownership class.
 *
 * Existence only. A present-but-wrong vision tower is caught by `sd-server`
 * itself, which validates it against the diffusion model's metadata and exits 1
 * within ~5 s (probe 0.8) — Forge's job there is to surface that fast crash as a
 * failure rather than let it look like a hang.
 */
export function requiredConfiguredPaths(
  config: SdcppImageBackendConfig,
): ReadonlyArray<readonly [string, string]> {
  return [
    ['binary', config.binary],
    ['diffusion_model', config.diffusion_model],
    ['text_encoder', config.text_encoder],
    ['vae', config.vae],
    // Optional: text-to-image works with no vision tower. When it IS set, a typo
    // must fail here rather than at the first reference edit.
    ...(config.vision_encoder ? [['vision_encoder', config.vision_encoder] as const] : []),
  ];
}

export async function verifyConfiguredPaths(config: SdcppImageBackendConfig): Promise<void> {
  for (const [key, configuredPath] of requiredConfiguredPaths(config)) {
    try {
      await fs.access(configuredPath);
    } catch (error) {
      throw new Error(
        `image_generation.backends.${config.name}.${key}: configured path ` +
          `"${configuredPath}" is unavailable (${error instanceof Error ? error.message : String(error)}); ` +
          'correct this path in config.yaml or install the configured file.',
      );
    }
  }
}
