/**
 * Windows PATH refresh for CLI spawns — the single owner of that registry read.
 *
 * A VS Code extension host freezes `process.env.PATH` the moment it starts: a
 * window reload re-reads nothing, and only quitting VS Code picks up a PATH
 * change. Every name a CLI spawn resolves — the CLI itself, `node` for an npm
 * shim, `cmd.exe`, and everything the CLI's own subprocesses look up — comes
 * from that snapshot, so a CLI installed after VS Code opened stays invisible
 * for the rest of the session (issue 3 of `FORGE_CLI_AGENTS_WINDOWS_REPORT.md`).
 *
 * Windows builds PATH at logon from two registry keys, machine first then user.
 * Reading them at spawn time gives the child the PATH a freshly opened terminal
 * would have. Both consumers take it from here so they can never disagree:
 * `defaultWhich` in `resolveCliExecutable.ts` hands the value to `where`'s
 * environment block (`where` follows the PATH it is given, verified 2026-10-26),
 * and `cliProcess.ts` puts the same value in the child's environment block.
 *
 * This file also owns the one rule for putting a PATH into an environment block
 * at all: `withWindowsPath` replaces every casing the block already had, because
 * a spread that adds `PATH` on top of an inherited `Path` leaves two keys with
 * two different values and the winner is whichever sorts first, not the one that
 * is current. The child's block, `where`'s block and the `where.exe` probe's own
 * block all go through it, so no caller can get this wrong on its own.
 *
 * Nothing is guessed. `source:'startup'` with no PATH is the answer whenever the
 * machine key cannot be read — a merged PATH missing `C:\Windows\system32` would
 * be worse than the stale one, and the caller keeps `env.PATH` and says which
 * one it used in the spawn log line. A missing *user* `Path` value is not a
 * failure: a user with no per-user PATH is a normal machine, and the machine
 * entries plus the inherited entries are still exactly right.
 *
 * Windows-only by contract — both call sites gate on `platform === 'win32'` —
 * and `path.win32` is used throughout so a POSIX CI runner that imports this
 * file still splits and joins the same way Windows does. Cost is two `reg`
 * reads per CLI spawn (a cold start only, ~100 ms of blocking); that is what
 * buys a PATH that is never stale.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';

const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_KEY = 'HKCU\\Environment';

// reg.exe prints the value under the key header, four spaces deep:
//   HKEY_CURRENT_USER\Environment
//       Path    REG_EXPAND_SZ    C:\Users\me\AppData\Roaming\npm;…
// Both keys store `Path` as REG_EXPAND_SZ (its `%VAR%` tokens are what Windows
// expands at logon); REG_SZ appears when someone typed the value in by hand.
const REG_PATH_LINE = /^\s*Path\s+REG_(?:EXPAND_SZ|SZ)\s+(.*)$/im;

/** Which PATH a CLI child was given: the registry's current one, or the one VS Code started with. */
export type WindowsPathSource = 'fresh' | 'startup';

export interface WindowsPathRefresh {
  source: WindowsPathSource;
  /** The PATH a freshly opened terminal would carry. Present only when `source === 'fresh'`. */
  path?: string;
}

export interface WindowsUserPathDeps {
  /** Runs a program and returns its stdout exactly as the program printed it,
   *  or `undefined` when it could not answer. Defaults to `execFileSync`;
   *  injected so a unit test returns reg.exe's own output shape without ever
   *  touching the registry (CLAUDE.md: a fake returns what the real program returns). */
  execFile?: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => string | undefined;
}

/** Puts `value` into `env` as the one PATH key that Windows, Node and `where`
 *  agree on. Windows matches environment names case-insensitively, but the
 *  programs read the object they are handed: `process.env` on Windows stores the
 *  name as `Path`, so `{ ...process.env, PATH: fresh }` carries both the stale
 *  `Path` and the fresh `PATH`, and which one wins is whichever sorts first.
 *  The returned object is a copy; `env` is never mutated. */
export function withWindowsPath(env: NodeJS.ProcessEnv, value: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'path') delete result[key];
  }
  result.PATH = value;
  return result;
}

