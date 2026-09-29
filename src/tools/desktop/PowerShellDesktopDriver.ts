/**
 * The long-lived Windows desktop driver (plan §4.5, §9). Spawns the bundled
 * `desktopDriver.ps1` (SendInput + GDI, per-monitor-DPI-aware, physical pixels)
 * and speaks one JSON object per line over stdin/stdout.
 *
 * Division of labor (Claude's Phase-2 sign-off, B2/B3/B6):
 *  - THIS wrapper owns the B2 gate: it holds the approval (HWND + pid + process
 *    start time) bound to a capture, applies the coordinate transform
 *    (image_px / norm_1000 -> physical px), and runs the pure TargetWindowGate
 *    BEFORE sending input. The PS script re-checks at SendInput time as the
 *    atomic backstop (the TS check goes stale across the IPC hop).
 *  - B3: the PS `finally` releases a held button mid-drag; THIS wrapper sends a
 *    `release_all` on dispose/abort, waits ~500 ms for the ack, then kills the
 *    child, and spawns a one-shot `-ReleaseAll` if the child never acked.
 *
 * The transport is injectable so the Phase-3 gate tests (B2 foreground check,
 * B3 abort-mid-drag) drive a fake without a real mouse or a PowerShell process.
 */
import {
  toPhysical,
  type CaptureFrame,
  type CoordSpace,
  type PhysicalPoint,
} from './coordinateTransform';
import { TargetWindowGate, type ApprovedWindow } from './targetWindowGate';
import type {
  DesktopCapture,
  DesktopClickOptions,
  DesktopDriver,
  DesktopPoint,
  DesktopWindow,
} from './DesktopDriver';
import { PowerShellTransport, type DesktopTransport } from './PowerShellTransport';

// Re-export so existing imports (e.g. the unit test) keep working.
export type { DesktopTransport } from './PowerShellTransport';

/** A capture the driver has bound: its pixel frame + (for windows) its approval. */
interface CaptureRecord {
  frame: CaptureFrame;
  kind: 'window' | 'monitor';
  approved?: ApprovedWindow;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optNum = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * System chords that are never AUTO-approved (B2): any `win` key, `alt+f4`, or
 * any `ctrl+alt+*` chord. The tool layer returns a `dangerous` approval for
 * these so the user must explicitly confirm; the driver itself does not refuse
 * them — an explicitly approved system chord on the approved target window is
 * allowed (the B2 target-window gate is the real protection).
 */
export function isSystemChord(keys: readonly string[]): boolean {
  const set = new Set(keys.map((k) => k.toLowerCase()));
  if (set.has('win')) return true;
  if (set.has('alt') && set.has('f4')) return true;
  if (set.has('ctrl') && set.has('alt')) return true;
  return false;
}

/**
 * The desktop driver. Owns the B2 gate (approval + per-input check) and the
 * coordinate transform; the transport does the Windows calls.
 */
export class PowerShellDesktopDriver implements DesktopDriver {
  private readonly gate = new TargetWindowGate();
  private readonly captures = new Map<string, CaptureRecord>();
  private captureCounter = 0;
  /** The currently approved control target (set by focus/capture). */
  private approved: ApprovedWindow | undefined;

  constructor(private readonly transport: DesktopTransport = new PowerShellTransport()) {}

  async listWindows(): Promise<DesktopWindow[]> {
    const r = await this.transport.send({ op: 'list_windows' });
    const windows = Array.isArray(r['windows']) ? (r['windows'] as Record<string, unknown>[]) : [];
    return windows.map((w) => ({
      id: str(w['id']),
      title: str(w['title']),
      rect: { x: num(w['x']), y: num(w['y']), width: num(w['width']), height: num(w['height']) },
    }));
  }

  /**
   * True when a window-capture request for `title` is already covered by the
   * current approval (the approved window's title contains it). The tool layer
   * prompts when this is false; `capture` then refuses to bind a different HWND
   * unless the caller says the user approved a new target.
   */
  coversTitle(title: string): boolean {
    const t = title.toLowerCase();
    return this.approved !== undefined && t !== '' && this.approved.title.toLowerCase().includes(t);
  }

