/**
 * The contract for the Windows desktop input/capture driver (plan §4.2, §4.5).
 *
 * Phase 0 defines the interface only. The long-lived PowerShell implementation
 * (SendInput + GDI, per-monitor-DPI-aware, physical pixels) lands in Phase 2
 * with the desktop tools that call it (Claude adjustment #2: no body without a
 * caller). A native `SendInput` driver is the documented future swap-in behind
 * this same interface.
 *
 * Invariants the implementation MUST uphold (the gate tests in Phase 2/3 sign
 * against these):
 * - All coordinates are PHYSICAL pixels. The transform is
 *   `image px × (capture px / image px) + capture origin`; the DPI scale is
 *   reported, not a term in the transform (B6).
 * - The target-window gate (B2): before every input call the driver checks the
 *   foreground window is the approved HWND and the point is inside its rect,
 *   and always refuses any VS Code window, the secure desktop / UAC, and the
 *   taskbar. `press` is never auto-approved for system chords (`win+*`,
 *   `alt+f4`, `ctrl+alt+*`).
 * - OS input state (B3): a held key / mouse button is released in the driver's
 *   `finally`; on abort, timeout, or driver death a "release all" is sent so no
 *   key/button is left held on the live desktop.
 */

import type { CoordSpace } from './coordinateTransform';

export interface DesktopRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopPoint {
  x: number;
  y: number;
}

/** A top-level window, in physical pixels. */
export interface DesktopWindow {
  /** The HWND (as a string — HWNDs are pointer-sized and exceed safe int). */
  id: string;
  title: string;
  rect: DesktopRect;
}

export type DesktopCaptureTarget =
  | { kind: 'window'; title: string }
  | { kind: 'monitor'; index: number };

/**
 * Validate a monitor ordinal at the boundary that receives it.
 *
 * The index selects WHICH display is captured, and the PowerShell driver casts
 * its request value to `[int]` — so `0.5`, `-1`, `Infinity` or `NaN` arriving
 * unvalidated could silently select a different display than the caller asked
 * for, or the capture the user approved would not be the one taken. Both the
 * tool layer and the driver call this, so a direct driver call cannot skip it.
 * Valid integers past the last display are a different case: they are refused
 * by the driver, which knows the count.
 */
export function assertMonitorIndex(index: unknown): number {
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw new Error(
      `desktop_capture: monitor must be a whole number 0 or greater (got ${
        typeof index === 'number' ? String(index) : `${typeof index}`
      }); monitor 0 is the primary display, 1 the next, and so on`,
    );
  }
  return index;
}

/**
 * System chords that are never AUTO-approved (B2): any `win` key, `alt+f4`, or
 * any `ctrl+alt+*` chord. The tool layer returns a `dangerous` approval for
 * these so the user must explicitly confirm; the driver itself does not refuse
 * them — an explicitly approved system chord on the approved target window is
 * allowed (the B2 target-window gate is the real protection).
 *
 * Lives on the contract module beside `assertMonitorIndex` for the same reason:
 * a pure rule both the tool layer and the driver need, with one implementation.
 */
export function isSystemChord(keys: readonly string[]): boolean {
  const set = new Set(keys.map((k) => k.toLowerCase()));
  if (set.has('win')) return true;
  if (set.has('alt') && set.has('f4')) return true;
  if (set.has('ctrl') && set.has('alt')) return true;
  return false;
}

/**
 * A capture frame: the explicit pixel space a coordinate action references.
 * `captureId` binds the size, DPI scale, origin offset, AND the approved
 * HWND+pid (B2). There is no implicit global screen.
 *
 * A discriminated union, not one interface of optionals: the fields that make a
 * capture truthful about what it captured (the approved HWND for a window, the
 * selected display for a monitor) are REQUIRED on the branch that has them, so
 * a caller cannot render `?` for a monitor index the driver failed to report.
 */
