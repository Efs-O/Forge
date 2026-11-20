import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { BrowserType } from 'playwright-core';
import {
  launchSeededBrowser,
  resetSeededBrowserSweepForTest,
  type SeededBrowserDeps,
} from '../../src/tools/browser/seededBrowser';

/**
 * The seeds and profiles are real files in real temp directories under a
 * per-test `mkdtemp`: what this module promises is about the FILES on disk, so
 * the fake browser only replaces the launch itself. Neither `tmpDir` nor
 * `seedDir` is the machine's own — the suite never reads or writes the real
 * `%LOCALAPPDATA%\forge-llm\browser-seed`.
 */
const SEED_TEXT = '{"os_password_blank":false,"os_password_last_changed":"13437498569265782"}';
/** What Chromium itself writes when the password is blank and never changed. */
const PROFILE_LOCAL_STATE =
  '{"password_manager":{"os_password_blank":false,"os_password_last_changed":"13437498569999999"},"other":1}';
const NOW = 1_700_000_000_000;

let root: string;
let tmpDir: string;
let seedDir: string;

beforeEach(async () => {
  resetSeededBrowserSweepForTest();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'seeded-browser-test-'));
  tmpDir = path.join(root, 'tmp');
  seedDir = path.join(root, 'seed');
  await fs.mkdir(tmpDir);
  await fs.mkdir(seedDir);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface FakeLaunch {
  chromium: Pick<BrowserType, 'launchPersistentContext'>;
  dirs: string[];
  options: Array<Record<string, unknown>>;
  close: ReturnType<typeof vi.fn>;
}

/**
 * A stand-in for a Chromium launch: it records the profile dir and the options,
 * runs `onLaunch` while the profile is still open (so a test can read what the
 * profile contains at that moment, which is what the seed promise is about),
 * and can fail like a missing channel does.
 */
function fakeChromium(onLaunch?: (dir: string) => Promise<void> | void, error?: Error): FakeLaunch {
  const dirs: string[] = [];
  const options: Array<Record<string, unknown>> = [];
  const close = vi.fn(async () => undefined);
  const context = {
    close,
    pages: () => [],
    browser: () => ({ version: () => 'fake 1.0' }),
  };
  const launchPersistentContext = vi.fn(
    async (dir: string, launchOptions: Record<string, unknown>) => {
      dirs.push(dir);
      options.push(launchOptions);
      if (onLaunch) await onLaunch(dir);
      if (error) throw error;
      return context;
    },
  );
  return {
    chromium: {
      launchPersistentContext,
    } as unknown as Pick<BrowserType, 'launchPersistentContext'>,
    dirs,
    options,
    close,
  };
}

