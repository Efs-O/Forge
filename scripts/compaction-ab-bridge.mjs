/**
 * Loads Forge's real compaction code into a plain Node script.
 *
 * `CompactionService` imports `vscode`, which does not exist outside the
 * extension host, so the module is bundled with the same stub the unit tests
 * use. Bundling (rather than reimplementing the split) is the point: the A/B
 * must exercise the shipping `selectCompactionSplit` and `buildSummaryPrompt`,
 * not a copy of them that can drift.
 */

import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Forward slashes: esbuild resolves import specifiers, not Windows paths. */
function spec(...parts) {
  return path
    .resolve(ROOT, ...parts)
    .split(path.sep)
    .join('/');
}

export async function loadForgeCompaction(outDir) {
  const entry = path.join(outDir, 'forge-compaction-entry.mjs');
  const outfile = path.join(outDir, 'forge-compaction.mjs');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    entry,
    [
      `export { selectCompactionSplit, buildSummaryPrompt, RETAINED_TAIL_MAX_CHARS, COMPACTION_SUMMARY_MAX_CHARS } from '${spec('src/sidebar/CompactionService.ts')}';`,
      `export { estimateTokens, CHARS_PER_TOKEN } from '${spec('src/util/contextBudget.ts')}';`,
      `export { injectSystemPrompt } from '${spec('src/llm/SystemPromptInjector.ts')}';`,
    ].join('\n'),
    'utf8',
  );

  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
    alias: { vscode: spec('test/support/vscode.ts') },
  });

  return import(pathToFileURL(outfile).href);
}
