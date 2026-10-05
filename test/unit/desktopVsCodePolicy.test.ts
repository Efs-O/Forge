/**
 * Phase 3 items 2–4 at the DRIVER layer: the live `allow_vscode` policy is
 * re-read before every input, an input through an OLD `capture_id` is refused
 * once the policy is revoked, and revocation clears only the Code approval and
 * that window's captures.
 *
 * No PowerShell process and no real mouse: the transport is faked, and the
 * policy arrives as a getter (the same shape `makeDesktopTools` binds), so these
 * tests pin the lifetime the plan requires — a getter, not a captured Boolean.
 */
import { describe, it, expect } from 'vitest';
import {
  PowerShellDesktopDriver,
  type DesktopTransport,
} from '../../src/tools/desktop/PowerShellDesktopDriver';
import type { DesktopPolicy } from '../../src/tools/desktop/targetWindowGate';

class FakeTransport implements DesktopTransport {
  sent: Record<string, unknown>[] = [];
  private responses: Record<string, Record<string, unknown>> = {};
  /** Successive `capture` responses, consumed in order (last one repeats). */
  private captureQueue: Record<string, unknown>[] = [];
  foregroundHwnd = '0x1234';

  on(op: string, response: Record<string, unknown>): void {
    this.responses[op] = response;
  }

  /** Queue several capture responses for successive captures. */
  onCaptures(...responses: Record<string, unknown>[]): void {
    this.captureQueue = [...responses];
  }

  async send(op: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.sent.push(op);
    const opName = String(op['op'] ?? '');
    if (opName === 'capture' && this.captureQueue.length > 0) {
      return this.captureQueue.length === 1
        ? this.captureQueue[0]
        : this.captureQueue.shift()!;
    }
    if (opName === 'foreground') return { ok: true, hwnd: this.foregroundHwnd };
    return this.responses[opName] ?? { ok: true };
  }

  async dispose(): Promise<void> {
    this.sent.push({ op: 'dispose' });
  }

  opsNamed(op: string): Record<string, unknown>[] {
    return this.sent.filter((o) => o['op'] === op);
  }
}

/** A window-capture response for a given process name / hwnd / title. */
function captureResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    png_base64: Buffer.from('fake').toString('base64'),
    capture_width: 800,
    capture_height: 600,
    image_width: 800,
    image_height: 600,
    origin: { x: 100, y: 100 },
    dpi_scale: 1,
    hwnd: '0x1234',
    pid: 9999,
    title: 'Test Window',
    class: 'TestWindowClass',
    process_name: 'testapp',
    process_start_time: 1700000000000,
    rect: { x: 100, y: 100, width: 800, height: 600 },
    ...over,
  };
}

const CODE = {
  hwnd: '0x9999',
  pid: 7777,
  title: 'Forge - Visual Studio Code',
  class: 'Chrome_WidgetWin_1',
  process_name: 'Code',
};

/** A driver whose policy is a mutable live source, like the real config getter. */
function makeDriver(transport: FakeTransport, initial: DesktopPolicy) {
  let policy = initial;
  const driver = new PowerShellDesktopDriver(transport, () => policy);
  return {
    driver,
    /** Simulates the user editing `.forge/config.yaml` — no restart. */
    setPolicy(next: DesktopPolicy) {
      policy = next;
    },
  };
}

