/**
 * The desktop approval predicates: a window capture binds the control target,
 * so a new window must prompt (plan §4.2); the cloud monitor gate must resolve
 * the kind the way the handler does and fail closed on an unknown model.
 */
import { describe, it, expect } from 'vitest';
import { captureApproval, cloudMonitorApproval } from '../../src/tools/desktop/desktopApprovals';
import type { ForgeConfig } from '../../src/config/types';

const never = () => undefined;

describe('captureApproval', () => {
  it('prompts for a window the driver has not approved', () => {
    const approval = captureApproval({ coversTitle: () => false }, never);
    expect(approval({ window_title: 'Notepad' })?.detail).toMatch(/Notepad/);
  });

  it('does not prompt to re-capture the approved window', () => {
    const approval = captureApproval({ coversTitle: () => true }, never);
    expect(approval({ window_title: 'Notepad' })).toBeUndefined();
  });

  it('delegates monitor captures to the monitor gate', () => {
    const approval = captureApproval({ coversTitle: () => false }, () => ({ detail: 'mon' }));
    expect(approval({ monitor: 0 })?.detail).toBe('mon');
    expect(approval({ kind: 'monitor', monitor: 0, window_title: 'x' })?.detail).toBe('mon');
  });
});

describe('cloudMonitorApproval', () => {
  const unknownModel = () =>
    ({ active_model: 'no-such-model', models: [] }) as unknown as ForgeConfig;

  it('treats {monitor: 0} with no kind as a monitor capture', () => {
    expect(cloudMonitorApproval(unknownModel)({ monitor: 0 })).toBeDefined();
  });

  it('fails closed when the active model cannot be resolved', () => {
    expect(cloudMonitorApproval(unknownModel)({ kind: 'monitor', monitor: 0 })?.dangerous).toBe(
      true,
    );
  });

  it('ignores window captures', () => {
    expect(cloudMonitorApproval(unknownModel)({ window_title: 'x' })).toBeUndefined();
  });
});
