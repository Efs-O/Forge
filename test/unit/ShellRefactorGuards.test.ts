/**
 * Guards for docs/plans/SHELL_TOOL_AND_CORE_GROUP_PLAN.md acceptance criteria.
 * Reads the tree from disk only — no Forge modules imported, so it stays green
 * (or red) independently of the refactor's internals.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

const REMOVED_TOOL_NAMES = [
  'exec_command',
  'query_powershell',
  'run_terminal',
  'run_workspace_task',
  'list_workspace_tasks',
];

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.njk', '.yaml', '.json', '.md']);

const ALLOWED_EXCEPTIONS = [
  'src/agents/adapters/codexAdapter.ts',
  'src/sidebar/compactionLedger.ts',
];

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function posixRel(file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function isException(file: string): boolean {
  const rel = posixRel(file);
  return ALLOWED_EXCEPTIONS.some((exception) => rel.endsWith(exception));
}

function lineHits(file: string, pattern: RegExp): string[] {
  const rel = posixRel(file);
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line, index) => (pattern.test(line) ? `${rel}:${index + 1}` : null))
    .filter((hit): hit is string => hit !== null);
}

describe('shell/core-group refactor guards', () => {
  it('removed tool names are absent from src/ and config/ except the allowed files', () => {
    const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'config'))].filter(
      (file) => !isException(file),
    );
    const hits = files.flatMap((file) =>
      REMOVED_TOOL_NAMES.flatMap((name) => lineHits(file, new RegExp(`\\b${name}\\b`))),
    );
    expect(hits, `removed tool names still referenced:\n${hits.join('\n')}`).toEqual([]);
  }, 20_000);

  // Raised from 3,500 in 0.17.4, and from 4,000 in 0.17.10: the owner raises the
  // cap when a rule earns its bytes rather than trimming rules to fit. It still
  // catches accidental bloat.
  it('config/templates/builtin/execute.njk is at most 5,000 bytes', () => {
    const file = path.join(root, 'config', 'templates', 'builtin', 'execute.njk');
    const size = fs.statSync(file).size;
    expect(size, `execute.njk is ${size} bytes; the cap is 5000`).toBeLessThanOrEqual(5000);
  });

  it('the dead src/templates/builtin copy is deleted', () => {
    expect(fs.existsSync(path.join(root, 'src', 'templates', 'builtin'))).toBe(false);
  });

  it('no file under src/tools/ declares a filepath schema property', () => {
    const patterns = [/\bfilepath\s*:/, /['"]filepath['"]\s*:/];
    const hits = walk(path.join(root, 'src', 'tools')).flatMap((file) =>
      patterns.flatMap((pattern) => lineHits(file, pattern)),
    );
    expect(hits, `filepath schema properties remain:\n${hits.join('\n')}`).toEqual([]);
  });
});
