/**
 * The home folder a test file sees is the throwaway one `tempGuard.setup.ts` made
 * for it, never the operator's profile.
 *
 * Why this is a test and not a comment: `os.homedir()` is what `SessionLogger`,
 * `BackgroundRegistry`, `memoryStore`, skill discovery and `windowsJobKeeper` use
 * for their state, so every one of them used to write into the real `~/.forge`.
 * The Linux clone (2026-11-25) proved it — a single run created five folders in a
 * clean home — and on Windows the same writes happened unnoticed because the
 * folders were already there. The guard now redirects `USERPROFILE` / `HOME` per
 * test file; these assertions fail if that redirect is ever removed, or if a
 * suite runs without the guard's setup file.
 */
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('the per-file home folder (test/support/tempGuard.setup.ts)', () => {
  it('is not the account profile the tests used to write into', () => {
    // `userInfo()` asks the OS for the account's own profile — on Windows it
    // resolves the token's profile folder, on POSIX the passwd entry — so unlike
    // `homedir()` it never reads the variable the guard sets. It is the only way
    // to prove the redirect happened rather than assume it.
    expect(os.homedir()).not.toBe(os.userInfo().homedir);
  });

  it('is the throwaway folder the guard made for this file', () => {
    expect(path.basename(os.homedir())).toMatch(/^home-/);
  });

  it.skipIf(process.platform !== 'win32')(
    'gives Windows a LocalAppData inside the fake home, so children do not write relative to their cwd',
    () => {
      // Windows resolves the known folders under `USERPROFILE` and answers the
      // empty string when `<profile>\AppData\Local` does not exist. PowerShell
      // builds its module-analysis-cache path from that answer, so under a bare
      // fake home it wrote `Microsoft\Windows\PowerShell\ModuleAnalysisCache`
      // relative to its own cwd — the stray `Microsoft/` folder in the repo
      // root. Started from a neutral cwd, a child must resolve it inside the
      // fake home the guard made.
      const localAppData = execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "[Environment]::GetFolderPath('LocalApplicationData')",
        ],
        { cwd: os.tmpdir(), encoding: 'utf8' },
      ).trim();
      expect(localAppData).toBe(path.join(os.homedir(), 'AppData', 'Local'));
    },
  );
});
