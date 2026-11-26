import * as os from 'os';
import { afterAll, beforeAll } from 'vitest';

/** The variables `test/support/tempGuard.setup.ts` points at the throwaway home. */
const HOME_VARS = process.platform === 'win32' ? ['USERPROFILE', 'HOME'] : ['HOME'];

/**
 * Put the account's real profile back for the duration of this test file.
 *
 * Call it once, at the top of a suite that launches the system browser through
 * playwright-core. `tempGuard.setup.ts` redirects `USERPROFILE` / `HOME` to a
 * throwaway folder for every test file (so `SessionLogger`, `BackgroundRegistry`,
 * `memoryStore`, skill discovery and the job keeper cannot write into the owner's
 * real `~/.forge`), and system Chrome does not survive that: measured twice on
 * 2026-11-26 (lane A's probe, `.forge/tmp/laneA-chrome-probe-1.log`, and lane B's
 * `npm run ci`), `chromium.launchPersistentContext` with `channel: 'chrome'` under
 * a redirected `USERPROFILE` never finished — 180 s until the probe gave up — while
 * the same launch with the real profile returned in 739 ms. So the browser suites
 * run with the real profile and the redirect off, and everything else keeps it.
 *
 * `os.userInfo()` reads the account itself (the token's profile folder on Windows,
 * the passwd entry elsewhere) and ignores the variables the guard redirects, so
 * this is the real home and not what the guard left in `process.env`.
 *
 * Registered at file scope, so vitest runs it before any suite's own `beforeAll`
 * and — with the default `stack` hook order — restores the fake values before the
 * setup file's `afterAll` removes the throwaway folder.
 */
export function useRealProfileForBrowser(): void {
  const realHome = os.userInfo().homedir;
  let saved: Array<readonly [string, string | undefined]> = [];
  beforeAll(() => {
    saved = HOME_VARS.map((name) => [name, process.env[name]] as const);
    for (const name of HOME_VARS) process.env[name] = realHome;
  });
  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
