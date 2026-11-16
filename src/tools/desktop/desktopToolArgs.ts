/**
 * Argument reading for the Windows desktop tool family, kept out of
 * `desktopTools.ts` so the family stays inside the 500-line gate — one
 * implementation per concern, not a second copy of the rules.
 *
 * `num` and `str` here are deliberately NOT `driverProtocol`'s: those read the
 * driver's replies and default a missing field to `0` / `''`, which is exactly
 * the mistake that made `desktop_windows` report every window as `(0,0 0×0)`.
 * These read the MODEL's arguments, where "absent" must stay absent.
 */
import type { CoordSpace } from './coordinateTransform';

export const num = (args: Record<string, unknown>, key: string): number | undefined =>
  typeof args[key] === 'number' ? (args[key] as number) : undefined;

export const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' && (args[key] as string) !== '' ? (args[key] as string) : undefined;

export const coordSpace = (args: Record<string, unknown>): CoordSpace | undefined => {
  const v = args.coord_space;
  return v === 'norm_1000' ? 'norm_1000' : v === 'image_px' ? 'image_px' : undefined;
};

/**
 * The HWND a focus call names. `desktop_windows` prints ids unquoted, so the
 * model sends a number as often as a string; both name the same window, and the
 * driver takes the HWND as a decimal string.
 */
export function windowIdArg(args: Record<string, unknown>): string | undefined {
  const v = args['window_id'];
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Read one coordinate action's point, capture and space, and refuse the call
 * when the model has no pixels to look at: every coordinate tool takes its point
 * from a `desktop_capture`, so on a non-vision model the model is guessing at
 * where to click. One guard for all of them, naming the tool that asked.
 */
export function pointArgs(
  args: Record<string, unknown>,
  toolName: string,
  isVisionModel: boolean | undefined,
): { x: number; y: number; capId: string; space: CoordSpace } {
  if (isVisionModel === false)
    throw new Error(
      `${toolName} requires a vision model because its capture_id comes from desktop_capture.`,
    );
  return {
    x: num(args, 'x') ?? NaN,
    y: num(args, 'y') ?? NaN,
    capId: str(args, 'capture_id') ?? '',
    space: coordSpace(args) ?? 'image_px',
  };
}
