import * as path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Mirrors esbuild's `loader: { '.sh': 'text' }`: a .sh import is its text.
  plugins: [
    {
      name: 'sh-as-text',
      transform(code: string, id: string) {
        return id.endsWith('.sh') ? `export default ${JSON.stringify(code)};` : undefined;
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
