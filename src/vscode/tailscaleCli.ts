/**
 * The Tailscale CLI, run argv-only, from one place.
 *
 * Two of the lane-3 commands need it: `Forge: Connect to my desktop` (laptop)
 * reads `status --json` to offer the online machines by name, and `Forge: Share
 * this computer` / `Forge: Stop sharing this computer` (desktop) read
 * `serve status --json` and apply `serve` changes. Both are forbidden from
 * running it in tests (`docs/plans/V1_FINISH_PLAN.md` lane 3: "never run
 * tailscale in tests"), so every caller takes an injected runner and this module
 * is what production passes.
 *
 * The rules that live here, and why:
 *
 * - `execFile` with an argv array, never a shell command string: a peer name or
 *   a port read back from Tailscale cannot become a command line. This is the
 *   same shape `agentMesh/hostIdentity.ts` uses.
 * - Every call carries its own deadline and honours the caller's abort, so a
 *   machine where Tailscale is stopped, hung or not installed costs a fallback
 *   rather than a stuck command. Nothing here waits forever.
 * - `ENOENT` at one location tries the next one; every location failing is
 *   reported as one failure with one message, not four.
 * - Nothing here ever writes to the tailnet: which command to run is decided by
 *   the caller, and `--bg` is what makes a `serve` change apply without an
 *   interactive prompt.
 * - The location list is injectable, because this machine HAS a Tailscale: a
 *   test that wants to know what a hung daemon, a missing CLI or a normal
 *   answer looks like must not be the one that runs the owner's `tailscale`, so
 *   it passes its own locations (a real `node`, a path that does not exist) and
 *   still gets a real child process, real stdout and real errors.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Where the CLI may be, in the order tried, without the `TAILSCALE_CLI` escape
 *  hatch (added by `tailscaleCandidateLocations` below). The bare name is last
 *  because a machine with Tailscale installed but not on `PATH` still has one of
 *  the three well-known locations. */
const LOCATIONS: string[] = [
  'C:/Program Files/Tailscale/tailscale.exe',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/bin/tailscale',
  'tailscale',
];

/** Every place to try, in order, including the `TAILSCALE_CLI` override. One
 *  list on purpose: the resolver below and the runner must not disagree about
 *  where to look, or a machine finds an install in one place and runs the CLI
 *  from another. */
export function tailscaleCandidateLocations(): string[] {
  return [process.env['TAILSCALE_CLI'], ...LOCATIONS].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

/** The first install location that exists on this machine, or null when none of
 *  the known ones does. Read-only: it never runs the CLI, so a command can ask
 *  "is Tailscale even here?" before it shows the owner a command line, and can
 *  show a full path rather than a bare name. `locations` is the list to look
 *  through, for a test that must not read this machine's real install. */
export function findTailscaleInstall(locations?: readonly string[]): string | null {
  for (const location of locations ?? tailscaleCandidateLocations()) {
    // The bare name is a PATH lookup, not a file that can be stat'd, so it is
    // not an answer to "where is it".
    if (!location.includes('/') && !location.includes('\\') && !location.endsWith('.exe')) {
      continue;
    }
    try {
      if (fs.existsSync(location)) return location;
    } catch {
      // An unreadable path is not an install: keep looking.
    }
  }
  return null;
}

/** One reported failure for "every location failed", so the two commands say the
 *  same thing in the same words and their tests can pin it. */
export const TAILSCALE_NOT_FOUND = 'the Tailscale CLI was not found on this machine';

/** A read (`status --json`, `serve status --json`) is a convenience: it has to
 *  fail fast, because the answer only decides what Forge offers or shows. */
export const TAILSCALE_READ_TIMEOUT_MS = 4_000;
/** A `serve` change talks to the local daemon and applies tailnet configuration,
 *  so it gets longer than a read — but still bounded, because a hung daemon must
 *  not hang a palette command. */
export const TAILSCALE_WRITE_TIMEOUT_MS = 15_000;

/**
 * Run one Tailscale command and return its stdout.
 *
 * `timeoutMs` is required rather than defaulted so no caller can accidentally
 * give a tailnet write the same 4 s a read gets; the caller's `signal` is passed
 * straight through, which is what cancels a command whose window closed, and a
 * deadline that fires is reported as that deadline rather than as a Tailscale
 * error. `locations` replaces the search list for the same reason `signal` is
 * there: production wants every known install, a test wants one it controls.
 */
export async function runTailscaleCli(
  args: string[],
  opts: {
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    /** Where to look for the CLI, in order. Defaults to this machine's known
     *  installs plus the `TAILSCALE_CLI` override. */
    locations?: readonly string[];
  },
): Promise<string> {
  for (const location of opts.locations ?? tailscaleCandidateLocations()) {
    try {
      const result = await execFileAsync(location, args, {
        timeout: opts.timeoutMs,
        signal: opts.signal,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      });
      // `String` rather than a cast: with `encoding: 'utf8'` Node hands back a
      // string, and a Node version that hands back a Buffer still reads the same
      // way, because a Buffer's own toString is the text.
      return String(result.stdout);
    } catch (error) {
      // Not installed here: try the next location. Anything else (a timeout, a
      // daemon that refuses, a killed child) is the answer, and retrying it at
      // the next location would only hide which one it was.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error(TAILSCALE_NOT_FOUND);
}