  async capture(
    target: { kind: 'window'; title: string } | { kind: 'monitor'; index: number },
    opts: { allowNewApproval?: boolean } = {},
  ): Promise<DesktopCapture> {
    const op =
      target.kind === 'window'
        ? { op: 'capture', kind: 'window', title: target.title }
        : { op: 'capture', kind: 'monitor', index: target.index };
    const r = await this.transport.send(op);
    const frame: CaptureFrame = {
      captureWidth: num(r['capture_width']),
      captureHeight: num(r['capture_height']),
      imageWidth: num(r['image_width']),
      imageHeight: num(r['image_height']),
      originX: num((r['origin'] as { x?: number })?.x),
      originY: num((r['origin'] as { y?: number })?.y),
    };
    const png = Buffer.from(str(r['png_base64']), 'base64');
    const captureId = `cap-${++this.captureCounter}`;
    if (target.kind === 'window') {
      const startTime = optNum(r['process_start_time']);
      this.requireReadableStartTime(startTime, str(r['title']));
      const approved: ApprovedWindow = {
        hwnd: str(r['hwnd']),
        pid: num(r['pid']),
        title: str(r['title']),
        className: str(r['class']),
        processName: str(r['process_name']),
        rect: {
          x: num((r['rect'] as { x?: number })?.x),
          y: num((r['rect'] as { y?: number })?.y),
          width: num((r['rect'] as { width?: number })?.width),
          height: num((r['rect'] as { height?: number })?.height),
        },
        ...(startTime !== undefined ? { processStartTime: startTime } : {}),
      };
      // B2: the hard refusal (VS Code / UAC / taskbar) happens here, even though
      // the user already approved the capture — it overrides the approval.
      // Without a fresh user approval a capture may only re-bind the window that
      // is already approved — otherwise a capture would silently approve any
      // window for input, bypassing desktop_focus_window's prompt.
      if (!opts.allowNewApproval && approved.hwnd !== this.approved?.hwnd) {
        throw new Error(
          `"${approved.title}" is not the approved target window; approve it first (desktop_focus_window)`,
        );
      }
      const gateResult = this.gate.approve(approved);
      if (!gateResult.ok) throw new Error(gateResult.reason);
      this.approved = approved;
      this.captures.set(captureId, { frame, kind: 'window', approved });
      return {
        captureId,
        kind: 'window',
        png,
        width: frame.imageWidth,
        height: frame.imageHeight,
        dpiScale: num(r['dpi_scale']),
        origin: { x: frame.originX, y: frame.originY },
        approvedHwnd: approved.hwnd,
        approvedPid: approved.pid,
        title: approved.title,
      };
    }
    this.captures.set(captureId, { frame, kind: 'monitor' });
    return {
      captureId,
      kind: 'monitor',
      png,
      width: frame.imageWidth,
      height: frame.imageHeight,
      dpiScale: num(r['dpi_scale']),
      origin: { x: frame.originX, y: frame.originY },
    };
  }

  async focusWindow(
    target: { kind: 'window'; title: string } | { kind: 'windowId'; id: string },
  ): Promise<DesktopWindow> {
    const op =
      target.kind === 'window'
        ? { op: 'focus_window', title: target.title }
        : { op: 'focus_window', window_id: target.id };
    const r = await this.transport.send(op);
    const w = (r['window'] ?? r) as Record<string, unknown>;
    const rect = (w['rect'] ?? {}) as Record<string, unknown>;
    const startTime = optNum(w['process_start_time']);
    this.requireReadableStartTime(startTime, str(w['title']));
    const approved: ApprovedWindow = {
      hwnd: str(w['id']),
      pid: num(w['pid']),
      title: str(w['title']),
      className: str(w['class']),
      processName: str(w['process_name']),
      rect: {
        x: num(rect['x']),
        y: num(rect['y']),
        width: num(rect['width']),
        height: num(rect['height']),
      },
      ...(startTime !== undefined ? { processStartTime: startTime } : {}),
    };
    const gateResult = this.gate.approve(approved);
    if (!gateResult.ok) throw new Error(gateResult.reason);
    this.approved = approved;
    return { id: approved.hwnd, title: approved.title, rect: approved.rect };
  }

