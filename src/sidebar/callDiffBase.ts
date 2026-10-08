import * as fs from 'fs';

/**
 * What each path held just before ONE tool call: the base that call's diff card
 * is drawn against. `null` means the file did not exist yet.
 *
 * The card used to diff against the turn checkpoint instead, so a file written
 * and then appended to twice in one turn rendered `NEW +299`, `NEW +709`,
 * `NEW +880` — three running totals that read like 1,888 added lines in a file
 * of 880, with every append badged as a new file. Keep/Undo and the editor
 * decorations still use the turn checkpoint; only the per-call card changed.
 *
 * A path that cannot be read as a file (a directory, a permission error) gets
 * no entry, and the caller draws that card against the turn checkpoint.
 */
export function readCallDiffBase(paths: readonly string[]): Map<string, string | null> {
  const base = new Map<string, string | null>();
  for (const target of paths) {
    try {
      base.set(target, fs.readFileSync(target, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') base.set(target, null);
    }
  }
  return base;
}
