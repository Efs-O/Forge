import * as path from 'node:path';
import { ImageGenerationConfigSchema } from '../../src/config/imageGenerationSchema';
import type { SdcppImageBackendConfig } from '../../src/config/types';

export const SDCPP_MODEL_FIELDS = {
  binary: 'sd-server.exe',
  diffusion_model: 'diffusion.gguf',
  text_encoder: 'text-encoder.gguf',
  vae: 'vae.safetensors',
};

export function sdcppBackendConfig(
  root: string,
  overrides: Record<string, unknown> = {},
): SdcppImageBackendConfig {
  const parsed = ImageGenerationConfigSchema.parse({
    backends: [
      {
        name: 'qwen-local',
        provider: 'sdcpp',
        binary: path.join(root, SDCPP_MODEL_FIELDS.binary),
        diffusion_model: path.join(root, SDCPP_MODEL_FIELDS.diffusion_model),
        text_encoder: path.join(root, SDCPP_MODEL_FIELDS.text_encoder),
        vae: path.join(root, SDCPP_MODEL_FIELDS.vae),
        cuda_device: 2,
        text_encoder_on_cpu: true,
        port: 8093,
        min_free_vram_mb: 7000,
        idle_timeout_ms: 61_000,
        request_timeout_ms: 1000,
        defaults: { steps: 20, cfg_scale: 6, sampler: 'euler', width: 1024, height: 1024 },
        extra_args: [],
        confirm_on_start: true,
        confirm_each: false,
        ...overrides,
      },
    ],
  });
  const backend = parsed.backends[0];
  if (!backend || backend.provider !== 'sdcpp') {
    throw new Error('test config did not parse as sdcpp.');
  }
  return backend;
}
