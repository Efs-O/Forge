/**
 * PowerShellTransport against a real PowerShell child (Windows only): the real
 * driver answers, a dead child is respawned on the next request instead of the
 * singleton staying dead until reload, a silent child times out instead of
 * hanging the turn, and an exit carries the stderr tail.
 */
import { describe, it, expect } from 'vitest';
import { PowerShellTransport } from '../../src/tools/desktop/PowerShellTransport';

describe.skipIf(process.platform !== 'win32')('PowerShellTransport (real child)', () => {
  it('answers list_windows and respawns after the child dies', async () => {
    const t = new PowerShellTransport();
    try {
      const r = await t.send({ op: 'list_windows' });
      expect(Array.isArray(r['windows'])).toBe(true);
      // Kill the child out from under the transport (a crash).
      (t as unknown as { child: { kill(): void } }).child.kill();
      await new Promise((r) => setTimeout(r, 500));
      const again = await t.send({ op: 'list_windows' });
      expect(Array.isArray(again['windows'])).toBe(true);
    } finally {
      await t.dispose();
    }
  }, 30_000);

  it('times out a request the child never answers', async () => {
    const t = new PowerShellTransport('while ($true) { Start-Sleep -Seconds 1 }', 1500);
    try {
      await expect(t.send({ op: 'list_windows' })).rejects.toThrow(/timed out after 1500 ms/);
    } finally {
      await t.dispose();
    }
  }, 30_000);

  it('rejects with the stderr tail when the child exits', async () => {
    const t = new PowerShellTransport("[Console]::Error.WriteLine('driver boom'); exit 3");
    try {
      await expect(t.send({ op: 'list_windows' })).rejects.toThrow(/code 3.*driver boom/s);
    } finally {
      await t.dispose();
    }
  }, 30_000);
});
