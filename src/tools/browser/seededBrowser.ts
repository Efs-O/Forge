import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Dirent } from 'fs';
import type { BrowserContext, BrowserContextOptions, BrowserType } from 'playwright-core';
import { getPlaywright, type BrowserChannel } from './browserPrimitives';

/**
 * One throwaway Chromium profile per launch, plus the one thing that makes a
 * throwaway profile cheap on Windows.
 *
 * On Windows, launching Chromium with a brand-new profile asks the system
 * whether the account password is blank, and Chromium answers it by calling
 * `LogonUser(user, "")` — a sign-in attempt with an empty password that Windows
 * logs as a FAILED sign-in (event 4625, sub-status 0xc000006a). Chromium caches
 * the answer only inside that profile, in `Local State` under
 * `password_manager.os_password_blank` and `os_password_last_changed`, so a
 * throwaway profile pays the failure every single time. Forge makes a throwaway
 * profile for every browser tool call, render and PDF export, and Windows 11
 * locks the account after 10 failures in 15 minutes: a test run locked the
 * owner's laptop that way on 2026-11-20.
 *
 * The fix follows Chromium's own cache. At close, the block Chromium wrote into
 * the throwaway profile is kept per channel (`%LOCALAPPDATA%\forge-llm\
 * browser-seed\<channel>.json`), and every new throwaway profile is seeded with
 * it before launch. Measured on that laptop: a profile carrying the block
 * Chromium itself wrote costs 0 failures, a fresh profile costs 1, and a
 * hand-made "now" timestamp still costs 1 — so only a value Chromium produced
 * is reused, and only until the password changes (which changes the timestamp
 * inside the block, so the stale seed stops matching).
 */

/** Chromium's cached blank-password answer, exactly as it writes it. The
 *  int64 timestamp arrives as a STRING; a boolean as a string is not it. */
interface OsPasswordSeed {
  os_password_blank: boolean;
  os_password_last_changed: string;
}

/** Throwaway profiles and the sweep prefix share it. */
const PROFILE_PREFIX = 'forge-browser-';
/** A throwaway profile older than this is a crash leftover, not a live launch. */
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Windows lets a just-closed browser hold profile files open for a moment. */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

export interface SeededBrowserDeps {
  chromium: Pick<BrowserType, 'launchPersistentContext'>;
  platform: NodeJS.Platform;
  /** Where throwaway profiles go. */
  tmpDir: string;
  /** Where the per-channel seeds live; null = no seeding. */
  seedDir: string | null;
  now: () => number;
}

export interface SeededBrowser {
  context: BrowserContext;
  version: string;
  /** Idempotent: closes the context, keeps its seed, removes the profile dir. */
  close(): Promise<void>;
}

export interface LaunchSeededBrowserOptions {
  channel: BrowserChannel;
  headless: boolean;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Applied to the persistent context, exactly as `newContext` options were. */
  context?: BrowserContextOptions;
}

/**
 * Warn without importing `vscode` at module scope: this module sits in the
 * browser tool graph, which is `vscode`-free on purpose (the smoke bundles
 * `BrowserSessionManager` and runs it under plain node, where `vscode` is not
 * provided) and `util/logger` imports it. Required lazily, so a graph that has
 * no `vscode` still gets the warning — on the console instead of the channel.
 */
function warn(what: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getLogger } = require('../../util/logger') as typeof import('../../util/logger');
    getLogger().warn(what);
  } catch {
    console.warn(what);
  }
}

/** The seed root next to the control-server record (`ControlServerRegistry`). */
function defaultSeedDir(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  return localAppData ? path.join(localAppData, 'forge-llm', 'browser-seed') : null;
}

export function defaultSeededBrowserDeps(): SeededBrowserDeps {
  return {
    // Lazy, like `getPlaywright()` itself: playwright-core is 12.8 MB and
    // external, so building deps must not load it for a launch that never runs.
    chromium: getPlaywright().chromium,
    platform: process.platform,
    tmpDir: os.tmpdir(),
    seedDir: process.platform === 'win32' ? defaultSeedDir() : null,
    now: Date.now,
  };
}

/**
 * A seed is Chromium's block and nothing else: exactly these two keys, the flag
 * a real boolean, the timestamp all-digits. Anything else — a boolean written
 * as a string, a non-numeric timestamp, an extra key, a truncated file — is
 * treated as no seed, so the launch pays one failure and close re-reads what
 * Chromium actually wrote.
 */
function parseSeed(value: unknown): OsPasswordSeed | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return null;
  const blank = record['os_password_blank'];
  const lastChanged = record['os_password_last_changed'];
  if (typeof blank !== 'boolean') return null;
  if (typeof lastChanged !== 'string' || !/^\d+$/.test(lastChanged)) return null;
  return { os_password_blank: blank, os_password_last_changed: lastChanged };
}

