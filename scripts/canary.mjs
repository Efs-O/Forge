#!/usr/bin/env node
/**
 * The canary runner: plant one known bug at a time and check that the test written to
 * catch it goes red. A gate that cannot fail protects nothing, and every gate in this
 * repo was written by an agent who had never seen it fail.
 *
 * `test/fixtures/canary-cases.json` is the plant list. Each case names a file, the exact
 * text to find in it (exactly once), the buggy replacement, the test file that must go
 * red, and a substring of that test's failure output. `test/unit/CanaryCases.test.ts`
 * checks the same targets in the main tree on every `npm test`, so a refactor that moves
 * one of them fails loudly instead of quietly turning the case into a no-op.
 *
 * Everything is planted in a throwaway `git worktree` checked out at HEAD under
 * os.tmpdir(), never in the tree this runs from: this repository is a shared multi-agent
 * worktree, and a mutated source file left behind would be read (and committed) by the
 * next lane. The worktree the runner creates is the runner's own to remove — see the
 * `finally` block and the CLAUDE.md "Git Worktrees" removal steps it follows.
 *
 * It is never run by `npm run ci` or `npm test`: a canary run rewrites source files while
 * its own test children read them. Run it on purpose with `npm run canary`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CASES_FILE = join(REPO, 'test', 'fixtures', 'canary-cases.json');
/** Every folder this script ever creates, so a crashed run's leftovers are findable. */
const PREFIX = 'forge-canary-';
const IS_WINDOWS = process.platform === 'win32';
/** Vitest prints a whole failing suite; a truncated buffer would hide the assertion. */
const MAX_BUFFER = 64 * 1024 * 1024;
/** `git worktree remove` deletes a whole `node_modules` on N:, which takes minutes. */
const REMOVE_TIMEOUT_MS = 20 * 60_000;
const ADD_TIMEOUT_MS = 10 * 60_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
const TEST_TIMEOUT_MS = 15 * 60_000;

const log = (line) => process.stdout.write(`${line}\n`);

/**
 * Git and npm are spawned with `cwd` set and `shell: false`, so a path containing spaces
 * is one argument and never a command line. Windows is the exception for npm/npx alone:
 * they are `.cmd` shims, and Node 24 refuses to spawn a `.cmd` without a shell
 * (`spawnSync npm.cmd EINVAL`), so the real JS entry point next to this `node` binary is
 * resolved instead — the same script the shim runs, with no shell in between.
 */
function gitInvocation(args) {
  return { cmd: 'git', args, shell: false };
}

function npmInvocation(args) {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(cli)) return { cmd: process.execPath, args: [cli, ...args], shell: false };
  return { cmd: IS_WINDOWS ? 'npm.cmd' : 'npm', args, shell: IS_WINDOWS };
}

function vitestInvocation(cwd, args) {
  const entry = join(cwd, 'node_modules', 'vitest', 'vitest.mjs');
  if (existsSync(entry)) return { cmd: process.execPath, args: [entry, ...args], shell: false };
  return { cmd: IS_WINDOWS ? 'npx.cmd' : 'npx', args, shell: IS_WINDOWS };
}

/** Run one command. Never throws: a canary that dies on the first failed gate is useless. */
function run(invocation, opts) {
  const res = spawnSync(invocation.cmd, invocation.args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    shell: invocation.shell,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    timeout: opts.timeout,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.error) {
    const why = `${res.error.code ?? res.error.name}: ${res.error.message}`;
    return { status: res.status ?? null, output: `${output}\n${why}`.trim(), why };
  }
  return { status: res.status, output };
}

function tailLines(output, count) {
  return output
    .replace(/\r\n/g, '\n')
    .trimEnd()
    .split('\n')
    .slice(-count)
    .map((line) => `        ${line}`)
    .join('\n');
}

/** How many times `needle` appears in `text`. A case is only honest if it is exactly 1. */
function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

/** `git worktree remove`, no `--force`: a worktree with uncommitted work is never destroyed. */
function removeWorktree(path) {
  const res = run(gitInvocation(['worktree', 'remove', path]), {
    cwd: REPO,
    timeout: REMOVE_TIMEOUT_MS,
  });
  if (res.status !== 0) {
    log(`canary: \`git worktree remove\` failed for ${path}:\n${tailLines(res.output, 5)}`);
  }
  return res.status === 0;
}

/**
 * CLAUDE.md step 4: on Windows `git worktree remove` often deletes the contents, prunes
 * its own record, and leaves an empty folder behind because a handle still names it.
 * Retry the delete once, then name the path rather than leaving it silent.
 */
function ensureFolderGone(path) {
  if (!existsSync(path)) return true;
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    log(`canary: retrying the delete of ${path} failed (${err.message})`);
  }
  if (existsSync(path)) return false;
  return true;
}

/** One `git worktree prune`, after every removal, so git forgets what is already gone. */
function pruneWorktrees() {
  const res = run(gitInvocation(['worktree', 'prune']), { cwd: REPO, timeout: 120_000 });
  if (res.status !== 0) log(`canary: \`git worktree prune\` failed:\n${tailLines(res.output, 5)}`);
}

/** Paths under this script's own prefix: what git still tracks, plus untracked shells. */
function leftoverWorktrees() {
  const found = new Map();
  const remember = (path) => {
    const absolute = resolve(path);
    if (basenameIsCanary(absolute)) found.set(absolute.toLowerCase(), absolute);
  };
  const listed = run(gitInvocation(['worktree', 'list', '--porcelain']), {
    cwd: REPO,
    timeout: 120_000,
  });
  if (listed.status !== 0) {
    log(`canary: \`git worktree list\` failed:\n${tailLines(listed.output, 5)}`);
  } else {
    for (const line of listed.output.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) remember(line.slice('worktree '.length).trim());
    }
  }
  // A run killed between `add` and the `finally` block can leave a folder git has
  // already forgotten (or not yet recorded); the folder listing is the only thing that sees it.
  try {
    for (const name of readdirSync(tmpdir())) remember(join(tmpdir(), name));
  } catch (err) {
    log(`canary: could not list ${tmpdir()} (${err.message})`);
  }
  return [...found.values()];
}