function depsFor(fake: FakeLaunch, over: Partial<SeededBrowserDeps> = {}): SeededBrowserDeps {
  return {
    chromium: fake.chromium,
    platform: 'win32',
    tmpDir,
    seedDir,
    now: () => NOW,
    ...over,
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

const localStateOf = (dir: string): Promise<string> =>
  fs.readFile(path.join(dir, 'Local State'), 'utf8');

describe('launchSeededBrowser', () => {
  it('seeds the throwaway profile with the block Chromium wrote', async () => {
    await fs.writeFile(path.join(seedDir, 'chrome.json'), SEED_TEXT);
    let atLaunch: string | undefined;
    const fake = fakeChromium(async (dir) => {
      atLaunch = await localStateOf(dir);
    });

    const session = await launchSeededBrowser({ channel: 'chrome', headless: true }, depsFor(fake));

    expect(atLaunch).toBe(
      '{"password_manager":{"os_password_blank":false,"os_password_last_changed":"13437498569265782"}}',
    );
    expect(session.version).toBe('fake 1.0');
    await session.close();
  });

  it('keeps what Chromium wrote in the profile as the next seed, and removes the profile', async () => {
    const fake = fakeChromium(async (dir) => {
      expect(await exists(path.join(dir, 'Local State'))).toBe(false);
      await fs.writeFile(path.join(dir, 'Local State'), PROFILE_LOCAL_STATE);
    });

    const session = await launchSeededBrowser({ channel: 'msedge', headless: true }, depsFor(fake));
    const profileDir = fake.dirs[0]!;
    await session.close();

    expect(await fs.readFile(path.join(seedDir, 'msedge.json'), 'utf8')).toBe(
      '{"os_password_blank":false,"os_password_last_changed":"13437498569999999"}',
    );
    expect(await exists(profileDir)).toBe(false);
    // The atomic swap leaves no scratch file behind.
    expect(await fs.readdir(seedDir)).toEqual(['msedge.json']);
  });

  it('leaves the seed file untouched when the profile holds the same answer', async () => {
    const seedFile = path.join(seedDir, 'chrome.json');
    await fs.writeFile(seedFile, SEED_TEXT);
    const written = (await fs.stat(seedFile)).mtimeMs;
    const fake = fakeChromium((dir) =>
      fs.writeFile(
        path.join(dir, 'Local State'),
        '{"password_manager":{"os_password_blank":false,"os_password_last_changed":"13437498569265782"}}',
      ),
    );

    const session = await launchSeededBrowser({ channel: 'chrome', headless: true }, depsFor(fake));
    await session.close();

    expect((await fs.stat(seedFile)).mtimeMs).toBe(written);
    expect(await fs.readFile(seedFile, 'utf8')).toBe(SEED_TEXT);
  });

  const refused: Array<[string, string]> = [
    ['a boolean written as a string', '{"os_password_blank":"false","os_password_last_changed":"1343"}'],
    ['a timestamp that is not digits', '{"os_password_blank":false,"os_password_last_changed":"now"}'],
    ['an extra key', '{"os_password_blank":false,"os_password_last_changed":"1343","extra":1}'],
    ['a truncated file', '{"os_password_blank":false,"os_password_last_ch'],
  ];
  for (const [name, text] of refused) {
    it(`treats ${name} as no seed`, async () => {
      await fs.writeFile(path.join(seedDir, 'chrome.json'), text);
      let atLaunch: boolean | undefined;
      const fake = fakeChromium(async (dir) => {
        atLaunch = await exists(path.join(dir, 'Local State'));
      });

      const session = await launchSeededBrowser({ channel: 'chrome', headless: true }, depsFor(fake));

      expect(atLaunch).toBe(false);
      expect(fake.dirs).toHaveLength(1);
      await session.close();
    });
  }

  it('writes no Local State and keeps the seed as it was off Windows', async () => {
    const seedFile = path.join(seedDir, 'chrome.json');
    await fs.writeFile(seedFile, SEED_TEXT);
    const written = (await fs.stat(seedFile)).mtimeMs;
    let atLaunch: boolean | undefined;
    const fake = fakeChromium(async (dir) => {
      atLaunch = await exists(path.join(dir, 'Local State'));
      await fs.writeFile(path.join(dir, 'Local State'), PROFILE_LOCAL_STATE);
    });

    const session = await launchSeededBrowser(
      { channel: 'chrome', headless: true },
      depsFor(fake, { platform: 'linux' }),
    );
    await session.close();

    expect(atLaunch).toBe(false);
    expect(await fs.readFile(seedFile, 'utf8')).toBe(SEED_TEXT);
    expect((await fs.stat(seedFile)).mtimeMs).toBe(written);
  });

  it('rethrows a launch failure unchanged and leaves no profile behind', async () => {
    const boom = new Error('boom');
    const fake = fakeChromium(undefined, boom);

    await expect(
      launchSeededBrowser({ channel: 'chrome', headless: true }, depsFor(fake)),
    ).rejects.toBe(boom);

    expect(await fs.readdir(tmpDir)).toEqual([]);
  });

  it('closes the context exactly once when close is called twice', async () => {
    const fake = fakeChromium();
    const session = await launchSeededBrowser({ channel: 'chrome', headless: true }, depsFor(fake));

    await session.close();
    await session.close();

    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('passes channel, headless, args, env and the context options to the launch', async () => {
    const fake = fakeChromium();
    const session = await launchSeededBrowser(
      {
        channel: 'msedge',
        headless: true,
        args: ['--no-pings'],
        env: { ...process.env, FORGE_TEST: '1' },
        context: { viewport: { width: 800, height: 600 }, javaScriptEnabled: false },
      },
      depsFor(fake),
    );

    expect(fake.options[0]).toMatchObject({
      channel: 'msedge',
      headless: true,
      args: ['--no-pings'],
      env: { FORGE_TEST: '1' },
      viewport: { width: 800, height: 600 },
      javaScriptEnabled: false,
    });
    // The profile dir is the persistent context's user-data-dir.
    expect(fake.dirs[0]).toContain(path.join(tmpDir, 'forge-browser-'));
    await session.close();
  });

  it('sweeps throwaway profiles older than a day on the first launch', async () => {
    const stale = path.join(tmpDir, 'forge-browser-old');
    const recent = path.join(tmpDir, 'forge-browser-new');
    const unrelated = path.join(tmpDir, 'something-else');
    await fs.mkdir(stale);
    await fs.mkdir(recent);
    await fs.mkdir(unrelated);
    const stamp = (dir: string, ageMs: number) => {
      const when = new Date(NOW - ageMs);
      return fs.utimes(dir, when, when);
    };
    await stamp(stale, 25 * 60 * 60 * 1000);
    await stamp(recent, 60 * 60 * 1000);
    await stamp(unrelated, 25 * 60 * 60 * 1000);

    const fake = fakeChromium();
    const session = await launchSeededBrowser({ channel: 'chrome', headless: true }, depsFor(fake));

    const names = await fs.readdir(tmpDir);
    expect(names).toContain('something-else');
    expect(names).toContain('forge-browser-new');
    expect(names).not.toContain('forge-browser-old');
    // Only the sweep's survivors and this launch's own profile.
    expect(names.filter((name) => name.startsWith('forge-browser-'))).toHaveLength(2);

    await session.close();
    expect(await fs.readdir(tmpDir)).toEqual(['forge-browser-new', 'something-else']);
  });
});