/** `reg query <key> /v Path`, the same value Windows reads at logon. A non-zero
 *  exit is `ERROR: The system was unable to find the specified registry key or
 *  value.` (verified against reg.exe 2026-10-26) or reg.exe itself being
 *  missing; Node throws on any non-zero exit, so both land here as "no answer".
 *  Not swallowed silently: the caller reports `pathSource=startup` in the spawn
 *  log line and keeps the PATH it already had. */
function defaultExecFile(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string | undefined {
  try {
    return (
      execFileSync(file, [...args], {
        encoding: 'utf8',
        env: { ...env },
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }) ?? undefined
    );
  } catch {
    return undefined;
  }
}

/** Case-insensitive environment lookup: `process.env` on Windows matches names
 *  case-insensitively, while a plain object handed in by a test has exact keys. */
function lookupEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === wanted) return env[key];
  }
  return undefined;
}

/** Expands `%VAR%` the way cmd.exe would, against the inherited environment —
 *  the same source `%SystemRoot%`, `%ProgramFiles%` and `%USERPROFILE%` come
 *  from at logon. Two passes so a machine value pointing at another variable
 *  resolves too; an unknown name is left as its literal text rather than
 *  guessed, and an entry that still contains `%` names a directory that does
 *  not exist, which `where` and `spawn` simply skip. */
function expandPercentTokens(value: string, env: NodeJS.ProcessEnv): string {
  let current = value;
  for (let pass = 0; pass < 2; pass++) {
    const next = current.replace(
      /%([^%]+)%/g,
      (whole, name: string) => lookupEnv(env, name) ?? whole,
    );
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Entries from one registry value, `%VAR%` expanded, blanks dropped. */
function registryEntries(value: string, env: NodeJS.ProcessEnv): string[] {
  return expandPercentTokens(value, env)
    .split(path.win32.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Entries VS Code already carried are already expanded by Windows, so they are
 *  taken as-is — rewriting them could change a folder that really does contain
 *  a `%` in its name. */
function inheritedEntries(env: NodeJS.ProcessEnv): string[] {
  return (lookupEnv(env, 'PATH') ?? '')
    .split(path.win32.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Windows paths are case-insensitive, and a trailing separator is the same
 *  directory: `…\nodejs` and `…\nodejs\` must not both survive. */
function dedupeKey(entry: string): string {
  return entry.replace(/[\\/]+$/u, '').toLowerCase();
}

/** Reads the machine then the user `Path`, merges them in the order Windows
 *  uses at logon, appends whatever VS Code already had (so its relative order
 *  survives), and dedupes case-insensitively keeping the first occurrence —
 *  which is the machine entry, the one Windows would have put first. */
export function refreshWindowsPath(
  env: NodeJS.ProcessEnv = process.env,
  deps: WindowsUserPathDeps = {},
): WindowsPathRefresh {
  const run = deps.execFile ?? defaultExecFile;
  const machine = readPathValue(run, MACHINE_KEY, env);
  if (machine === undefined) return { source: 'startup' };
  const user = readPathValue(run, USER_KEY, env);

  const seen = new Set<string>();
  const merged: string[] = [];
  const append = (entries: readonly string[]): void => {
    for (const entry of entries) {
      const key = dedupeKey(entry);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
  };
  append(registryEntries(machine, env));
  if (user !== undefined) append(registryEntries(user, env));
  append(inheritedEntries(env));

  if (merged.length === 0) return { source: 'startup' };
  return { source: 'fresh', path: merged.join(path.win32.delimiter) };
}

/** The `Path` data reg.exe printed for `key`, or `undefined` when the key, the
 *  value, or reg.exe itself is absent — the one case that must not become a
 *  shorter PATH. */
function readPathValue(
  execFile: NonNullable<WindowsUserPathDeps['execFile']>,
  key: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const match = REG_PATH_LINE.exec(execFile('reg', ['query', key, '/v', 'Path'], env) ?? '');
  const value = match?.[1]?.trimEnd();
  return value ? value : undefined;
}
