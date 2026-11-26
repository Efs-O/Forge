// Contains every test run's temp files: see docs/plans/TEMP_LEAK_PLAN.md.
// Points os.tmpdir() at a per-run folder before the workers start and deletes it
// at teardown, so a test that forgets its cleanup cannot add to the real %TEMP%.
// tempGuard.setup.ts narrows it further to one subfolder per test file.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { TestProject } from 'vitest/node';

const RUN_PREFIX = 'forge-test-run-';
const TEMP_VARS = process.platform === 'win32' ? ['TEMP', 'TMP'] : ['TMPDIR'];

declare module 'vitest' {
  export interface ProvidedContext {
    tempGuardRunDir: string;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A killed run leaves its folder behind; remove the ones whose vitest is gone. */
function sweepDeadRuns(base: string): void {
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    const pid = Number(name.slice(RUN_PREFIX.length).split('-')[0]);
    if (!Number.isSafeInteger(pid) || pid === process.pid || pidAlive(pid)) continue;
    const dir = path.join(base, name);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      // An orphan from that run still holds a file. It is not this run's folder,
      // so name it and go on rather than failing every run until it is found.
      console.warn(`tempGuard: could not remove ${dir} (${(error as Error).message})`);
    }
  }
}

export default function setup(project: TestProject): () => void {
  const base = os.tmpdir();
  sweepDeadRuns(base);
  const runDir = fs.mkdtempSync(path.join(base, `${RUN_PREFIX}${process.pid}-`));
  const saved = TEMP_VARS.map((name) => [name, process.env[name]] as const);
  for (const name of TEMP_VARS) process.env[name] = runDir;
  project.provide('tempGuardRunDir', runDir);
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    // A just-killed child can hold a folder as its cwd for a few seconds on Windows.
    // A child that outlives the run can hold one for good: the job keeper's loaded
    // DLL and Chromium's shader cache both land in a test file's fake home folder
    // now, and the process using them may still be up when this teardown runs.
    // EBUSY/EPERM is that case: name the folder and go on, since the next run's
    // `sweepDeadRuns` takes it once the process is gone, rather than failing the
    // run over a temp folder nobody can delete. Any other error is the guard's own
    // fault, so it goes up.
    try {
      fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM') throw error;
      console.warn(`tempGuard: could not remove ${runDir} (${(error as Error).message})`);
    }
  };
}
