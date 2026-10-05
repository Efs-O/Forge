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
import {
  DENY_VSCODE,
  TargetWindowGate,
  policyRefusalFor,
  revokeRefusedCodeTargets,
  type ApprovedWindow,
  type DesktopPolicy,
} from './targetWindowGate';
import type {
  DesktopCapture,
  DesktopClickOptions,
  DesktopDriver,
  DesktopPoint,
  DesktopWindow,
  WindowListing,
} from './DesktopDriver';
import { assertMonitorIndex } from './DesktopDriver';
import {
  num,
  optNum,
  readCaptureFrame,
  readMonitorMetadata,
  readWindowRect,
  str,
} from './driverProtocol';
import { PowerShellTransport, type DesktopTransport } from './PowerShellTransport';

// Re-export so existing imports (e.g. the unit test) keep working.
export type { DesktopTransport } from './PowerShellTransport';

/** A capture the driver has bound: its pixel frame + (for windows) its approval. */
interface CaptureRecord {
  frame: CaptureFrame;
  kind: 'window' | 'monitor';
  approved?: ApprovedWindow;
}

// Re-export so existing imports (the tool layer, and the gate/chord tests that
// sign against them) keep working after these pure rules moved to the contract.
export { isSystemChord } from './DesktopDriver';

/**
 * The desktop driver. Owns the B2 gate (approval + per-input check) and the
 * coordinate transform; the transport does the Windows calls.
 *
 * The desktop POLICY (plan Phase 3) arrives as a getter, never as a captured
 * Boolean: `permissions.desktop.allow_vscode` can change while the extension
 * host runs, and an input that lands after the change must see it. The driver
 * is the only owner of the approval and the capture records, so revocation is
 * reconciled here rather than in a second gate.
 */
export class PowerShellDesktopDriver implements DesktopDriver {
  private readonly gate = new TargetWindowGate();
  private readonly captures = new Map<string, CaptureRecord>();
  private captureCounter = 0;
  /** The currently approved control target (set by focus/capture). */
  private approved: ApprovedWindow | undefined;
  /** Live policy source. Deny-by-default when nothing is bound (no config read here). */
  private policyGetter: () => DesktopPolicy;

  constructor(
    private readonly transport: DesktopTransport = new PowerShellTransport(),
    policy: () => DesktopPolicy = () => DENY_VSCODE,
  ) {
    this.policyGetter = policy;
  }

  /** Bind (or rebind) the live policy source. Never stores a Boolean. */
  setPolicySource(policy: () => DesktopPolicy): void {
    this.policyGetter = policy;
  }

  /**
   * Read the live policy and reconcile the held state against it: the Code
   * approval and capture records it now refuses are dropped, nothing else
   * (`revokeRefusedCodeTargets` holds the rule and its reasons).
   */
  private currentPolicy(): DesktopPolicy {
    const policy = this.policyGetter();
    if (revokeRefusedCodeTargets(this.approved, this.captures, policy)) {
      this.approved = undefined;
      this.gate.clear();
    }
    return policy;
  }

  /**
   * Read-only view of the approved target, for the tool-layer approval
   * predicates. They must ask the driver rather than keep their own copy of
   * gate state, or the prompt and the gate can disagree.
   *
   * Reconciles the live policy first, so a confirmation prompt can never name a
   * window the gate would refuse a moment later.
   */
  approvedTarget(): ApprovedWindow | undefined {
    this.currentPolicy();
    return this.approved;
  }

  /**
   * Read-only view of the target a `capture_id` is bound to (undefined for a
   * monitor capture, which has no target). The coordinate tools' confirmation
   * prompt names THIS window — the one the call will act on — not whatever
   * happens to be approved now.
   */
  captureTarget(captureId: string): ApprovedWindow | undefined {
    this.currentPolicy();
    return this.captures.get(captureId)?.approved;
  }

