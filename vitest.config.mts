import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors esbuild's `loader: { '.sh': 'text', '.ps1': 'text' }`: a script import
  // (the agent-bus .sh client, the Windows desktop .ps1 driver) is its text.
  plugins: [
    {
      name: 'script-as-text',
      transform(code: string, id: string) {
        if (id.endsWith('.sh') || id.endsWith('.ps1')) {
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