describe('driver live VS Code policy (Phase 3 item 2)', () => {
  it('refuses to approve Code by default, and approves it once opted in', async () => {
    const transport = new FakeTransport();
    transport.on('capture', captureResponse(CODE));
    const { driver } = makeDriver(transport, { allowVsCode: false });
    await expect(
      driver.capture({ kind: 'window', title: 'Forge' }, { allowNewApproval: true }),
    ).rejects.toThrow(/VS Code/);

    const transport2 = new FakeTransport();
    transport2.on('capture', captureResponse(CODE));
    const allowed = makeDriver(transport2, { allowVsCode: true });
    const cap = await allowed.driver.capture(
      { kind: 'window', title: 'Forge' },
      { allowNewApproval: true },
    );
    expect(cap.approvedHwnd).toBe('0x9999');
  });

  it('reads the policy per input, not once at construction', async () => {
    const transport = new FakeTransport();
    transport.on('capture', captureResponse(CODE));
    transport.foregroundHwnd = '0x9999';
    const { driver, setPolicy } = makeDriver(transport, { allowVsCode: true });
    const cap = await driver.capture(
      { kind: 'window', title: 'Forge' },
      { allowNewApproval: true },
    );
    await driver.moveMouse(10, 10, cap.captureId);
    expect(transport.opsNamed('move').length).toBe(1);

    // Flip the switch mid-session. The next input must see it.
    setPolicy({ allowVsCode: false });
    await expect(driver.moveMouse(10, 10, cap.captureId)).rejects.toThrow(/VS Code/);
    // And no second move reached the transport.
    expect(transport.opsNamed('move').length).toBe(1);
  });

  it('refuses an input through an OLD capture_id after revocation', async () => {
    const transport = new FakeTransport();
    transport.on('capture', captureResponse(CODE));
    transport.foregroundHwnd = '0x9999';
    const { driver, setPolicy } = makeDriver(transport, { allowVsCode: true });
    const cap = await driver.capture(
      { kind: 'window', title: 'Forge' },
      { allowNewApproval: true },
    );
    await driver.click(10, 10, {}, cap.captureId);

    setPolicy({ allowVsCode: false });
    // The capture_id is the stale handle: it still names a real capture record,
    // so the FIRST refusal after revocation comes from the policy re-check, not
    // from a missing id. That is the case the plan names explicitly.
    await expect(driver.click(10, 10, {}, cap.captureId)).rejects.toThrow(/VS Code/);
    // And the revocation also cleared the record, so every later attempt through
    // that id is refused too — there is no path back to input, and no capture
    // left to re-use. Asserting only the first refusal would let an
    // implementation that refuses but never clears pass.
    for (const act of [
      () => driver.click(10, 10, {}, cap.captureId),
      () => driver.moveMouse(10, 10, cap.captureId),
      () => driver.scroll(10, 10, { x: 0, y: 1 }, cap.captureId),
      () => driver.drag({ x: 10, y: 10 }, { x: 20, y: 20 }, cap.captureId),
    ]) {
      await expect(act()).rejects.toThrow(/unknown capture_id/);
    }
    // type/press are covered by their own test below, where they are the FIRST
    // input after revocation. Here the click above was first, so the approval
    // is already cleared and these see the cleared-state refusal — which is the
    // correct second-stage behaviour, and still no input.
    await expect(driver.typeText('into the chat box')).rejects.toThrow(/no approved target window/);
    await expect(driver.press(['ctrl', 'a'])).rejects.toThrow(/no approved target window/);
    expect(transport.opsNamed('click').length).toBe(1);
    expect(transport.opsNamed('type')).toEqual([]);
    expect(transport.opsNamed('press')).toEqual([]);
  });

  it('refuses type/press on the current target after revocation', async () => {
    const transport = new FakeTransport();
    transport.on('capture', captureResponse(CODE));
    const { driver, setPolicy } = makeDriver(transport, { allowVsCode: true });
    await driver.capture({ kind: 'window', title: 'Forge' }, { allowNewApproval: true });
    await driver.typeText('x');
    setPolicy({ allowVsCode: false });
    // Named as a VS Code refusal, not as "nothing is approved": the reason has
    // to say what was revoked, or the user goes looking for a lost focus.
    await expect(driver.typeText('y')).rejects.toThrow(/VS Code/);
    await expect(driver.press(['enter'])).rejects.toThrow(/no approved target window/);
    expect(transport.opsNamed('type').length).toBe(1);
  });

  it('re-enabling does not resurrect the dropped approval', async () => {
    const transport = new FakeTransport();
    transport.on('capture', captureResponse(CODE));
    transport.foregroundHwnd = '0x9999';
    const { driver, setPolicy } = makeDriver(transport, { allowVsCode: true });
    const cap = await driver.capture(
      { kind: 'window', title: 'Forge' },
      { allowNewApproval: true },
    );
    setPolicy({ allowVsCode: false });
    await expect(driver.typeText('x')).rejects.toThrow(/VS Code/);
    setPolicy({ allowVsCode: true });
    // No new approval was taken, so input is still refused — the approval and
    // its capture records were dropped, not merely hidden.
    await expect(driver.typeText('x')).rejects.toThrow(/no approved target window/);
    await expect(driver.click(10, 10, {}, cap.captureId)).rejects.toThrow(
      /unknown capture_id/,
    );
    // A fresh focus re-binds it.
    transport.on('focus_window', {
      ok: true,
      window: {
        id: '0x9999',
        title: 'Forge - Visual Studio Code',
        class: 'Chrome_WidgetWin_1',
        process_name: 'Code',
        pid: 7777,
        process_start_time: 1700000000000,
        rect: { x: 100, y: 100, width: 800, height: 600 },
      },
    });
    await driver.focusWindow({ kind: 'windowId', id: '0x9999' });
    await driver.typeText('x');
    expect(transport.opsNamed('type').length).toBe(1);
  });
});

