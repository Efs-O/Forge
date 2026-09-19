import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CliAgentError } from './CliAgentError';
import { needsWindowsCmdShellWrap } from './windowsCmdShim';
import type { CliAgentName } from './types';

const execFileAsync = promisify(execFile);

export interface ResolveCliExecutableDeps {
  exists?: (candidate: string) => boolean;
  /** Resolves a bare command name to its full path via the platform's PATH
   *  lookup (`where` on Windows, `which` elsewhere). Rejects when not found. */
  which?: (name: string) => Promise<string>;
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

async function defaultWhich(name: string): Promise<string> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const { stdout } = await execFileAsync(finder, [name]);
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
  const which = deps.which ?? defaultWhich;

  if (path.isAbsolute(cli)) {
    if (!exists(cli)) {
      throw new CliAgentError(
        `${cliName} CLI not found at configured path "${cli}" — install it and log in.`,
      );
    }
    return cli;
  }

  try {
    return await which(cli);
  } catch {
    throw new CliAgentError(`${cli} CLI not found on PATH — install it and log in.`);
  }
}
