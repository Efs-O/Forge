import { z } from 'zod';
import type { ImageGenerationConfig } from './types';

/**
 * `image_generation.upscale:` — the one-shot ESRGAN ×4 child (`sd-cli -M upscale`)
 * behind the `upscale_image` tool. Absent means the tool is never registered, so
 * a config without it pays no schema tokens (docs/plans/LOCAL_IMAGE_TURBO_3060_PLAN.md §4c).
 *
 * `binary` is `sd-cli`, NOT `sd-server`: a one-shot process frees its VRAM when
 * it exits, which is what lets an upscale run beside a resident image server
 * (measured: 864x1536 → 3456x6144 in 47 s on the 3060 using ~0.6 GB). There is
 * no port, no owner record and no idle timer here, so nothing outlives the call
 * except the `_x4.png` the tool writes.
 */
export const ImageUpscaleSchema = z.object({
  /** `sd-cli` (or `sd-cli.exe`). Checked for readability before the spawn. */
  binary: z.string().min(1),
  /**
   * The upscaler weights. `4x_foolhardy_Remacri.pth` is the model chosen in
   * probe 6: of the four tried it stayed closest to the original with natural
   * skin, where the others went plastic or added a grid.
   */
  model: z.string().min(1),
  /** CUDA ordinal, passed as `CUDA_VISIBLE_DEVICES`, same ordering the sdcpp backend uses. */
  cuda_device: z.number().int().nonnegative(),
  /**
   * Ceiling on one upscale. Measured: 47 s for 864x1536 on the 3060, 31 s for
   * 928x1664 on a 5060 Ti, so the default leaves ~6× headroom for a 2048-px
   * input, whose ×4 output is 8192 px — the largest thing this tool can ask for.
   */
  timeout_ms: z.number().int().min(5_000).max(3_600_000).default(300_000),
  /**
   * Refuse before starting when the card cannot give this much. Required, like
   * the backend's, because a gate that guesses is a gate that lies; measured
   * whole-card peak for ESRGAN alone was 974 MiB (~400 MiB of it the display).
   */
  min_free_vram_mb: z.number().int().positive(),
  /**
   * Longest edge an input may have. A 4000 px phone photo would become
   * 16000 px — hundreds of megabytes, and an output over Telegram's 50 MB
   * document limit. Refusing with the size named is cheaper than that.
   */
  max_input_edge_px: z.number().int().min(64).max(4096).default(2048),
});

/** The parsed `image_generation.upscale` block. */
export type ImageUpscaleConfig = z.infer<typeof ImageUpscaleSchema>;

/** Read the optional block off a live `image_generation` config. */
export function upscaleBlock(
  config: ImageGenerationConfig | undefined,
): ImageUpscaleConfig | undefined {
  return config?.upscale;
}
