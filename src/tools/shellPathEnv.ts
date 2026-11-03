/**
 * The PATH a shell child is given, and the Git Bash folder that has to lead it.
 *
 * Split out of `shellTool.ts`, which crossed ESLint's 500-line stop when the
 * untrusted-content rule arrived. One concern, two helpers: what the child's PATH
 * contains, and why Git Bash's folder must be FIRST in it on Windows — `bash
 * x.sh` inside a pwsh command line otherwise resolves System32's WSL launcher,
 * the WSL#41592 crash path this machine has hit before. Re-exported from
 * `shellTool.ts` so the tests that name them keep one import path.
 */
import * as path from 'path';
import { resolveGitBash, systemProbe } from './execProgramResolver';

export function withPathEntry(
  env: NodeJS.ProcessEnv,
  dir: string | undefined,
  position: 'append' | 'prepend' = 'append',
): NodeJS.ProcessEnv {
  if (!dir) return env;
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const entries = (env[key] ?? '').split(path.delimiter).filter(Boolean);
  if (position === 'append') {
    if (entries.includes(dir)) return env;
    return { ...env, [key]: [...entries, dir].join(path.delimiter) };
  }
  if (entries[0] === dir) return env;
  return { ...env, [key]: [dir, ...entries.filter((entry) => entry !== dir)].join(path.delimiter) };
}

/** Git Bash's folder, put FIRST on a Windows child's PATH: `bash x.sh` inside a
 *  pwsh command line would otherwise resolve System32's WSL launcher, the WSL#41592 crash path. */
export function gitBashDir(options: {
  bashPath?: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  if (options.bashPath) return path.win32.dirname(options.bashPath);
  try {
    return path.win32.dirname(resolveGitBash(systemProbe(), options.env ?? process.env));
  } catch {
    // No Git for Windows: nothing to put first; `shell: bash` itself still refuses.
    return undefined;
  }
}
