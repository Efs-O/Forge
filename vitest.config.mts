import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors esbuild's text loaders: scripts and shipped Markdown imports are
  // their source text rather than parsed modules.
  plugins: [
    {
      name: 'script-as-text',
      transform(code: string, id: string) {
        if (id.endsWith('.sh') || id.endsWith('.ps1') || id.endsWith('.md')) {
          return `export default ${JSON.stringify(code)};`;
        }
        return undefined;
      },
    },
  ],
  resolve: {
    alias: {
      vscode: path.resolve(import.meta.dirname, 'test', 'support', 'vscode.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    // GitHub's runners (`CI` is set there) miss the 5 s default on a different
    // test each run: three Windows runs of 0.17.199-0.17.200 failed on five
    // separate timeouts, none of them a hang. Locally the default stays, so a
    // real hang still shows up fast.
    ...(process.env['CI'] ? { testTimeout: 20_000, hookTimeout: 20_000 } : {}),
    // Temp-leak guard: per-run and per-file temp folders (docs/plans/TEMP_LEAK_PLAN.md).
    globalSetup: ['test/support/tempGuard.global.ts'],
    setupFiles: ['test/support/tempGuard.setup.ts'],
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
  },
});
