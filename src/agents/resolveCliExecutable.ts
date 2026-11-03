import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CliAgentError } from './CliAgentError';
import { refreshWindowsPath, withWindowsPath, type WindowsUserPathDeps } from './windowsUserPath';
import { needsWindowsCmdShellWrap } from './windowsCmdShim';
import type { CliAgentName } from './types';

const execFileAsync = promisify(execFile);

/** The `where`/`which` call as `promisify(execFile)` makes it: resolves with the
 *  finder's stdout, the matching paths one per line. */
type FinderExecFile = (
  file: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; windowsHide?: boolean },
) => Promise<{ stdout: string }>;

export interface ResolveCliExecutableDeps {
  exists?: (candidate: string) => boolean;
  /** Resolves a bare command name to its full path via the platform's PATH
   *  lookup (`where` on Windows, `which` elsewhere). Rejects when not found.
   *  `env` is the environment block to search: on Windows the refreshed
   *  machine+user PATH rather than VS Code's startup snapshot, `undefined` to
   *  search the inherited one. `where` follows the PATH it is handed, so this
   *  is how a refreshed PATH actually reaches the lookup. */
  which?: (name: string, env?: NodeJS.ProcessEnv) => Promise<string>;
  /** `reg` reader for the Windows PATH refresh; injected so no unit test touches
   *  the registry. */
  execFile?: WindowsUserPathDeps['execFile'];
  /** The `where`/`which` lookup's own `execFile`, injected so a unit test can see
   *  the options the finder is called with. It resolves with what the real finder
   *  writes to stdout — the matching paths, one per line. Production callers never
   *  set it, and `which` above replaces the whole lookup when it is given. */
  finderExecFile?: FinderExecFile;
  /** Defaults to `process.platform`; injectable so the win32 gate is testable on
   *  a POSIX CI runner. Production callers never set it. */
  platform?: NodeJS.Platform;
  /** Environment the refreshed PATH is merged against. Defaults to `process.env`.
   *  Production callers never set it. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Chooses the best executable from `where`/`which` output. On Windows `where`
 * lists the extensionless npm shim (e.g. `npm\codex`) BEFORE the `.cmd` one
 * (e.g. `npm\codex.cmd`). Node cannot CreateProcess the extensionless shell
 * script (ENOENT), so prefer the `.cmd`/`.bat` match that spawnCliProcess
 * already knows how to wrap through cmd.exe. On POSIX the first match is the
 * executable — return it unchanged.
 */
export function pickExecutable(
  matches: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    const shellShim = matches.find((m) => needsWindowsCmdShellWrap(m));
    if (shellShim) return shellShim;
  }
  return matches[0];
}

/** The platform's own PATH lookup, as `promisify(execFile)` runs it: `where` on
 *  Windows, `which` elsewhere. `windowsHide` because every other spawn in Forge
 *  sets it — without it this one opened a console window on the owner's desktop
 *  every time a CLI agent resolved its executable (0.17.91 re-run, finding
 *  4). Rejects with the finder's own words when nothing matches. */
async function defaultWhich(
  name: string,
  env?: NodeJS.ProcessEnv,
  exec: FinderExecFile = execFileAsync,
): Promise<string> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const { stdout } = await exec(finder, [name], {
    ...(env ? { env } : {}),
    windowsHide: true,
  });
  const matches = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (matches.length === 0) throw new Error(`${finder} returned no match for "${name}"`);
  return pickExecutable(matches);
}

/**
 * Resolves a `cli` config field (bare name like `claude`/`codex`, or an
 * absolute path) to an executable path. Never touches config secrets — auth
 * is entirely the CLI's own login; this only locates the binary/shim.
 */
export async function resolveCliExecutable(
  cli: string,
  cliName: CliAgentName,
  deps: ResolveCliExecutableDeps = {},
): Promise<string> {
  const exists = deps.exists ?? fs.existsSync;
  const which: ResolveCliExecutableDeps['which'] =
    deps.which ?? ((name, env) => defaultWhich(name, env, deps.finderExecFile));

  if (path.isAbsolute(cli)) {
    if (!exists(cli)) {
      throw new CliAgentError(
        `${cliName} CLI not found at configured path "${cli}" — install it and log in.`,
      );
    }
    return cli;
  }

  // Whether the lookup searched the PATH the registry holds right now. It
  // decides the advice below, so it has to be settled before the try, not after.
  let searchedFreshPath = false;
  try {
    // The win32 gate is explicit here, as it is in `cliProcess.ts`: on Windows
    // the lookup searches the PATH the registry holds right now, so a CLI
    // installed after VS Code started is found without quitting VS Code. A
    // refreshed PATH is also what `cliProcess.ts` puts in the child's
    // environment block, so discovery and spawn resolution agree.
    const baseEnv = deps.env ?? process.env;
    const refresh =
      (deps.platform ?? process.platform) === 'win32'
        ? refreshWindowsPath(baseEnv, deps.execFile ? { execFile: deps.execFile } : {})
        : undefined;
    const freshPath = refresh?.path;
    searchedFreshPath = freshPath !== undefined;
    // `withWindowsPath` rather than `{ ...baseEnv, PATH: freshPath }`: on
    // Windows `process.env` stores the name as `Path`, so a spread would hand
    // `where` the stale `Path` and the fresh `PATH` at the same time.
    return await which(
      cli,
      freshPath !== undefined ? withWindowsPath(baseEnv, freshPath) : undefined,
    );
  } catch {
    throw new CliAgentError(
      `${cli} CLI not found on PATH — install it and log in.` +
        // Only true of a PATH that was never refreshed. When the registry
        // answered, this lookup already searched the PATH Windows holds right
        // now, so quitting VS Code cannot change the answer and the advice
        // would have been a lie.
        (searchedFreshPath
          ? ''
          : ' If you installed it after opening VS Code, quit VS Code completely and ' +
            'reopen it (a window reload does not refresh PATH).'),
    );
  }
}
