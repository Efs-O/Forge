/**
 * Regression contract for desktopDriver.ps1's teardown path. A bare synthetic
 * RIGHTUP at the current cursor can open an Electron context menu even when no
 * desktop_click tool ran, so cleanup must release only inputs that are down.
 */
import { describe, expect, it } from 'vitest';
import driverScript from '../../src/tools/desktop/desktopDriver.ps1';

function functionBody(name: string): string {
  const match = driverScript.match(new RegExp(`function ${name} \\{([\\s\\S]*?)\\r?\\n\\}`));
  if (!match?.[1]) throw new Error(`missing PowerShell function ${name}`);
  return match[1];
}

describe('desktop driver release safety', () => {
  it('checks Windows input state before emitting mouse-button releases', () => {
    expect(driverScript).toContain('GetAsyncKeyState(int vKey)');
    const releaseAll = functionBody('Send-ReleaseAll');

    expect(releaseAll).toMatch(/if \(Test-InputDown 0x01\).*0x0004/);
    expect(releaseAll).toMatch(/if \(Test-InputDown 0x02\).*0x0010/);
    expect(releaseAll).toMatch(/if \(Test-InputDown 0x04\).*0x0040/);
  });

  it('does not call SendInput when teardown has nothing to release', () => {
    const releaseAll = functionBody('Send-ReleaseAll');
    const emptyGuard = releaseAll.indexOf('if ($ups.Count -eq 0) { return }');
    const send = releaseAll.indexOf('Send-Inputs $ups');

    expect(emptyGuard).toBeGreaterThanOrEqual(0);
    expect(send).toBeGreaterThan(emptyGuard);
  });
});