/** Missing, unreadable, unparseable or wrong-shaped all answer `null` = no seed. */
async function readSeedFile(file: string): Promise<OsPasswordSeed | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return parseSeed(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function removeProfileDir(dir: string, why: string): Promise<void> {
  try {
    await fs.rm(dir, RM_OPTIONS);
  } catch (err) {
    // Left for the next launch's sweep; the caller's own result matters more.
    warn(`seededBrowser: could not remove throwaway profile ${dir} (${why}): ${String(err)}`);
  }
}

/**
 * Keep what Chromium wrote in THIS profile. A profile with no `Local State`
 * (Chromium can close before writing it) or one whose block is not a seed
 * writes nothing — that is not an error, and the next launch pays one failure.
 * A seed equal to the one handed to this launch leaves the file untouched.
 */
async function persistSeed(
  dir: string,
  seedFile: string,
  seedDir: string,
  seedAtLaunch: OsPasswordSeed | null,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path.join(dir, 'Local State'), 'utf8'));
  } catch {
    return;
  }
  const seed = parseSeed((parsed as { password_manager?: unknown }).password_manager);
  if (!seed) return;
  if (
    seedAtLaunch !== null &&
    seed.os_password_blank === seedAtLaunch.os_password_blank &&
    seed.os_password_last_changed === seedAtLaunch.os_password_last_changed
  ) {
    return;
  }
  try {
    await fs.mkdir(seedDir, { recursive: true });
    // Same folder, then rename: an atomic swap, so a reader never sees a half
    // file and a crash leaves the previous seed in place.
    const temp = path.join(seedDir, `${path.basename(seedFile)}.${process.pid}.tmp`);
    await fs.writeFile(temp, JSON.stringify(seed));
    await fs.rename(temp, seedFile);
  } catch (err) {
    warn(`seededBrowser: could not write seed ${seedFile}: ${String(err)}`);
  }
}

/** Once per process: remove crash-leftover throwaway profiles. */
let sweepDone = false;
export function resetSeededBrowserSweepForTest(): void {
  sweepDone = false;
}

async function sweepStaleProfiles(deps: SeededBrowserDeps): Promise<void> {
  if (sweepDone) return;
  sweepDone = true;
  const now = deps.now();
  let entries: Dirent[];
  try {
    entries = await fs.readdir(deps.tmpDir, { withFileTypes: true });
  } catch (err) {
    warn(`seededBrowser: could not list ${deps.tmpDir} to sweep: ${String(err)}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PROFILE_PREFIX)) continue;
    const dir = path.join(deps.tmpDir, entry.name);
    try {
      const stat = await fs.stat(dir);
      if (now - stat.mtimeMs <= SWEEP_MAX_AGE_MS) continue;
      await fs.rm(dir, RM_OPTIONS);
    } catch (err) {
      // Another user's leftover, or it vanished: nothing to do about either.
      warn(`seededBrowser: sweep left ${dir}: ${String(err)}`);
    }
  }
}

/**
 * Launch a throwaway profile, seeded with Chromium's own blank-password answer
 * when this platform has one. The caller owns the returned `context` and must
 * `close()` it; the profile directory is gone by the time that resolves.
 *
 * A launch failure is rethrown unchanged (the callers wrap it in their own
 * message naming the config fix) after the profile directory is removed.
 */
export async function launchSeededBrowser(
  opts: LaunchSeededBrowserOptions,
  deps: SeededBrowserDeps = defaultSeededBrowserDeps(),
): Promise<SeededBrowser> {
  await sweepStaleProfiles(deps);
  const dir = await fs.mkdtemp(path.join(deps.tmpDir, PROFILE_PREFIX));
  const seedFile =
    deps.platform === 'win32' && deps.seedDir !== null
      ? path.join(deps.seedDir, `${opts.channel}.json`)
      : null;

  let seedAtLaunch: OsPasswordSeed | null = null;
  if (seedFile !== null && deps.seedDir !== null) {
    seedAtLaunch = await readSeedFile(seedFile);
    if (seedAtLaunch !== null) {
      // Chromium reads the block back from this file and skips the sign-in
      // attempt, which is the whole point.
      await fs.writeFile(
        path.join(dir, 'Local State'),
        JSON.stringify({ password_manager: seedAtLaunch }),
      );
    }
  }

  let context: BrowserContext;
  try {
    context = await deps.chromium.launchPersistentContext(dir, {
      channel: opts.channel,
      headless: opts.headless,
      args: [...(opts.args ?? [])],
      ...(opts.env ? { env: opts.env } : {}),
      ...opts.context,
    });
  } catch (err) {
    await removeProfileDir(dir, 'launch failed');
    throw err;
  }

  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      let closeError: unknown;
      try {
        await context.close();
      } catch (err) {
        closeError = err;
      }
      if (seedFile !== null && deps.seedDir !== null) {
        await persistSeed(dir, seedFile, deps.seedDir, seedAtLaunch);
      }
      await removeProfileDir(dir, 'after close');
      if (closeError !== undefined) throw closeError;
    })();
    return closed;
  };

  return {
    context,
    version: context.browser()?.version() ?? 'unknown',
    close,
  };
}