describe('revocation clears only the Code target (Phase 3 item 3)', () => {
  it('keeps an unrelated window approval and its captures', async () => {
    const transport = new FakeTransport();
    // Two captures in sequence: first Code, then an ordinary window. The
    // ordinary approval must survive revoking the Code opt-in.
    transport.onCaptures(captureResponse(CODE), captureResponse());
    transport.foregroundHwnd = '0x1234';

    const { driver, setPolicy } = makeDriver(transport, { allowVsCode: true });
    const codeCap = await driver.capture(
      { kind: 'window', title: 'Forge' },
      { allowNewApproval: true },
    );
    const padCap = await driver.capture(
      { kind: 'window', title: 'Test Window' },
      { allowNewApproval: true },
    );
    expect(padCap.approvedHwnd).toBe('0x1234');

    setPolicy({ allowVsCode: false });
    // The surviving target still accepts input, including through its own id.
    await driver.click(10, 10, {}, padCap.captureId);
    await driver.typeText('still works');
    expect(transport.opsNamed('click').length).toBe(1);
    expect(transport.opsNamed('type').length).toBe(1);

    // The Code capture is gone, and the Code approval with it.
    await expect(driver.click(10, 10, {}, codeCap.captureId)).rejects.toThrow(
      /unknown capture_id/,
    );
    expect(driver.captureTarget(codeCap.captureId)).toBeUndefined();
    expect(driver.approvedTarget()?.hwnd).toBe('0x1234');
  });

  it('drops every capture record bound to the revoked window, not just the newest', async () => {
    const transport = new FakeTransport();
    transport.on('capture', captureResponse(CODE));
    transport.foregroundHwnd = '0x9999';
    const { driver, setPolicy } = makeDriver(transport, { allowVsCode: true });
    const a = await driver.capture(
      { kind: 'window', title: 'Forge' },
      { allowNewApproval: true },
    );
    const b = await driver.capture({ kind: 'window', title: 'Forge' });
    const c = await driver.capture({ kind: 'window', title: 'Forge' });
    // All three exist before the revocation.
    for (const cap of [a, b, c]) {
      expect(driver.captureTarget(cap.captureId)?.hwnd).toBe('0x9999');
    }
    setPolicy({ allowVsCode: false });
    // One read of the policy drops every Code-bound record, not just the newest
    // or the one attached to the current approval.
    for (const cap of [a, b, c]) {
      expect(driver.captureTarget(cap.captureId)).toBeUndefined();
    }
  });

  it('exposes read-only target details for the tool-layer prompts', async () => {
    const transport = new FakeTransport();
    transport.on('capture', captureResponse(CODE));
    const { driver } = makeDriver(transport, { allowVsCode: true });
    const cap = await driver.capture(
      { kind: 'window', title: 'Forge' },
      { allowNewApproval: true },
    );
    expect(driver.approvedTarget()?.processName).toBe('Code');
    expect(driver.captureTarget(cap.captureId)?.title).toBe('Forge - Visual Studio Code');
    // A capture_id that does not exist is undefined, not a guess.
    expect(driver.captureTarget('cap-nope')).toBeUndefined();
    expect(driver.captureTarget('')).toBeUndefined();
  });
});
