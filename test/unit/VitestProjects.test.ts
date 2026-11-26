import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import config, { projectTestOptions } from '../../vitest.config.mts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** The two projects `vitest.config.mts` declares, by name. */
function project(name: string): Record<string, unknown> {
  const projects = (config.test as { projects?: Record<string, { test?: Record<string, unknown> }> })
    .projects as { test?: Record<string, unknown> }[];
  const found = projects.find((entry) => (entry.test as { name?: string })?.name === name);
  if (!found) throw new Error(`vitest.config.mts declares no project named ${name}`);
  return found.test as Record<string, unknown>;
}

/** The whole project entry: `plugins` and `resolve` sit beside `test`, not in it. */
function projectEntry(name: string): Record<string, unknown> {
  const projects = (config.test as { projects?: Record<string, unknown>[] }).projects as Record<
    string,
    unknown
  >[];
  const found = projects.find((entry) => (entry.test as { name?: string } | undefined)?.name === name);
  if (!found) throw new Error(`vitest.config.mts declares no project named ${name}`);
  return found;
}

describe('the vitest projects split', () => {
  const serial = project('serial');
  const parallel = project('parallel');
  const serialFiles = serial.include as string[];
  const parallelExcludes = parallel.exclude as string[];

  it('names only suites that exist, so a rename cannot quietly move one back to parallel', () => {
    const missing = serialFiles.filter((file) => !fs.existsSync(path.join(REPO_ROOT, file)));
    expect(missing).toEqual([]);
    expect(serialFiles.length).toBeGreaterThan(0);
  });

  it('keeps every serialised suite out of the parallel project', () => {
    const leaked = serialFiles.filter((file) => !parallelExcludes.includes(file));
    expect(leaked).toEqual([]);
  });

  it('runs the contention suites two files at a time and leaves the rest parallel', () => {
    // Two at a time, not one: alone, the 40 s Chrome suite held up the 17
    // files behind it. `groupOrder: 1` still keeps the pair off the machine
    // until the parallel pool has drained. Measured 2026-11-26:
    // docs/reports/ci-speed-2026-11-26.md.
    expect(serial.fileParallelism).toBeUndefined();
    expect(serial.maxWorkers).toBe(2);
    // The other project keeps the default: it is the one that passes side by side.
    expect(parallel.fileParallelism).not.toBe(false);
    expect(parallel.maxWorkers).toBeUndefined();
  });

  it('declares both halves, because Vitest never runs the root config as a project', () => {
    expect(project('parallel').include).toEqual(['test/**/*.test.ts']);
    expect((serial.include as string[]).length).toBeLessThan(40);
  });

  it('gives each project the temp guard, which the root copy does not reach', () => {
    // Without it `os.tmpdir()` is the run folder instead of the file's own, and
    // `defaultPolicyPath` is not stubbed, so a suite writing a temp config.yaml
    // reads the owner's real policy file. 122 failures, 22 files, 2026-11-20.
    for (const name of ['parallel', 'serial']) {
      expect(project(name).setupFiles).toEqual(['test/support/tempGuard.setup.ts']);
      const alias = (projectEntry(name).resolve as { alias: Record<string, string> }).alias;
      expect(alias.vscode).toContain(path.join('test', 'support', 'vscode.ts'));
    }
  });

  it('runs the serial group only after the parallel pool has drained', () => {
    // Projects sharing a group number share a machine; groups run lowest-first.
    // Without this the 18 suites run beside 797 parallel workers anyway.
    expect(parallel.sequence).toEqual({ groupOrder: 0 });
    expect(serial.sequence).toEqual({ groupOrder: 1 });
  });

  it('gives each project the GitHub-runner allowance, not just the root', () => {
    // `testTimeout`/`hookTimeout` are project options, and an inline project
    // does not inherit the root block, so a root-only copy left both projects
    // on the 5 s default on GitHub's runners.
    expect(projectTestOptions({})).toEqual({ setupFiles: ['test/support/tempGuard.setup.ts'] });
    const ci = projectTestOptions({ CI: '1' });
    expect(ci.testTimeout).toBe(20_000);
    expect(ci.hookTimeout).toBe(20_000);
    const loaded = projectTestOptions();
    for (const name of ['parallel', 'serial']) {
      expect(project(name).testTimeout).toBe(loaded.testTimeout);
      expect(project(name).hookTimeout).toBe(loaded.hookTimeout);
    }
  });

  it('collects every suite on disk, so an explicit include cannot drop one', () => {
    // Vitest's own default include covers more extensions than this config
    // names; a suite written in one of the others would leave the run unseen.
    const strays: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(test|spec)\.(tsx?|jsx?|mjs|mts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          strays.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'test'));
    expect(strays).toEqual([]);
  });
});
