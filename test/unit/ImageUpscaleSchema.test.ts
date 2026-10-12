import { describe, expect, it } from 'vitest';
import { ImageUpscaleSchema, upscaleBlock } from '../../src/config/imageUpscaleSchema';
import { ImageGenerationConfigSchema } from '../../src/config/imageGenerationSchema';

/**
 * `image_generation.upscale:` — the block that decides whether `upscale_image`
 * exists at all, so a bad parse is a missing tool rather than a bad render.
 * Checked through `ImageGenerationConfigSchema`, the way the loader parses it.
 */

const MINIMAL = {
  binary: '/models/sd-cli.exe',
  model: '/models/ESRGAN/4x_foolhardy_Remacri.pth',
  cuda_device: 0,
  min_free_vram_mb: 1_500,
};

function parse(block: Record<string, unknown>) {
  return ImageGenerationConfigSchema.parse({
    backends: [{ name: 'grok', provider: 'xai', model: 'img', confirm_each: true }],
    upscale: block,
  });
}

describe('image_generation.upscale schema', () => {
  it('fills the measured defaults for the two optional knobs', () => {
    const parsed = parse(MINIMAL).upscale!;
    expect(parsed.timeout_ms).toBe(300_000);
    expect(parsed.max_input_edge_px).toBe(2_048);
  });

  it('requires min_free_vram_mb — a gate that guesses is a gate that lies', () => {
    const { min_free_vram_mb: _dropped, ...withoutFloor } = MINIMAL;
    expect(() => parse(withoutFloor)).toThrow(/min_free_vram_mb/);
  });

  it('refuses an input cap that could not be honoured, and a timeout below one model load', () => {
    expect(() => parse({ ...MINIMAL, max_input_edge_px: 8_192 })).toThrow(/max_input_edge_px/);
    expect(() => parse({ ...MINIMAL, timeout_ms: 1_000 })).toThrow(/timeout_ms/);
  });

  it('leaves the block undefined when it is absent, so the tool stays unregistered', () => {
    const parsed = ImageGenerationConfigSchema.parse({
      backends: [{ name: 'grok', provider: 'xai', model: 'img', confirm_each: true }],
    });
    expect(upscaleBlock(parsed)).toBeUndefined();
    expect(upscaleBlock(undefined)).toBeUndefined();
    expect(upscaleBlock(parse(MINIMAL))?.model).toBe('/models/ESRGAN/4x_foolhardy_Remacri.pth');
  });

  it('is a zod object whose inferred type carries every documented key', () => {
    const keys = Object.keys(ImageUpscaleSchema.shape).sort();
    expect(keys).toEqual([
      'binary',
      'cuda_device',
      'max_input_edge_px',
      'min_free_vram_mb',
      'model',
      'timeout_ms',
    ]);
  });
});