  private async resolvePoint(
    captureId: string,
    coordSpace: CoordSpace | undefined,
    cx: number,
    cy: number,
  ): Promise<{ physical: PhysicalPoint; approved: ApprovedWindow }> {
    const record = this.captures.get(captureId);
    if (!record) throw new Error(`unknown capture_id "${captureId}"; call desktop_capture first`);
    if (record.kind === 'monitor' || !record.approved) {
      throw new Error(
        'coordinate actions require a window capture; capture the target window first',
      );
    }
    const physical = toPhysical(record.frame, coordSpace ?? 'image_px', cx, cy);
    const fg = await this.transport.send({ op: 'foreground' });
    const gateResult = this.gate.checkAgainst(record.approved, str(fg['hwnd']), physical);
    if (!gateResult.ok) throw new Error(gateResult.reason);
    return { physical, approved: record.approved };
  }

  private identity(approved: ApprovedWindow): Record<string, unknown> {
    return {
      expected_hwnd: approved.hwnd,
      expected_pid: approved.pid,
      // The process start time is recorded at approve time (the capture/focus
      // response carries it); the driver re-checks it to close the pid-reuse gap.
      expected_start_time: approved.processStartTime ?? 0,
    };
  }

  async moveMouse(x: number, y: number, captureId: string, coordSpace?: CoordSpace): Promise<void> {
    const { physical, approved } = await this.resolvePoint(captureId, coordSpace, x, y);
    await this.transport.send({
      op: 'move',
      x: physical.x,
      y: physical.y,
      ...this.identity(approved),
    });
  }

  async click(
    x: number,
    y: number,
    opts: DesktopClickOptions,
    captureId: string,
    coordSpace?: CoordSpace,
  ): Promise<void> {
    const { physical, approved } = await this.resolvePoint(captureId, coordSpace, x, y);
    await this.transport.send({
      op: 'click',
      x: physical.x,
      y: physical.y,
      button: opts.button ?? 'left',
      clicks: opts.clicks ?? 1,
      ...this.identity(approved),
    });
  }

  async drag(
    from: DesktopPoint,
    to: DesktopPoint,
    captureId: string,
    coordSpace?: CoordSpace,
  ): Promise<void> {
    const a = await this.resolvePoint(captureId, coordSpace, from.x, from.y);
    const b = await this.resolvePoint(captureId, coordSpace, to.x, to.y);
    await this.transport.send({
      op: 'drag',
      from_x: a.physical.x,
      from_y: a.physical.y,
      to_x: b.physical.x,
      to_y: b.physical.y,
      ...this.identity(a.approved),
    });
  }

  async scroll(
    x: number,
    y: number,
    delta: DesktopPoint,
    captureId: string,
    coordSpace?: CoordSpace,
  ): Promise<void> {
    const { physical, approved } = await this.resolvePoint(captureId, coordSpace, x, y);
    await this.transport.send({
      op: 'scroll',
      x: physical.x,
      y: physical.y,
      delta_x: delta.x,
      delta_y: delta.y,
      ...this.identity(approved),
    });
  }

  async typeText(text: string): Promise<void> {
    const approved = this.requireApproved();
    await this.transport.send({ op: 'type', text, ...this.identity(approved) });
  }

  async press(keys: readonly string[]): Promise<void> {
    const approved = this.requireApproved();
    await this.transport.send({ op: 'press', keys: [...keys], ...this.identity(approved) });
  }

  private requireApproved(): ApprovedWindow {
    if (!this.approved) {
      throw new Error(
        'no approved target window; call desktop_focus_window or desktop_capture first',
      );
    }
    return this.approved;
  }

  /**
   * B2 / pid-reuse: refuse to approve a target whose process start time could
   * not be read. The driver's Test-Target backstop only runs the pid-reuse
   * check when start_time > 0, so approving a target with an unreadable start
   * time would silently disable the protection. Refusing is the safe default —
   * an elevated or system process we cannot verify is not approved.
   */
  private requireReadableStartTime(startTime: number | undefined, title: string): void {
    if (startTime === undefined || startTime <= 0) {
      throw new Error(
        `cannot verify the process start time for "${title}" (unreadable — elevated or system process); ` +
          'refusing to approve a target whose pid-reuse protection cannot be bound',
      );
    }
  }

  /** Dispose: release-all, wait for the ack, kill the child, one-shot backstop (B3). */
  async dispose(): Promise<void> {
    this.gate.clear();
    this.approved = undefined;
    this.captures.clear();
    await this.transport.dispose();
  }
}

let singleton: PowerShellDesktopDriver | undefined;

/** The extension-host singleton (the PowerControl pattern). */
export function getDesktopDriver(): PowerShellDesktopDriver {
  if (!singleton) singleton = new PowerShellDesktopDriver();
  return singleton;
}
