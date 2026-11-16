/**
 * Protocol readers for the desktop driver's JSON-line responses (plan §4.5).
 *
 * These exist as one module because they share a single rule the driver cannot
 * enforce from inside its own logic: a REQUIRED driver field is validated, never
 * defaulted. `num(v) => 0` cannot tell "the driver said 0" from "the driver said
 * nothing", and every consumer downstream — the coordinate transform, the
 * target-window gate, the text the model reads — treats the difference as real.
 * That is exactly how `desktop_windows` came to report every window as
 * `(0,0 0×0)` (report §3.1): the reader looked for `w.x`, the driver emits
 * `w.rect.x`, and the default filled the gap silently.
 *
 * So each reader here returns a validated value or throws a named error, and the
 * caller never has to know which field was missing.
 */
import type { CaptureFrame, PhysicalPoint } from './coordinateTransform';
import type { DesktopClickResult, DesktopFocusTarget, DesktopWindow } from './DesktopDriver';

/** Optional/absent-tolerant reads for fields that genuinely may be missing. */
export const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
export const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * Read the capture frame the driver reports, validating instead of defaulting.
 * Every field here is a term in the image_px/norm_1000 -> physical transform, so
 * a defaulted `0` would silently misplace input (or divide by zero) rather than
 * fail. Origins may be negative (a monitor left of the primary); sizes may not.
 */
export function readCaptureFrame(r: Record<string, unknown>): CaptureFrame {
  const origin = r['origin'] as { x?: unknown; y?: unknown } | undefined;
  const frame: CaptureFrame = {
    captureWidth: r['capture_width'] as number,
    captureHeight: r['capture_height'] as number,
    imageWidth: r['image_width'] as number,
    imageHeight: r['image_height'] as number,
    originX: origin?.x as number,
    originY: origin?.y as number,
  };
  const sizes = [frame.captureWidth, frame.captureHeight, frame.imageWidth, frame.imageHeight];
  const origins = [frame.originX, frame.originY];
  if (
    !sizes.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0) ||
    !origins.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    throw new Error(
      'desktop_capture: the driver returned an incomplete capture frame ' +
        '(size or origin missing) — refusing to map coordinates onto an unknown pixel space',
    );
  }
  return frame;
}

/**
 * Read the nested `rect` the driver actually returns for a window
 * (`Get-WindowInfo` emits `rect = @{x;y;width;height}`), validating rather than
 * defaulting. The old code read top-level `w.x`/`w.width` — fields that do not
 * exist — and `num()` turned every one of them into `0`, so `desktop_windows`
 * reported every window as `(0,0 0×0)` (report §3.1). A `0` from a missing
 * field is indistinguishable from a real coordinate, which is why required
 * driver fields are validated instead of defaulted.
 *
 * Origins may legitimately be negative (a monitor left of the primary); size
 * must be positive. Returns undefined for a malformed item, which the caller
 * drops rather than rendering as a plausible zero.
 */
export function readWindowRect(raw: unknown): DesktopWindow['rect'] | undefined {
  const rect = raw as { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | undefined;
  const x = rect?.x;
  const y = rect?.y;
  const width = rect?.width;
  const height = rect?.height;
  const ok =
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0;
  if (!ok) return undefined; // the caller names the skip; never a plausible 0x0
  return { x, y, width, height };
}

/**
 * The rect a focus target is bound to, in the same nested shape as list_windows.
 * The gate compares input points against it, so a defaulted 0×0 rect would bind a
 * target whose every point is "outside the approved window" — a real window, an
 * unfalsifiable refusal, and no hint that the driver never described its geometry.
 */
export function requireTargetRect(raw: unknown, title: string): DesktopWindow['rect'] {
  const rect = readWindowRect(raw);
  if (rect) return rect;
  throw new Error(
    `desktop_focus_window: the driver returned malformed geometry for "${title}"; ` +
      'cannot bind a target whose rect is unknown',
  );
}

/**
 * Read the monitor metadata the driver reports for a monitor capture, and
 * refuse a response that cannot say WHICH display it took.
 *
 * A monitor capture is the one capture whose result the model cannot check for
 * itself: it sees pixels, not a window title. If `monitor_index` is missing, or
 * names a display other than the one requested, or the count does not contain
 * the index, then "monitor 0" could have returned the virtual desktop or a
 * different screen while the text claimed otherwise. Defaulting those fields
 * (an absent index becoming `?`, an absent count becoming `0`) would turn a
 * protocol break into an apparently successful capture of the wrong region.
 */
export function readMonitorMetadata(
  r: Record<string, unknown>,
  requested: number,
  device: string,
): { index: number; count: number; device: string } {
  const index = r['monitor_index'];
  const count = r['monitor_count'];
  const bad = (why: string): Error =>
    new Error(
      `desktop_capture: the driver returned unusable monitor metadata (${why}) — refusing to ` +
        'report a monitor capture whose selected display cannot be identified',
    );
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw bad('monitor_index missing or not a whole number');
  }
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
    throw bad('monitor_count missing, not a whole number, or zero');
  }
  if (index !== requested) {
    throw bad(`monitor_index ${index} is not the requested display ${requested}`);
  }
  if (index >= count) {
    throw bad(`monitor_index ${index} is outside the reported range of ${count} display(s)`);
  }
  if (device === '') throw bad('monitor_device is empty');
  return { index, count, device };
}

/**
 * The identity block every input op carries: the approved window's HWND, pid and
 * process start time. The driver re-checks all three at SendInput time, so a
 * pid that was reused while the model was deciding gets refused rather than hit.
 */
export function identityFields(approved: {
  hwnd: string;
  pid: number;
  processStartTime?: number;
}): Record<string, unknown> {
  return {
    expected_hwnd: approved.hwnd,
    expected_pid: approved.pid,
    expected_start_time: approved.processStartTime ?? 0,
  };
}

/** How a focus target is named on the wire: by title, or by HWND. */
export function targetFieldsFor(target: DesktopFocusTarget): Record<string, string> {
  return target.kind === 'window' ? { title: target.title } : { window_id: target.id };
}

/**
 * Read the click op's reply: what keyboard focus did, and where the cursor
 * really landed. Both are reported, never assumed — a click that lands on a
 * label or a control's border changes nothing, and the tool used to say
 * `Clicked` as if it had. Absent fields stay absent rather than becoming a
 * confident `''`: the tool text says it could not read focus.
 */
export function readClickResult(
  r: Record<string, unknown>,
  aimed: PhysicalPoint,
): DesktopClickResult {
  const cursorX = optNum(r['cursor_x']);
  const cursorY = optNum(r['cursor_y']);
  const reason = r['focus_reason'];
  const beforeHwnd = str(r['focus_before_hwnd']);
  const afterHwnd = str(r['focus_after_hwnd']);
  const cursor =
    cursorX !== undefined && cursorY !== undefined ? { x: cursorX, y: cursorY } : undefined;
  return {
    focusBefore: str(r['focus_before']),
    focusAfter: str(r['focus_after']),
    ...(beforeHwnd ? { focusBeforeHwnd: beforeHwnd } : {}),
    ...(afterHwnd ? { focusAfterHwnd: afterHwnd } : {}),
    ...(typeof reason === 'string' && reason ? { focusReason: reason } : {}),
    ...(cursor ? { cursor } : {}),
    // ±2 px: the driver normalises the aim to 65535ths of the virtual desktop,
    // which rounds, so a correct click can land a pixel off its aim.
    ...(cursor
      ? { cursorOk: Math.abs(cursor.x - aimed.x) <= 2 && Math.abs(cursor.y - aimed.y) <= 2 }
      : {}),
  };
}
