import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { withWindowsPath } from '../agents/windowsUserPath';

/** Injectable PATH probe for locating Git Bash without ever resolving System32\bash.exe. */
export interface RunnerProbe {
  /** Every full path the lookup reports for `program`. `pathValue` searches that
   *  PATH instead of the inherited one — `where` follows the environment block it
   *  is given — so a refreshed PATH can be searched without mutating
   *  `process.env`, which would change the whole extension host. Optional, so
   *  existing probes and callers that take one argument are unchanged. */
  which(program: string, pathValue?: string): string[];
  exists(candidate: string): boolean;
}

/** The repo's only synchronous `where.exe` probe. Both consumers take it from
 *  here: `resolveGitBash` below, and `defaultWhichOnPath` in
 *  `src/agents/windowsCmdShim.ts` for the Node that runs an npm shim's script.
 *  `INFO:` lines are dropped because `where` prints them on stdout when it finds
 *  nothing (exit 1, `INFO: Could not find files for the given pattern(s).`,
 *  verified against the real program 2026-10-26) and they are not matches. */
export function systemProbe(): RunnerProbe {
  return {
    which: (program, pathValue) => {
      const lookup = childProcess.spawnSync('where.exe', [program], {
        encoding: 'utf8',
        ...(pathValue === undefined ? {} : { env: withWindowsPath(process.env, pathValue) }),
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return (lookup.stdout ?? '')
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && !/^INFO:/iu.test(entry));
    },
    exists: fs.existsSync,
  };
}

export function resolveGitBash(
  probe: RunnerProbe = systemProbe(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const roots = [env.ProgramW6432, env.ProgramFiles]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => path.win32.join(dir, 'Git'));
  if (env.LOCALAPPDATA) roots.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Git'));
  for (const git of probe.which('git.exe')) roots.push(path.win32.dirname(path.win32.dirname(git)));
  const bash = roots.map((root) => path.win32.join(root, 'bin', 'bash.exe')).find(probe.exists);
  if (bash) return bash;
  throw new Error(
    'bash: Git Bash was not found. A bare bash here would launch WSL. Install Git for Windows to use shell: bash.',
  );
}
