/**
 * `runTailscaleCli` and `findTailscaleInstall` against REAL child processes.
 *
 * The rule this file exists to prove is the one a stub cannot prove: that a
 * machine where Tailscale is hung, not installed, or answering badly costs the
 * owner a reported failure with the right cause, not a palette command that
 * never comes back. So the "CLI" here is `process.execPath` — a real
 * executable that gives real stdout, real exit codes, real ENOENT, real kills
 * and real Node error shapes — and the argv is the one the module under test
 * was given.
 *
 * This machine HAS a Tailscale (the owner's), and `docs/plans/V1_FINISH_PLAN.md`
 * lane 3 says no test runs `tailscale`. Every call here passes its own
 * `locations`, so the real install is never even looked up: nothing in this
 * file reads the owner's tailnet, and nothing can change it.
 *
 * The sender question (`docs/plans/V1_FINISH_PLAN.md` "Rules (every lane)",
 * seam question 2) has no session or chat to answer here: the only thing that
 * reaches this module is the stdout of a program Forge itself resolved and
 * started with an argv array, so a tailnet answer cannot arrive from a different
 * machine, a different chat or a different session. What IS checked is that the
 * call is argv-only (`execFile`, never a shell string), because that is what
 * stops a peer name read back from `status --json` from becoming a command line.
 */
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
  TAILSCALE_NOT_FOUND,
  findTailscaleInstall,
  runTailscaleCli,
  tailscaleCandidateLocations,
} from '../../src/vscode/tailscaleCli';

const CLI = process.execPath;

/** A path that does not exist: what "this install is not here" looks like.
 *  Named for this process, so two test runs never collide over it. */
const MISSING = path.join(os.tmpdir(), `forge-no-tailscale-${process.pid}.exe`);
const ALSO_MISSING = path.join(os.tmpdir(), `forge-no-tailscale-${process.pid}-2.exe`);

/** `process.stdout.write(<text>)`: a CLI that answered. */
function answers(text: string): string[] {
  return ['-e', `process.stdout.write(${JSON.stringify(text)});`];
}

/** A daemon that is hung: the child starts and never leaves on its own, so only
 *  a deadline or an abort can end the call. */
const HANG = ['-e', 'setTimeout(() => {}, 30_000);'];

/** A CLI that starts, then exits non-zero — what Tailscale does for a bad
 *  command, and what the real `serve` change does when the daemon refuses. */
function exits(code: number): string[] {
  return ['-e', `process.exit(${code});`];
}

/** The rejection, with the fields Node puts on it — `code`, `killed` — which are
 *  what the caller's message is built from. A test that only read `message` would
 *  pass on a fake that invented one. */
async function failure(promise: Promise<string>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call answered, so there was no failure to inspect');
}

describe('runTailscaleCli', () => {
  it('returns the child stdout exactly as the CLI wrote it', async () => {
    const status = '{"TCP":{"8798":{"TCPForward":"127.0.0.1:8798","EnableTcp":true}}}';
    const stdout = await runTailscaleCli(answers(status), { locations: [CLI], timeoutMs: 10_000 });
    expect(JSON.parse(stdout).TCP['8798'].TCPForward).toBe('127.0.0.1:8798');
  });

  it('a location that is not there is tried next, not reported as a failure', async () => {
    const stdout = await runTailscaleCli(answers('ok'), {
      locations: [MISSING, CLI],
      timeoutMs: 10_000,
    });
    expect(stdout).toBe('ok');
  });

  it('every location missing is one failure with the one message', async () => {
    const error = await failure(
      runTailscaleCli(answers('ok'), {
        locations: [MISSING, ALSO_MISSING],
        timeoutMs: 10_000,
      }),
    );
    expect(error.message).toContain(TAILSCALE_NOT_FOUND);
  });

  it('a CLI that answers and then fails is reported as itself, not retried somewhere else', async () => {
    const error = await failure(runTailscaleCli(exits(3), { locations: [CLI, MISSING], timeoutMs: 10_000 }));
    // The real exit code, on the real error field: what a failure message needs
    // so the owner can tell "Tailscale refused this command" from "Tailscale is
    // not installed". The second location must not have been tried, which is
    // what the next assertion proves: a retry would have ended in ENOENT and
    // produced the not-installed message instead.
    expect((error as { code?: string | number }).code).toBe(3);
    expect(error.message).not.toContain(TAILSCALE_NOT_FOUND);
  });

  it('a CLI that never comes back is cut by its own deadline', async () => {
    const started = Date.now();
    const error = await failure(runTailscaleCli(HANG, { locations: [CLI], timeoutMs: 400 }));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(4_000);
    // Node's own shape for a child killed by the `timeout` option, read from the
    // real process rather than asserted from memory: `killed` true, SIGTERM.
    expect((error as { killed?: boolean }).killed).toBe(true);
    expect((error as { signal?: string | null }).signal).toBe('SIGTERM');
    // Not reported as "not installed": the CLI WAS there, it just did not answer.
    expect(error.message).not.toContain(TAILSCALE_NOT_FOUND);
  });

  it('the caller aborting cuts the child, and an already-aborted signal cuts before it starts', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const error = await failure(
      runTailscaleCli(HANG, { locations: [CLI], timeoutMs: 30_000, signal: controller.signal }),
    );
    expect(Date.now() - started).toBeLessThan(4_000);
    expect((error as { code?: string }).code).toBe('ABORT_ERR');
    expect(error.message).not.toContain(TAILSCALE_NOT_FOUND);

    const already = AbortSignal.abort();
    const before = Date.now();
    await expect(runTailscaleCli(HANG, { locations: [CLI], timeoutMs: 30_000, signal: already })).rejects.toThrow();
    expect(Date.now() - before).toBeLessThan(1_000);
  });

  it('TAILSCALE_CLI is the first place tried, and a stale override does not survive it', () => {
    const previous = process.env['TAILSCALE_CLI'];
    process.env['TAILSCALE_CLI'] = 'Z:/forge-custom/tailscale.exe';
    try {
      expect(tailscaleCandidateLocations()[0]).toBe('Z:/forge-custom/tailscale.exe');
    } finally {
      if (previous === undefined) delete process.env['TAILSCALE_CLI'];
      else process.env['TAILSCALE_CLI'] = previous;
    }
    const without = tailscaleCandidateLocations();
    expect(without).not.toContain('Z:/forge-custom/tailscale.exe');
    // The list is the same on every OS: a macOS or Linux machine still has the
    // Windows path in it, and that is what lets one resolver serve all three.
    expect(without).toContain('C:/Program Files/Tailscale/tailscale.exe');
    expect(without).toContain('tailscale');
  });
});

describe('findTailscaleInstall', () => {
  it('names an install that exists, from the list it is given', () => {
    expect(findTailscaleInstall([MISSING, CLI])).toBe(CLI);
  });

  it('says null for a machine with none of them', () => {
    expect(findTailscaleInstall([MISSING, ALSO_MISSING])).toBeNull();
  });

  it('a bare name is not an answer: it is a PATH lookup, not a file to show', () => {
    // `Share` shows the owner a full path when it can find one, so a name that
    // cannot be stat'd must not come back as "found here".
    expect(findTailscaleInstall(['tailscale'])).toBeNull();
    expect(findTailscaleInstall(['Z:/forge-no/such/tailscale.exe'])).toBeNull();
  });
});
