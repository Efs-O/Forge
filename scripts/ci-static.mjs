#!/usr/bin/env node
/**
 * Run the three static checks of `npm run ci` side by side, and cache them.
 *
 * `type-check` and `lint` used to be the first two steps of `ci:steps`, run one
 * after another: `tsc` over `src` 8.8 s, `tsc` over `webview-ui` 4.9 s, `eslint`
 * 22.2 s, 36 s of a 268 s chain, paid again on every run because nothing was
 * cached. Measured 2026-11-26: docs/reports/ci-speed-2026-11-26.md.
 *
 * Three npm scripts in three child processes, so the wall time is the slowest
 * one (about 22 s) instead of the sum. Each child's output is buffered and
 * printed whole, when that child ends: interleaving three npm banners line by
 * line would read as nothing. A failing check does not stop the others, so one
 * run reports every error instead of the first one.
 *
 * The cache files live under `.forge/tmp/` (gitignored): `tsbuildinfo-ext`,
 * `tsbuildinfo-webview`, `eslintcache`. A warm tree re-checks in seconds; the
 * first run after a `git clean` pays the full cost.
 *
 * `summarize` is the formatting and the exit code, with no child processes in
 * it, so `test/unit/CiStatic.test.ts` can check the header format and the
 * "one failure fails the step" rule without spawning npm three times.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The npm scripts to run, in the order they are started. */
export const STATIC_SCRIPTS = ['type-check:ext', 'type-check:webview', 'lint'];

/** Where the cache files go; created before the children start. */
export const CACHE_DIR = '.forge/tmp';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** One decimal of a duration, so the header is stable across runs. */
function formatSeconds(seconds) {
  return (Math.round(Number(seconds) * 10) / 10).toFixed(1);
}

/**
 * The lines one finished check contributes: a header naming the script, how
 * long it took and how it exited, then everything it printed (stdout first,
 * then stderr, since the two are buffered separately).
 */
export function resultLines(result) {
  const lines = [`── ${result.script} (${formatSeconds(result.seconds)} s, exit ${result.code})`];
  for (const stream of [result.stdout, result.stderr]) {
    const text = String(stream ?? '').replace(/\r?\n$/, '');
    if (text === '') continue;
    lines.push(...text.split(/\r?\n/));
  }
  return lines;
}

/**
 * Format finished checks and decide the step's exit code.
 *
 * @param {{script: string, seconds: number, code: number|null, stdout?: string,
 *   stderr?: string}[]} results - one per check, in the order they ENDED.
 * @returns {{exitCode: number, lines: string[]}}
 */
export function summarize(results) {
  const lines = [];
  for (const result of results) lines.push(...resultLines(result));
  // A killed child reports a null code, which is a failure like any other.
  const exitCode = results.every((result) => result.code === 0) ? 0 : 1;
  return { exitCode, lines };
}

/** Run one npm script, buffering its output, and report how it ended. */
function runScript(script) {
  return new Promise((finished) => {
    const startedAt = Date.now();
    // `shell: true` because `npm` is `npm.cmd` here, and `node` will not run a
    // `.cmd` without one.
    const child = spawn('npm', ['run', script], { cwd: REPO_ROOT, shell: true, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      // No npm at all: report it as that script failing rather than crash the step.
      finished({
        script,
        seconds: (Date.now() - startedAt) / 1000,
        code: 1,
        stdout,
        stderr: `${stderr}${error.message}\n`,
      });
    });
    child.on('close', (code) => {
      finished({ script, seconds: (Date.now() - startedAt) / 1000, code, stdout, stderr });
    });
  });
}

async function main() {
  mkdirSync(join(REPO_ROOT, CACHE_DIR), { recursive: true });
  const open = STATIC_SCRIPTS.map((script) => {
    let tracked;
    tracked = runScript(script).then((result) => {
      const index = open.indexOf(tracked);
      if (index >= 0) open.splice(index, 1);
      return result;
    });
    return tracked;
  });
  const results = [];
  // Print each check as it ends, so a slow one is not silent, and keep going
  // after a failure so the run shows every error at once.
  while (open.length > 0) {
    const result = await Promise.race(open);
    results.push(result);
    process.stdout.write(`${resultLines(result).join('\n')}\n`);
  }
  const { exitCode } = summarize(results);
  process.exitCode = exitCode;
}

// Only run when this file is the entry point: importing `summarize` from a test
// must not start three copies of npm.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