function basenameIsCanary(path) {
  return path.split(/[\\/]/).filter(Boolean).pop()?.startsWith(PREFIX) === true;
}

/** A previous run's litter: removed with exactly the same steps as this run's worktree. */
function sweepLeftovers() {
  const leftovers = leftoverWorktrees().filter((path) => resolve(path) !== resolve(worktreePath()));
  if (leftovers.length === 0) return;
  log(`canary: removing ${leftovers.length} leftover worktree(s) from an earlier run`);
  for (const path of leftovers) {
    log(`canary: leftover ${path}`);
    removeWorktree(path);
    pruneWorktrees();
    if (!ensureFolderGone(path)) {
      log(`canary: LEFTOVER STILL ON DISK: ${path} — delete it once nothing holds it`);
    }
  }
}

function worktreePath() {
  // Resolved once per process so the sweep and the `finally` block agree on the path.
  if (!worktreePath.cached) {
    worktreePath.cached = join(tmpdir(), `${PREFIX}${process.pid}-${Date.now()}`);
  }
  return worktreePath.cached;
}

/** One case: plant, run the test that must notice, restore. Never throws. */
function runCase(testCase, dir) {
  const label = `${testCase.id ?? '(no id)'}`;
  const target = join(dir, testCase.file ?? '');
  let original;
  try {
    original = readFileSync(target, 'utf8');
  } catch (err) {
    return { status: 'invalid', detail: `${testCase.file} cannot be read (${err.message})` };
  }
  const hits = countOccurrences(original, testCase.find);
  if (hits !== 1) {
    return {
      status: 'invalid',
      detail: `\`find\` occurs ${hits} times in ${testCase.file}, expected exactly once`,
    };
  }
  // split/join, not String.replace: a `$&` inside a replacement string would be a pattern.
  writeFileSync(target, original.split(testCase.find).join(testCase.replace));
  const planted = run(vitestInvocation(dir, ['run', testCase.test]), {
    cwd: dir,
    timeout: TEST_TIMEOUT_MS,
  });
  const restore = run(gitInvocation(['checkout', '--', testCase.file]), {
    cwd: dir,
    timeout: 120_000,
  });
  if (restore.status !== 0) {
    log(`canary: could not restore ${testCase.file} in ${dir}:\n${tailLines(restore.output, 5)}`);
  }
  const needle = testCase.expect ?? '';
  const sawNeedle = needle !== '' && planted.output.includes(needle);
  if (planted.status !== 0 && sawNeedle) return { status: 'caught' };
  const why =
    planted.status === 0
      ? 'the test passed: the gate did not notice the bug'
      : `exit ${String(planted.status)} did not name the expected failure`;
  return {
    status: 'missed',
    detail: `${why} (expected output to contain ${JSON.stringify(needle)})\n${tailLines(planted.output, 20)}`,
  };
}

function main() {
  let cases;
  try {
    cases = JSON.parse(readFileSync(CASES_FILE, 'utf8'));
  } catch (err) {
    log(`canary: cannot read ${CASES_FILE} (${err.message})`);
    return 1;
  }
  if (!Array.isArray(cases) || cases.length === 0) {
    log(`canary: ${CASES_FILE} holds no cases`);
    return 1;
  }

  sweepLeftovers();

  const dir = worktreePath();
  let added = false;
  const results = [];
  try {
    log(`canary: creating a worktree at ${dir}`);
    const add = run(gitInvocation(['worktree', 'add', '--detach', dir, 'HEAD']), {
      cwd: REPO,
      timeout: ADD_TIMEOUT_MS,
    });
    if (add.status !== 0) {
      log(`canary: \`git worktree add\` failed:\n${tailLines(add.output, 20)}`);
      return 1;
    }
    added = true;

    log(`canary: npm ci --prefer-offline (once, in the worktree)`);
    const install = run(npmInvocation(['ci', '--prefer-offline']), {
      cwd: dir,
      timeout: INSTALL_TIMEOUT_MS,
    });
    if (install.status !== 0) {
      log(`canary: npm ci failed:\n${tailLines(install.output, 20)}`);
      return 1;
    }

    for (const testCase of cases) {
      log(`canary: planting ${testCase.id} in ${testCase.file}`);
      const result = runCase(testCase, dir);
      results.push({ id: testCase.id, status: result.status, detail: result.detail });
      log(`canary: ${result.status.padEnd(7)} ${testCase.id}${result.detail ? ` — ${result.detail.split('\n')[0]}` : ''}`);
    }
  } finally {
    // CLAUDE.md "Git Worktrees": the creator removes what it made, every time.
    if (added || existsSync(dir)) removeWorktree(dir);
    pruneWorktrees();
    if (!ensureFolderGone(dir)) {
      log(`canary: WORKTREE FOLDER STILL ON DISK: ${dir} — delete it once nothing holds it`);
    }
  }

  let caught = 0;
  for (const result of results) {
    if (result.status === 'caught') caught += 1;
  }
  for (const result of results) {
    if (result.status === 'caught') continue;
    log(`canary: ${result.status.toUpperCase()} ${result.id}: ${result.detail ?? ''}`);
  }
  log(`caught ${caught} / ${results.length}`);
  const bad = results.filter((r) => r.status !== 'caught').length;
  return bad === 0 ? 0 : 1;
}

process.exitCode = main();
