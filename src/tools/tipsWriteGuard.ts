/**
 * The write path for the project tips table (`docs/CODING_TIPS.md`).
 *
 * The table is injected into every prompt, so a second copy of a line costs the
 * prompt twice, and a list nobody ever reviews grows without end. Both are
 * handled here rather than in prompt text the model has to remember: the three
 * tools that can write the file (`edit_file`, `write_file`, `apply_line_edits`)
 * all compute their final content before writing, so the rule runs on exactly the
 * bytes that reach the disk.
 *
 * The count is "entries this repository has that the shipped table does not",
 * recomputed from the two files on every write and never stored: promoting the
 * keepers into the shipped list, or clearing the project file, resets it with no
 * state to keep in sync. Every tenth one asks the agent to hand the list back to
 * the owner, who reviews it — the ping rides on the write result, so it repeats
 * per recorded tip and not per turn.
 *
 * Comparison ignores whitespace and case: a re-wrapped or re-cased line is the
 * same tip, and the near-duplicate case is the CI detector's job
 * (`test/unit/InstructionSourceOverlap.test.ts`), not this one's.
 */

import * as fs from 'fs';

import { resolveShippedTipsPath } from '../llm/codingTips';

/** Numbered tips entries only — prose and headings are not tips. */
const ENTRY = /^\s*\d+\.\s+\S/;

/**
 * The key that identifies an entry. The number is STRIPPED: entries are numbered
 * per section, so the duplicate an agent actually writes — the same tip appended
 * as `4.` under a section whose copy is `1.` — would otherwise key differently
 * and pass. What survives is the tip text itself, normalised.
 */
function entryKey(line: string): string {
  return line
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The tips file an agent may write, matched on the tail so no workspace root is needed. */
export function isProjectTipsPath(filePath: string): boolean {
  return filePath.replace(/\\/g, '/').toLowerCase().endsWith('docs/coding_tips.md');
}

function entryKeys(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => ENTRY.test(line))
    .map(entryKey);
}

function countBy(entries: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of entries) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

function resolveShipped(shippedPath: string | undefined): string | undefined {
  // A caller-named file (a test fixture) is used as given; otherwise the shipped
  // table is found relative to the running bundle, as the injection finds it.
  if (shippedPath !== undefined) return fs.existsSync(shippedPath) ? shippedPath : undefined;
  return resolveShippedTipsPath();
}

function readShipped(shippedPath: string | undefined): string {
  const resolved = resolveShipped(shippedPath);
  if (!resolved) return '';
  try {
    return fs.readFileSync(resolved, 'utf8');
  } catch {
    return '';
  }
}

/** The entry to blame, as the text the agent wrote, not the normalised key. */
function originalLineOf(text: string, key: string): string {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => ENTRY.test(candidate) && entryKey(candidate) === key);
  return (line ?? key).trim().slice(0, 140);
}

/**
 * Refuse a write that introduces a tip the table already has — either a second
 * copy inside the project file, or a copy of a line the shipped table already
 * injects. A tip that was already on file is not this write's fault, so an
 * unrelated edit to a file that happens to hold a duplicate still goes through.
 */
export function tipsWriteRefusal(params: {
  proposed: string;
  previous: string;
  shippedPath?: string | undefined;
}): string | undefined {
  const previousCounts = countBy(entryKeys(params.previous));
  const proposedCounts = countBy(entryKeys(params.proposed));
  const shippedKeys = new Set(entryKeys(readShipped(params.shippedPath)));
  for (const [key, count] of proposedCounts) {
    if (count <= (previousCounts.get(key) ?? 0)) continue;
    if (count > 1 || shippedKeys.has(key)) {
      return (
        `docs/CODING_TIPS.md already carries this tip: ` +
        `"${originalLineOf(params.proposed, key)}" — sharpen that line instead of adding a copy.`
      );
    }
  }
  return undefined;
}

/**
 * Refuse before anything is written; each tool calls this on the content it is
 * about to save, so a refusal means no bytes changed.
 */
export function guardTipsWrite(
  filePath: string,
  proposed: string,
  previous: string,
  shippedPath?: string,
): void {
  if (!isProjectTipsPath(filePath)) return;
  const refusal = tipsWriteRefusal({ proposed, previous, shippedPath });
  if (refusal) throw new Error(`${refusal} No changes were written.`);
}

/**
 * What to tell the agent about the table it just changed: how many entries the
 * shipped list does not have, and — ONCE, when the count crosses a tenth — that
 * the owner wants to be told. `previous` is the file as it was before this write,
 * so the ping is a crossing of a tenth, not a hit on one: a re-word while the
 * count sits at 10 stays quiet, and a write that jumps 9 to 11 still fires once.
 * Empty for every other file, and for a project table that holds nothing the
 * shipped one does not.
 *
 * Guarded writers are the three file tools. `move_file` onto this path, a shell
 * `>>` or `sed -i`, and `git checkout`/`restore` all change the file unguarded —
 * accepted: the shell cannot be intercepted here, and the Phase 3 overlap test
 * catches a duplicate that slips in, one turn later.
 */
export function tipsWriteNote(filePath: string, previous: string, shippedPath?: string): string {
  if (!isProjectTipsPath(filePath) || !fs.existsSync(filePath)) return '';
  const shippedKeys = new Set(entryKeys(readShipped(shippedPath)));
  const unreviewedNow = new Set(
    entryKeys(fs.readFileSync(filePath, 'utf8')).filter((k) => !shippedKeys.has(k)),
  );
  if (unreviewedNow.size === 0) return '';
  const unreviewedBefore = new Set(entryKeys(previous).filter((k) => !shippedKeys.has(k)));
  const review =
    Math.floor(unreviewedNow.size / 10) > Math.floor(unreviewedBefore.size / 10)
      ? ` ${unreviewedNow.size} recorded since the shipped table: tell the owner now and offer to promote the keepers.`
      : '';
  return (
    `\nProject tips: ${unreviewedNow.size} entr${unreviewedNow.size === 1 ? 'y' : 'ies'} in ` +
    `docs/CODING_TIPS.md are not in the shipped table.${review}`
  );
}
