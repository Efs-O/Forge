import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { powershellScratch } from '../../src/util/powershellScratchDir';
import { windowsFileHolders } from '../../src/util/windowsFileHolders';

const IS_WINDOWS = process.platform === 'win32';
/** .NET's CodeDom names each scratch file after eight random lowercase
 *  characters: `<8chars>.0.cs`, `.dll`, `.err`, `.out`, `.cmdline`. The same
 *  shape `test/integration/DesktopTransport.test.ts` cleans up after. */
const CODEDOM_SCRATCH = /^[a-z0-9]{8}(\.|$)/u;

let home: string;

beforeEach(async () => {
  home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'forge-ps-scratch-'));
});

afterEach(async () => {
  await fs.promises.rm(home, { recursive: true, force: true });
});

describe('powershellScratch', () => {
  it('gives the compiling child a folder of our own, on all three temp names', () => {
    const scratch = powershellScratch('rm-probe', home);
    const dir = scratch.env.TEMP;
    expect(dir.startsWith(path.join(home, '.forge', 'rm-probe', 'ps-'))).toBe(true);
    expect(scratch.env.TMP).toBe(dir);
    expect(scratch.env.TMPDIR).toBe(dir);
    expect(fs.statSync(dir).isDirectory()).toBe(true);
    scratch.dispose();
  });

  it('prunes only its own scratch folders, and only once they are a day old', () => {
    const root = path.join(home, '.forge', 'rm-probe');
    fs.mkdirSync(root, { recursive: true });
    const stale = path.join(root, 'ps-17-older');
    const fresh = path.join(root, 'ps-17-newer');
    const foreign = path.join(root, 'someone-elses-folder');
    for (const dir of [stale, fresh, foreign]) fs.mkdirSync(dir, { recursive: true });
    // 25 h old against a 24 h ceiling; the other two are now, so a coarse clock
    // cannot read them as stale the way it can read a one-millisecond margin.
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);

    const scratch = powershellScratch('rm-probe', home);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    scratch.dispose();
  });

  it('removes its folder on dispose, and does not care who got there first', () => {
    // The probe runs many times a day, so a folder that waited 24 h for the
    // prune would pile up; the prune is only the backstop for a process that
    // died while its child was still compiling.
    const scratch = powershellScratch('rm-probe', home);
    const dir = scratch.env.TEMP;
    fs.writeFileSync(path.join(dir, 'ab12cd34.0.cs'), 'class Q {}');

    scratch.dispose();

    expect(fs.existsSync(dir)).toBe(false);
    expect(() => scratch.dispose()).not.toThrow();

    const handedOver = powershellScratch('rm-probe', home);
    fs.rmSync(handedOver.env.TEMP, { recursive: true, force: true });
    expect(() => handedOver.dispose()).not.toThrow();
  });

  it('yields an empty env instead of throwing when no folder of ours can be made', () => {
    const inTheWay = path.join(home, 'a-file');
    fs.writeFileSync(inTheWay, 'a file where a directory has to be');
    const scratch = powershellScratch('rm-probe', inTheWay);
    expect(scratch.env).toEqual({});
    expect(() => scratch.dispose()).not.toThrow();
  });
});

describe('windowsFileHolders', () => {
  // The bug this pins: the probe's PowerShell child compiled into the temp
  // folder it inherited. Under load the 3 s timeout killed it mid-compile and
  // CodeDom's five scratch files survived there - which in the suite is the
  // per-file folder the temp guard counts, so it failed whole test files
  // (`AtomicWriteAsync`, `AtomicWriteWindows`, `AtomicWriteContention`) with a
  // "temp leak" they could not have caused.
  it.skipIf(!IS_WINDOWS)(
    'leaves no compile scratch in the folder the caller is running in',
    () => {
      const target = path.join(home, 'held-by-nobody.txt');
      fs.writeFileSync(target, 'contents');
      const before = new Set(fs.readdirSync(os.tmpdir()));

      // The result is not the point: a busy machine can time the probe out, and
      // a probe that never got to compile is still a probe that leaked nothing.
      windowsFileHolders(target);

      const appeared = fs
        .readdirSync(os.tmpdir())
        .filter((name) => !before.has(name) && CODEDOM_SCRATCH.test(name));
      expect(appeared).toEqual([]);
    },
    // The probe may run up to HOLDER_PROBE_TIMEOUT_MS (10 s), past vitest's 5 s local default.
    30_000,
  );
});
