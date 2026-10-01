import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The bash a test may spawn, or `undefined` where there is none to trust.
 *
 * On Windows a bare `bash` is the WSL launcher whenever WSL is installed, and
 * WSL is the wrong bash for every test here: it cannot read Windows paths, it
 * cold-starts its VM past a 5 s test timeout, and a test killed mid-launch
 * crashes WSL's Interop server (microsoft/WSL#41592), after which every later
 * `bash` fails with `Wsl/Service/E_UNEXPECTED` and `npm run ci` can hang. So on
 * Windows this resolves Git Bash by location and never falls back to `bash`:
 * a machine without Git Bash skips the bash tests instead of reaching WSL.
 */
export const TEST_BASH: string | undefined =
  process.platform === 'win32' ? findGitBash() : 'bash';

function findGitBash(): string | undefined {
  const roots = [process.env.ProgramW6432, process.env.ProgramFiles]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => path.join(dir, 'Git'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'));
  // A Git installed elsewhere: `git.exe` lives in `<root>\cmd` or `<root>\bin`.
  const where = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  for (const line of where.stdout?.split(/\r?\n/) ?? []) {
    if (line.trim()) roots.push(path.dirname(path.dirname(line.trim())));
  }
  return roots
    .map((root) => path.join(root, 'bin', 'bash.exe'))
    .find((candidate) => fs.existsSync(candidate));
}
