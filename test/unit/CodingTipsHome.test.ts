/**
 * Phase 3 of CODING_TIPS_IN_TOOLS_PLAN.md: the two tips tables are two homes, and
 * a row in the wrong one is invisible where it is wrong. The project list
 * (`docs/CODING_TIPS.md`) is for rows true of THIS repository or THIS machine —
 * a general tip belongs in `resources/tips/CODING_TIPS.md`, where every user's
 * agent reads it.
 *
 * The second rule is the one that fails silently today: a `FORGE_TOOLS` row is
 * appended to that tool's own description, so a row naming a tool that does not
 * exist is appended to nothing. It reads like a tip and is not one.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- the standalone catalog is a plain ESM script
import { extractToolAuditSnapshot } from '../../scripts/tool-audit-catalog.mjs';

const repoRoot = path.resolve(__dirname, '..', '..');
const PROJECT_TABLE = path.join(repoRoot, 'docs', 'CODING_TIPS.md');
const SHIPPED_TABLE = path.join(repoRoot, 'resources', 'tips', 'CODING_TIPS.md');

/** Tracked paths, as the three sets the matcher needs: exact paths, every proper
 *  prefix folder of a tracked path, and every tracked basename (with and without
 *  its last extension), so `secretPaths` matches `src/tools/secretPaths.ts`.
 *  Read once: it is a Git subprocess, and every row of both tables asks it. */
let spans: { files: Set<string>; dirs: Set<string>; bases: Set<string> } | undefined;
function trackedSpans(): { files: Set<string>; dirs: Set<string>; bases: Set<string> } {
  spans ??= (() => {
    const tracked = execFileSync('git', ['ls-files'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
    const files = new Set(tracked);
    const dirs = new Set<string>();
    const bases = new Set<string>();
    for (const trackedPath of tracked) {
      const parts = trackedPath.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
      const base = parts[parts.length - 1];
      bases.add(base);
      bases.add(base.replace(/\.[^.]+$/, ''));
    }
    return { files, dirs, bases };
  })();
  return spans;
}

/** Facts only true of this machine, which is exactly what the project table is
 *  for: a drive letter, the 8.3 form of the user folder, the printer's name. */
const PC_FACTS = ['N:', 'EFSOOF~1', 'Canon IJ'];

/** Does this row name something in the repository? A path with a folder in it
 *  counts when the folder exists, so a placeholder like `test/unit/x.test.ts`
 *  passes: the row is about the folder's convention, not that one file. */
function namesRepoPath(span: string): boolean {
  const { files, dirs, bases } = trackedSpans();
  if (/\s/.test(span)) return false;
  const cut = span.split(/[*<]/)[0].replace(/\/+$/, '');
  if (!cut) return false;
  if (cut.includes('/')) {
    if (files.has(cut) || dirs.has(cut)) return true;
    const parent = cut.slice(0, cut.lastIndexOf('/'));
    return span === cut && dirs.has(parent);
  }
  return files.has(cut) || dirs.has(cut) || bases.has(cut);
}

/** Every path-like span a row offers, then the row itself for a PC fact. */
function rowIsAtHome(row: string): boolean {
  const ticked = [...row.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]);
  const words = row
    .replace(/^\d+\.\s+/, '')
    .split(/[\s`'"(),]+/)
    .map((w) => w.replace(/[:.;]+$/, ''))
    .filter((w) => /[/.]/.test(w));
  return (
    PC_FACTS.some((fact) => row.includes(fact)) || [...ticked, ...words].some(namesRepoPath)
  );
}

/** The numbered rows of the project table. */
function projectRows(): string[] {
  return fs
    .readFileSync(PROJECT_TABLE, 'utf8')
    .split(/\r?\n/)
    .filter((line) => /^\d+\.\s/.test(line));
}

/** The numbered rows of one file's `## FORGE_TOOLS` section: after that heading
 *  up to the next `## `. No section means no rows to check. */
function forgeToolRows(text: string): string[] {
  const marker = '\n## FORGE_TOOLS\n';
  const at = text.indexOf(marker);
  if (at === -1) return [];
  const after = text.slice(at + marker.length);
  const nextSection = after.search(/^## /m);
  return (nextSection === -1 ? after : after.slice(0, nextSection))
    .split(/\r?\n/)
    .filter((line) => /^\d+\.\s/.test(line));
}

let toolNames = new Set<string>();

describe.skipIf(!fs.existsSync(PROJECT_TABLE))(
  'every tips row lives in the table that describes it',
  () => {
    beforeAll(async () => {
      const snapshot = await extractToolAuditSnapshot();
      toolNames = new Set<string>(
        (snapshot.definitions as { function: { name: string } }[]).map(
          (definition) => definition.function.name,
        ),
      );
    }, 60_000);

    it('keeps a general tip out of the project table', () => {
      const rows = projectRows();
      expect(rows.length, 'the project table must have rows to audit').toBeGreaterThan(0);
      const failures = rows
        .filter((row) => !rowIsAtHome(row))
        .map(
          (row) =>
            `general tip in the project list: move it to resources/tips/CODING_TIPS.md: ${row}`,
        );
      expect(failures).toEqual([]);
    });

    it('does not accept every row — the rule can actually refuse', () => {
      expect(rowIsAtHome('1. `foo` on a big file → slow. pass `limit`')).toBe(false);
    });

    it('names a real tool in every FORGE_TOOLS row of both tables', () => {
      expect(toolNames.size, 'the registry snapshot must have loaded').toBeGreaterThan(0);
      const failures: string[] = [];
      for (const table of [PROJECT_TABLE, SHIPPED_TABLE]) {
        if (!fs.existsSync(table)) continue;
        for (const row of forgeToolRows(fs.readFileSync(table, 'utf8'))) {
          const name = /^\d+\. `([a-z][a-z0-9_]*)` · /.exec(row)?.[1];
          if (name && !toolNames.has(name)) failures.push(`${table}: unknown tool ${name}`);
        }
      }
      expect(failures).toEqual([]);
    });
  },
);