  async listWindows(): Promise<WindowListing> {
    const r = await this.transport.send({ op: 'list_windows' });
    if (!Array.isArray(r['windows'])) {
      // A missing/renamed field is a protocol break, not an empty desktop.
      // Reporting "no visible windows" would send the model off to relaunch
      // something that is already on screen.
      throw new Error(
        'desktop_windows: the desktop driver returned no window list (protocol mismatch); ' +
          'retry, and if it persists the bundled driver does not match this build',
      );
    }
    const windows = r['windows'] as Record<string, unknown>[];
    const out: DesktopWindow[] = [];
    const skipped: string[] = [];
    for (const w of windows) {
      const id = str(w['id']);
      const title = str(w['title']);
      if (id === '' || title === '') continue; // no title => not a usable target (driver's own filter)
      const rect = readWindowRect(w['rect']);
      // A malformed item is NAMED IN THE RESULT, not merely logged: a list that
      // quietly lost a window is a quieter version of the 0×0 row it replaces.
      if (!rect) {
        skipped.push(`"${title}" (HWND ${id}) had malformed geometry and was skipped`);
        continue;
      }
      out.push({ id, title, rect });
    }
    return { windows: out, skipped };
  }

  /**
   * True when a window-capture request for `title` is already covered by the
   * current approval (the approved window's title contains it). The tool layer
   * prompts when this is false; `capture` then refuses to bind a different HWND
   * unless the caller says the user approved a new target.
   */
  coversTitle(title: string): boolean {
    this.currentPolicy();
    const t = title.toLowerCase();
    return this.approved !== undefined && t !== '' && this.approved.title.toLowerCase().includes(t);
  }