interface DesktopCaptureBase {
  captureId: string;
  /** PNG bytes (the tool wraps these into a MultimodalToolResult). */
  png: Buffer;
  /** The returned image's width (after any downscale) — what the model is told about. */
  width: number;
  /** The returned image's height. */
  height: number;
  /** Reported for information only — not a term in the transform (B6). */
  dpiScale: number;
  /** Physical-pixel origin of the captured region (e.g. the window's top-left). */
  origin: DesktopPoint;
  /**
   * The PHYSICAL size of the region actually captured, before any downscale.
   * Distinct from `width`/`height` (the returned image): comparing an image
   * size to a physical rect is the mistake report §3.7 walked into.
   */
  captureWidth: number;
  captureHeight: number;
}

/** A window capture: binds the approved control target (B2). */
export interface DesktopWindowCapture extends DesktopCaptureBase {
  kind: 'window';
  approvedHwnd: string;
  approvedPid: number;
  /** The captured window's title. */
  title: string;
}

/** A monitor capture: read-only, and truthful about which display it took. */
export interface DesktopMonitorCapture extends DesktopCaptureBase {
  kind: 'monitor';
  /** The display actually captured — must equal the index that was requested. */
  monitorIndex: number;
  /** How many displays exist, so the caller can see the valid range. */
  monitorCount: number;
  /** The display's Win32 device name, e.g. `\\.\DISPLAY9`. */
  monitorDevice: string;
}

export type DesktopCapture = DesktopWindowCapture | DesktopMonitorCapture;

export type DesktopFocusTarget =
  | { kind: 'window'; title: string }
  | { kind: 'windowId'; id: string };

/** `listWindows` result: usable windows, plus named entries skipped as malformed. */
export interface WindowListing {
  windows: DesktopWindow[];
  /** Human-readable, model-facing reasons — one per dropped row. */
  skipped: string[];
}

export interface DesktopClickOptions {
  /** 'left' | 'right' | 'middle'. Default 'left'. */
  button?: 'left' | 'right' | 'middle';
  /** 1 = click, 2 = double-click. Default 1. */
  clicks?: number;
}

export interface DesktopDriver {
  /**
   * List top-level windows, plus any the driver reported but this layer refused
   * to describe. `skipped` exists so a malformed row cannot vanish: the tool
   * layer appends it to the result, so the model is told a window is there with
   * unreadable geometry instead of being shown a list that quietly lost it.
   */
  listWindows(): Promise<WindowListing>;
  /**
   * Capture a window (by title) or a monitor. Binds the approved HWND+pid to
   * the returned frame. A window capture is always allowed; a monitor capture
   * is gated by the cloud-model rule (plan §4.7) at the tool layer.
   *
   * `index` is the display ordinal, NOT a pixel offset: 0 is the PRIMARY
   * monitor, and the rest follow a deterministic order (physical left, top,
   * device name) re-enumerated per request. An index past the end is refused
   * with the available range — never silently widened to the whole virtual
   * desktop, which is what the driver used to do.
   */
  capture(target: DesktopCaptureTarget): Promise<DesktopCapture>;
  /** Focus + approve a window as the control target (binds HWND+pid). */
  focusWindow(target: DesktopFocusTarget): Promise<DesktopWindow>;
  /**
   * Move the cursor. `x`,`y` are in the model's `coordSpace` (image_px or
   * norm_1000); the driver converts to physical pixels via the capture's frame.
   */
  moveMouse(x: number, y: number, captureId: string, coordSpace?: CoordSpace): Promise<void>;
  click(
    x: number,
    y: number,
    opts: DesktopClickOptions,
    captureId: string,
    coordSpace?: CoordSpace,
  ): Promise<void>;
  drag(
    from: DesktopPoint,
    to: DesktopPoint,
    captureId: string,
    coordSpace?: CoordSpace,
  ): Promise<void>;
  scroll(
    x: number,
    y: number,
    delta: DesktopPoint,
    captureId: string,
    coordSpace?: CoordSpace,
  ): Promise<void>;
  /** Type text (KEYEVENTF_UNICODE). `consequential` is a tool-layer hint. */
  typeText(text: string): Promise<void>;
  /**
   * Press a chord of key names (e.g. `['ctrl','c']`). The driver refuses
   * system chords (`win+*`, `alt+f4`, `ctrl+alt+*`) — never auto-approved.
   */
  press(keys: readonly string[]): Promise<void>;
  /** Dispose the driver process. Idempotent; sends "release all" first (B3). */
  dispose(): Promise<void>;
}
