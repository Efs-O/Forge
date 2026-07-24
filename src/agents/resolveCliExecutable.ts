import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CliAgentError } from './CliAgentError';
import type { CliAgentName } from './types';

const execFileAsync = promisify(execFile);

export interface ResolveCliExecutableDeps {
  exists?: (candidate: string) => boolean;
  /** Resolves a bare command name to its full path via the platform's PATH
   *  lookup (`where` on Windows, `which` elsewhere). Rejects when not found. */
  which?: (name: string) => Promise<string>;
}

async function defaultWhich(name: string): Promise<string> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const { stdout } = await execFileAsync(finder, [name]);
  const first = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) throw new Error(`${finder} returned no match for "${name}"`);
  return first;
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
