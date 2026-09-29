/**
 * The pure coordinate transform for the desktop tools (plan §4.3, §4.5, B6).
 *
 * All Windows input is in PHYSICAL pixels. The model reads a screenshot in one
 * of two spaces (`coord_space`):
 *   - `image_px`:  the returned image's own pixel grid.
 *   - `norm_1000`: a 0–1000 grid (the Qwen3-VL family grounds on this, not raw
 *     pixels — verified against the live model in Phase 5).
 *
 * The transform maps a model coordinate to a physical pixel:
 *   image px   = coord (image_px)  or  (coord / 1000) * image size (norm_1000)
 *   physical   = image px * (capture px / image px) + capture origin
 *
 * The DPI scale is reported for information only — it is NOT a term in the
 * transform (B6): the capture is already in physical pixels, so the scale from
 * image→capture→physical is fully captured by the two ratios above.
 *
 * This module is pure (no I/O, no Windows) so the Phase 2 gate test can drive
 * it with a negative-x second monitor and a downscaled image without a mouse.
 */

export type CoordSpace = 'image_px' | 'norm_1000';

export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The pixel space a capture binds (B2) and a coordinate action references. */
export interface CaptureFrame {
  /** The capture's actual width in physical pixels. */
  captureWidth: number;
  /** The capture's actual height in physical pixels. */
  captureHeight: number;
  /** The returned image's width (after any downscale). */
  imageWidth: number;
  /** The returned image's height (after any downscale). */
  imageHeight: number;
  /** Physical-pixel origin of the captured region (its top-left on the desktop). */
  originX: number;
  /** Physical-pixel origin y. */
  originY: number;
}

export interface PhysicalPoint {
  x: number;
  y: number;
}

/**
 * Map a model coordinate (in `coordSpace`) to a physical desktop pixel.
 * Throws on a malformed frame (zero image size) so a bad capture cannot
 * silently map every click to the origin.
 */
export function toPhysical(
  frame: CaptureFrame,
  coordSpace: CoordSpace,
  cx: number,
  cy: number,
): PhysicalPoint {
  if (frame.imageWidth <= 0 || frame.imageHeight <= 0) {
    throw new Error('coordinate transform: image dimensions must be positive');
  }
  if (frame.captureWidth <= 0 || frame.captureHeight <= 0) {
    throw new Error('coordinate transform: capture dimensions must be positive');
  }
  let imageX: number;
  let imageY: number;
  if (coordSpace === 'norm_1000') {
    imageX = (cx / 1000) * frame.imageWidth;
    imageY = (cy / 1000) * frame.imageHeight;
  } else {
    imageX = cx;
    imageY = cy;
  }
  return {
    x: imageX * (frame.captureWidth / frame.imageWidth) + frame.originX,
    y: imageY * (frame.captureHeight / frame.imageHeight) + frame.originY,
  };
}

/** True when the physical point is inside the rect (left/top inclusive, right/bottom exclusive). */
export function inRect(rect: DesktopRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
