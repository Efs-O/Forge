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
 * A capture frame: the explicit pixel space a coordinate action references.
 * `captureId` binds the size, DPI scale, origin offset, AND the approved
 * HWND+pid (B2). There is no implicit global screen.
 */
export interface DesktopCapture {
  captureId: string;
  /** 'window' captures bind an approved control target; 'monitor' is a read-only screen crop. */
  kind: 'window' | 'monitor';
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
  /** The approved control target bound to this frame (B2). Absent for monitor captures. */
  approvedHwnd?: string;
  approvedPid?: number;
  /** The captured window's title (window captures). */
  title?: string;
}

export type DesktopFocusTarget =
  | { kind: 'window'; title: string }
  | { kind: 'windowId'; id: string };

export interface DesktopClickOptions {
  /** 'left' | 'right' | 'middle'. Default 'left'. */
  button?: 'left' | 'right' | 'middle';
  /** 1 = click, 2 = double-click. Default 1. */
  clicks?: number;
}

export interface DesktopDriver {
  /** List top-level windows. */
  listWindows(): Promise<DesktopWindow[]>;
  /**
   * Capture a window (by title) or a monitor. Binds the approved HWND+pid to
   * the returned frame. A window capture is always allowed; a monitor capture
   * is gated by the cloud-model rule (plan §4.7) at the tool layer.
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
