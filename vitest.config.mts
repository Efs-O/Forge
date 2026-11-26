import * as path from 'path';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Suites that fail when the machine is busy and pass alone.
 *
 * Each one spawns a real child (PowerShell, bash, node, Chrome) or leans on the
 * temp folder, so the suite's own workers are part of what it contends with: on
 * a 6-core machine also serving the local model engine, they lose to timeouts
 * and to scratch files a killed child never cleaned up. None of them is a hang.
 * Measured 2026-11-19: six red full runs, 5 to 6 of 813 files each time, a different set every time, every file
 * green in isolation.
 *
 * Add a suite here with the run that showed it, and say which run.
 */
const SERIAL_SUITES = [
  'test/integration/RenderHtmlPreviewLive.test.ts',
  'test/unit/AgentToAgentRelay.test.ts',
  'test/unit/AtomicWrite.test.ts',
  'test/unit/AtomicWriteAsync.test.ts',
  'test/unit/AtomicWriteContention.test.ts',
  'test/unit/AtomicWriteWindows.test.ts',
  'test/unit/ChatRuleApprovalDispatch.test.ts',
  'test/unit/CliSessionRegistry.test.ts',
  'test/unit/ExportDocumentTool.test.ts',
  'test/unit/ExternalGpuOverlap.test.ts',
  'test/unit/HistoryArchive.test.ts',
  'test/unit/MediaMusicReplicate.test.ts',
  'test/unit/MediaMusicRouting.test.ts',
  'test/unit/MediaVideoEngine.test.ts',
  'test/unit/MediaVideoStill.test.ts',
  'test/unit/ModelManagerSnapshot.test.ts',
  'test/unit/SdServerIdle.test.ts',
  'test/unit/WindowsJobObjectKill.test.ts',
];

// Mirrors esbuild's text loaders: scripts and shipped Markdown imports are
// their source text rather than parsed modules.
const scriptAsText = {
  name: 'script-as-text',
  transform(code: string, id: string) {
    if (id.endsWith('.sh') || id.endsWith('.ps1') || id.endsWith('.md')) {
      return `export default ${JSON.stringify(code)};`;
    }
    return undefined;
  },
};

/** The `vscode` module every unit test imports, stubbed for the run. */
const resolve = {
  alias: {
    vscode: path.resolve(import.meta.dirname, 'test', 'support', 'vscode.ts'),
  },
};

/**
 * What every project has to carry itself, because an inline project does NOT
 * inherit the root `test` block.
 *
 * Two things live here that used to sit at the root only:
 * • the temp guard's per-file half, which narrows `os.tmpdir()` to the file's
 *   own folder and stubs `defaultPolicyPath`; without it a suite writing a temp
 *   `config.yaml` reads the owner's real `~/.forge/policy.yaml`.
 *   Measured 2026-11-20: 122 failures across 22 files.
 * • the GitHub-runner timeout allowance. `testTimeout` and `hookTimeout` are
 *   project options - neither is in Vitest's `NonProjectOptions` list - so a
 *   root-only copy would leave both projects on the 5 s default and bring back
 *   the three Windows runs of 0.17.199-0.17.200 that failed on five separate
 *   timeouts, none of them a hang. Locally the default stays, so a real hang
 *   still shows up fast.
 *
 * Exported so `test/unit/VitestProjects.test.ts` can check the `CI` half, which
 * a local run never exercises. `globalSetup` is deliberately NOT here: it runs
 * once for the whole run, and a per-project copy would create the run folder
 * twice.
 */
export function projectTestOptions(env: Record<string, string | undefined> = process.env): {
  setupFiles: string[];
  testTimeout?: number;
  hookTimeout?: number;
} {
  return {
    setupFiles: ['test/support/tempGuard.setup.ts'],
    ...(env['CI'] ? { testTimeout: 20_000, hookTimeout: 20_000 } : {}),
  };
}

export default defineConfig({
  plugins: [scriptAsText],
  resolve,
  test: {
    // What stays at the root is what Vitest treats as global: the run folder
    // (created once, by the global setup) and coverage (merged across projects,
    // thresholds unchanged). Everything a suite needs per file is in
    // `projectTestOptions`, because a project does not inherit this block.
    globalSetup: ['test/support/tempGuard.global.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/extension.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
      },
    },
    // Vitest does not run this file as a project of its own, so both halves of
    // the suite are declared here - each with its own copy of the plugin, the
    // `vscode` alias and `projectTestOptions`, none of which an inline project
    // inherits. `maxWorkers`, `fileParallelism` and `sequence.groupOrder` are
    // not in Vitest's NonProjectOptions list either, so they can be set for one
    // project instead of for the whole run, which is the point: the 797 suites
    // that pass side by side keep their workers, and the 18 that do not get a
    // machine to themselves - after the rest have finished, not beside them.
    projects: [
      {
        plugins: [scriptAsText],
        resolve,
        test: {
          ...projectTestOptions(),
          name: 'parallel',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...SERIAL_SUITES],
          // Groups run lowest-first, so the serial project starts when this
          // pool has drained. Same-numbered groups share a machine, and every
          // other suite is in group 0.
          sequence: { groupOrder: 0 },
        },
      },
      {
        plugins: [scriptAsText],
        resolve,
        test: {
          ...projectTestOptions(),
          name: 'serial',
          include: SERIAL_SUITES,
          exclude: [...configDefaults.exclude],
          sequence: { groupOrder: 1 },
          // Two files at a time, and still only after the parallel pool has
          // drained, so the pair shares the machine with each other and with
          // nothing else. One at a time was the wrong trade: the 40 s Chrome
          // suite held up the 17 files behind it while 16 cores sat idle.
          // Measured 2026-11-26: docs/reports/ci-speed-2026-11-26.md.
          maxWorkers: 2,
        },
      },
    ],
  },
});
