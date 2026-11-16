// Runs a command while holding a machine-wide lock, so only one full CI runs at
// a time. Two at once, beside the local model engine, ran this machine out of
// memory on 2026-10-30 (spawn ENOMEM) and killed the engine. Every agent and
// worktree on the machine runs as one user, so they all share os.tmpdir().
// Usage: node scripts/ci-lock.mjs <command...>
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { treeHashOfWorkingTree } from './record-ci-pass.mjs';

export const POLL_MS = 5_000;
export const NOTICE_EVERY_MS = 5 * 60_000;
export const WAIT_LIMIT_MS = 45 * 60_000;
export const MAX_AGE_MS = 3 * 60 * 60_000;
export const UNREADABLE_GRACE_MS = 10_000;
export const EXIT_WAIT_TIMED_OUT = 75;

export function lockPath(env = process.env) {
  return env.FORGE_CI_LOCK_PATH || join(tmpdir(), 'forge-ci.lock');
}

/** Why this run takes no lock, or null when it must take one. */
export function skipReason(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') return 'GitHub Actions runs one job per runner';
  if (env.FORGE_CI_LOCK_HELD) return 'a parent run already holds the lock';
  return null;
}

/** True when a process with this pid exists (EPERM means it exists but is not ours). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** The lock record, null when there is no lock, or 'unreadable'. */
export function readLock(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return 'unreadable';
  }
  try {
    const lock = JSON.parse(text);
    return lock && typeof lock.token === 'string' ? lock : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** Why a lock may be taken over, or null while its run may still be going. */
export function staleReason(lock, { now, alive = pidAlive, mtimeMs }) {
  if (lock === 'unreadable') {
    return now - mtimeMs > UNREADABLE_GRACE_MS ? 'the lock file is unreadable' : null;
  }
  const age = now - Date.parse(lock.started);
  if (!(age < MAX_AGE_MS)) return `the lock is older than ${MAX_AGE_MS / 3_600_000} h`;
  if (!alive(lock.pid) && !alive(lock.childPid))
    return `its processes (pid ${lock.pid}) have exited`;
  return null;
}

/** Create the lock if nobody holds it. Returns null on success, else what holds it. */
export function tryAcquire(path, record) {
  try {
    writeFileSync(path, JSON.stringify(record), { flag: 'wx' });
    return null;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return readLock(path) ?? 'gone';
}

/** Delete the lock only if it still holds this run's token. */
export function release(path, token) {
  const lock = readLock(path);
  if (lock && lock !== 'unreadable' && lock.token === token) {
    try {
      unlinkSync(path);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

/** Remove a stale lock, unless another waiter replaced it since it was judged. */
function removeIfSame(path, judged) {
  const now = readLock(path);
  const same =
    judged === 'unreadable'
      ? now === 'unreadable'
      : now !== 'unreadable' && now?.token === judged.token;
  if (!same) return;
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

function describe(lock, now) {
  if (lock === 'unreadable') return 'a CI run whose lock file is still being written';
  const minutes = Math.round((now - Date.parse(lock.started)) / 60_000);
  return `the CI run in ${lock.cwd} (pid ${lock.pid}, started ${minutes} min ago)`;
}

/** Wait for the lock. Resolves true once held, false when the wait limit passed. */
export async function acquire(path, record, opts = {}) {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? console.log;
  const alive = opts.alive ?? pidAlive;
  const waitLimit = opts.waitLimitMs ?? WAIT_LIMIT_MS;
  const begun = now();
  let lastNotice = -Infinity;
  for (;;) {
    const holder = tryAcquire(path, record);
    if (holder === null) return true;
    if (holder === 'gone') continue;
    const stale = staleReason(holder, { now: now(), alive, mtimeMs: mtimeOf(path) });
    if (stale) {
      log(`ci-lock: taking over a stale lock (${stale}).`);
      removeIfSame(path, holder);
      continue;
    }
    if (now() - begun >= waitLimit) {
      log(
        `ci-lock: gave up after ${Math.round(waitLimit / 60_000)} min waiting for ${describe(holder, now())}.` +
          ` If that run is gone, delete ${path} and run again.`,
      );
      return false;
    }
    if (now() - lastNotice >= NOTICE_EVERY_MS) {
      log(
        `ci-lock: waiting for ${describe(holder, now())}. Two full CI runs at once run this machine out of memory.`,
      );
      lastNotice = now();
    }
    await sleep(opts.pollMs ?? POLL_MS);
  }
}

function recordChildPid(path, record, childPid) {
  const tmp = `${path}.${record.token}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...record, childPid }));
  try {
    renameSync(tmp, path);
  } catch (err) {
    // A waiter reading the file can block the rename on Windows; the holder pid
    // still keeps the lock alive, so report it and carry on.
    console.log(`ci-lock: could not record the child pid (${err.code}); the lock still holds.`);
    try {
      unlinkSync(tmp);
    } catch {
      /* the tmp file is never read */
    }
  }
}

async function main(argv) {
  const command = argv.join(' ');
  if (!command) {
    console.error('usage: node scripts/ci-lock.mjs <command...>');
    process.exit(2);
  }
  const path = lockPath();
  const skip = skipReason();
  const token = randomUUID();
  if (!skip) {
    const record = {
      pid: process.pid,
      childPid: null,
      token,
      cwd: process.cwd(),
      command,
      started: new Date().toISOString(),
    };
    if (!(await acquire(path, record))) process.exit(EXIT_WAIT_TIMED_OUT);
    process.on('exit', () => release(path, token));
    // The proof has to name the tree the suite started reading, not whatever the
    // last agent left behind minutes later: this worktree is shared, and a second
    // lane edits while CI runs. Handed over as env, so nothing new is written to
    // disk and no new state has to be cleaned up.
    let startTree;
    try {
      startTree = treeHashOfWorkingTree();
    } catch (err) {
      console.log(
        `ci-lock: could not hash the working tree (${err.message}); the pass will be recorded from the tree at the end of the run.`,
      );
    }
    const child = spawn(command, {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        FORGE_CI_LOCK_HELD: token,
        ...(startTree ? { FORGE_CI_START_TREE: startTree } : {}),
      },
    });
    if (child.pid) recordChildPid(path, record, child.pid);
    return forward(child);
  }
  forward(spawn(command, { shell: true, stdio: 'inherit' }));
}

function forward(child) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', (err) => {
    console.error(`ci-lock: could not start the command: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 1));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main(process.argv.slice(2));
}
