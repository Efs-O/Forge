import { describe, expect, it } from 'vitest';
import {
  inRect,
  toPhysical,
  type CaptureFrame,
} from '../../src/tools/desktop/coordinateTransform';

/**
 * Phase 2 gate (plan §5): the DPI/coordinate transform, pure, no mouse.
 * Covers a non-zero origin, a second monitor at negative x, a downscaled image,
 * and the norm_1000 space the Qwen3-VL family grounds on.
 */
describe('desktop coordinate transform (B6)', () => {
  it('maps image_px with a non-zero origin, no downscale', () => {
    // A window captured at physical (100,50), 800×600, returned at the same size.
    const frame: CaptureFrame = {
      captureWidth: 800,
      captureHeight: 600,
      imageWidth: 800,
      imageHeight: 600,
      originX: 100,
      originY: 50,
    };
    expect(toPhysical(frame, 'image_px', 0, 0)).toEqual({ x: 100, y: 50 });
    expect(toPhysical(frame, 'image_px', 400, 300)).toEqual({ x: 500, y: 350 });
    expect(toPhysical(frame, 'image_px', 799, 599)).toEqual({ x: 899, y: 649 });
  });

  it('handles a second monitor at negative x', () => {
    // A 1920-wide monitor to the LEFT of the primary: origin x is negative.
    const frame: CaptureFrame = {
      captureWidth: 1920,
      captureHeight: 1080,
      imageWidth: 1920,
      imageHeight: 1080,
      originX: -1920,
      originY: 0,
    };
    expect(toPhysical(frame, 'image_px', 0, 0)).toEqual({ x: -1920, y: 0 });
    expect(toPhysical(frame, 'image_px', 100, 200)).toEqual({ x: -1820, y: 200 });
    expect(toPhysical(frame, 'image_px', 1919, 1079)).toEqual({ x: -1, y: 1079 });
  });

  it('scales a downscaled image back to capture pixels before adding origin', () => {
    // Capture is 1920×1080 physical; the image is downscaled to 960×540 (half).
    const frame: CaptureFrame = {
      captureWidth: 1920,
      captureHeight: 1080,
      imageWidth: 960,
      imageHeight: 540,
      originX: 64,
      originY: 32,
    };
    // image (480,270) is the centre → capture (960,540) → physical (1024,572).
    expect(toPhysical(frame, 'image_px', 480, 270)).toEqual({ x: 1024, y: 572 });
    // image (0,0) → capture (0,0) → physical origin.
    expect(toPhysical(frame, 'image_px', 0, 0)).toEqual({ x: 64, y: 32 });
  });

  it('maps norm_1000 through the image grid to physical', () => {
    const frame: CaptureFrame = {
      captureWidth: 1920,
      captureHeight: 1080,
      imageWidth: 960,
      imageHeight: 540,
      originX: 0,
      originY: 0,
    };
    // 500/1000 of the image (960,540) is image (480,270) → capture (960,540).
    expect(toPhysical(frame, 'norm_1000', 500, 500)).toEqual({ x: 960, y: 540 });
    // The full 1000 grid spans the whole capture.
    expect(toPhysical(frame, 'norm_1000', 1000, 1000)).toEqual({ x: 1920, y: 1080 });
    expect(toPhysical(frame, 'norm_1000', 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('throws on a zero image size so a bad capture cannot map everything to the origin', () => {
    const bad: CaptureFrame = {
      captureWidth: 800,
      captureHeight: 600,
      imageWidth: 0,
      imageHeight: 0,
      originX: 0,
      originY: 0,
    };
    expect(() => toPhysical(bad, 'image_px', 10, 10)).toThrow(/positive/);
  });

  it('inRect is inclusive on left/top and exclusive on right/bottom', () => {
    const rect = { x: 100, y: 50, width: 800, height: 600 };
    expect(inRect(rect, 100, 50)).toBe(true); // top-left corner
    expect(inRect(rect, 899, 649)).toBe(true); // one inside the bottom-right
    expect(inRect(rect, 900, 650)).toBe(false); // bottom-right corner (exclusive)
    expect(inRect(rect, 99, 50)).toBe(false); // just left
    expect(inRect(rect, 100, 49)).toBe(false); // just above
  });
});