  async capture(
    target: { kind: 'window'; title: string } | { kind: 'monitor'; index: number },
    opts: { allowNewApproval?: boolean } = {},
  ): Promise<DesktopCapture> {
    // Enforced here as well as at the tool layer: a direct driver call must not
    // be able to reach the transport with `0.5` or `-1` and let PowerShell's
    // `[int]` cast pick a different display than the caller (and the user who
    // approved a capture) intended.
    if (target.kind === 'monitor') assertMonitorIndex(target.index);
    const op =
      target.kind === 'window'
        ? { op: 'capture', kind: 'window', title: target.title }
        : { op: 'capture', kind: 'monitor', index: target.index };
    const r = await this.transport.send(op);
    const frame = readCaptureFrame(r);
    const png = Buffer.from(str(r['png_base64']), 'base64');
    // Checked only AFTER the target-identity refusals below: a VS Code fork, a
    // UAC window, or a different HWND must still be named as the reason, even
    // when the driver also failed to produce pixels. A payload defect must never
    // mask a security refusal.
    const requireImage = (): void => {
      if (png.length === 0) {
        throw new Error(
          `desktop_capture: the driver returned an empty image for a ${target.kind} capture`,
        );
      }
    };
    const captureId = `cap-${++this.captureCounter}`;
    if (target.kind === 'window') {
      const startTime = optNum(r['process_start_time']);
      this.requireReadableStartTime(startTime, str(r['title']));
      const windowRect = readWindowRect(r['rect']);
      if (!windowRect) {
        throw new Error(
          `desktop_capture: the driver returned malformed geometry for "${str(r['title'])}"; ` +
            'cannot bind a control target whose rect is unknown',
        );
      }
      const approved: ApprovedWindow = {
        hwnd: str(r['hwnd']),
        pid: num(r['pid']),
        title: str(r['title']),
        className: str(r['class']),
        processName: str(r['process_name']),
        rect: windowRect,
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
      const gateResult = this.gate.approve(approved, this.currentPolicy());
      if (!gateResult.ok) throw new Error(gateResult.reason);
      requireImage();
      this.approved = approved;
      this.captures.set(captureId, { frame, kind: 'window', approved });
      return {
        captureId,
        kind: 'window',
        png,
        width: frame.imageWidth,
        height: frame.imageHeight,
        captureWidth: frame.captureWidth,
        captureHeight: frame.captureHeight,
        // `dpi_scale` is the one driver number that is NOT validated: it is
        // informational only. The coordinate transform uses the capture frame
        // (capture/image sizes + origin), never this value (B6), so a defaulted
        // 0 cannot misplace input — it would only print `dpi_scale=0`. If a
        // future phase makes it a term in any calculation, it must move to a
        // validating reader in driverProtocol.ts first.
        // Informational only — see the window-capture note above.
        dpiScale: num(r['dpi_scale']),
        origin: { x: frame.originX, y: frame.originY },
        approvedHwnd: approved.hwnd,
        approvedPid: approved.pid,
        title: approved.title,
      };
    }
    // Past the window branch `target` is a monitor request, so the metadata is
    // read unconditionally: a monitor capture that cannot name its display is a
    // refusal, never a frame with unknown identity.
    const monitor = readMonitorMetadata(r, target.index, str(r['monitor_device']));
    requireImage();
    this.captures.set(captureId, { frame, kind: 'monitor' });
    return {
      captureId,
      kind: 'monitor',
      png,
      width: frame.imageWidth,
      height: frame.imageHeight,
      captureWidth: frame.captureWidth,
      captureHeight: frame.captureHeight,
      dpiScale: num(r['dpi_scale']),
      origin: { x: frame.originX, y: frame.originY },
      monitorIndex: monitor.index,
      monitorCount: monitor.count,
      monitorDevice: monitor.device,
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
    const startTime = optNum(w['process_start_time']);
    this.requireReadableStartTime(startTime, str(w['title']));
    // Same nested-rect shape as list_windows. The gate below compares input
    // points against it, so a defaulted 0×0 rect would bind a target whose every
    // point is "outside the approved window" — a real window, an unfalsifiable
    // refusal, and no hint that the driver never described its geometry.
    const rect =
      readWindowRect(w['rect']) ??
      (() => {
        throw new Error(
          `desktop_focus_window: the driver returned malformed geometry for "${str(w['title'])}"; ` +
            'cannot bind a target whose rect is unknown',
        );
      })();
    const approved: ApprovedWindow = {
      hwnd: str(w['id']),
      pid: num(w['pid']),
      title: str(w['title']),
      className: str(w['class']),
      processName: str(w['process_name']),
      rect,
      ...(startTime !== undefined ? { processStartTime: startTime } : {}),
    };
    const gateResult = this.gate.approve(approved, this.currentPolicy());
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
    if (!record) {
      throw new Error(
        `unknown capture_id "${captureId}"; call desktop_capture first (a capture for a target the ` +
          'policy no longer allows is dropped, so a stale id can also mean the target was revoked)',
      );
    }
    if (record.kind === 'monitor' || !record.approved) {
      throw new Error(
        'coordinate actions require a window capture; capture the target window first',
      );
    }
    const physical = toPhysical(record.frame, coordSpace ?? 'image_px', cx, cy);
    const fg = await this.transport.send({ op: 'foreground' });
    // Policy re-checked per input (plan Phase 3 item 3): a capture taken while
    // the editor opt-in was on must not survive its revocation. `record.approved`
    // is the window THIS capture bound, so the check is against that window even
    // when it is no longer the last-approved one.
    const gateResult = this.gate.checkAgainst(
      record.approved,
      str(fg['hwnd']),
      physical,
      this.currentPolicy(),
    );
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
    const target = this.approved;
    if (!target) {
      throw new Error(
        'no approved target window; call desktop_focus_window or desktop_capture first',
      );
    }
    // The current-target path (type/press) re-applies the live policy too:
    // approval alone is not proof the target is still allowed. The local copy is
    // checked, not `this.approved`, because reading the policy may itself drop
    // the approval — the caller still gets the reason naming the refused window,
    // not a bare "no approved target" that hides what was revoked.
    const reason = policyRefusalFor(target, this.currentPolicy());
    if (reason) throw new Error(reason);
    return target;
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

/**
 * The extension-host singleton (the PowerControl pattern).
 *
 * `policy` is a getter, not a value: `makeDesktopTools` binds it to the live
 * config on every registration, and the driver calls it per input. Passing it
 * here (rather than reading config inside the driver) keeps the driver free of
 * `vscode` and of `.forge/config.yaml`, and keeps exactly one gate.
 */
export function getDesktopDriver(policy?: () => DesktopPolicy): PowerShellDesktopDriver {
  if (!singleton) singleton = new PowerShellDesktopDriver();
  if (policy) singleton.setPolicySource(policy);
  return singleton;
}
