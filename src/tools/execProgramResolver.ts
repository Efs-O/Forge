import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Injectable PATH probe for locating Git Bash without ever resolving System32\bash.exe. */
export interface RunnerProbe {
  which(program: string): string[];
  exists(candidate: string): boolean;
}

function systemProbe(): RunnerProbe {
  return {
    which: (program) => {
      const lookup = childProcess.spawnSync('where.exe', [program], { encoding: 'utf8' });
      return (lookup.stdout ?? '')
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
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
