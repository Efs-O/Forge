import * as fs from 'fs';
import type { RegisteredTool } from './ToolRegistry';
import { defaultWorkspaceRoot, resolveRealWorkspacePath } from '../util/WorkspacePaths';
import {
  applyEol,
  describeEditMiss,
  dominantEol,
  findAllEditMatches,
  findIndentShiftedMatch,
  type EditMatch,
} from './editMatch';
import {
  agentWriteOptions,
  delayedWriteNote,
  writeFileAtomic,
  type ExpectedFileState,
} from '../util/atomicWrite';
import { withFileLengthWarning, type FileLengthWarningGetter } from './fileLengthWarning';
import { NO_PROBLEM_WATCHER, withProblemNote, type ProblemWatcher } from './editDiagnostics';

// ── edit_file ──────────────────────────────────────────────────────────────────

/** Upper bound on edits in one `edit_file` call. */
export const MAX_EDITS_PER_CALL = 200;

interface StringEdit {
  oldStr: string;
  newStr: string;
  /** Replace every occurrence instead of only the first (item 1.2, 2026-10-29). */
  replaceAll: boolean;
}

/**
 * Reads the one-or-many edit forms into a single list.
 *
 * `edits` exists because one edit per call is one *round* per edit, and a round
 * is the scarcest thing an agent turn has. Measured across recent sessions:
 * 616 `edit_file` calls at an average of 1.62 tool calls per round, against a
 * 40-round budget — a refactor spent its whole turn landing edits one at a
 * time. The sibling `apply_line_edits` already batched, but asks for line
 * numbers and verbatim `expected_lines`, and failed 14 of the 19 times it was
 * tried. Exact `old_str` matching is what these models actually do well, so
 * that is what got the batch form.
 */
function parseEdits(args: Record<string, unknown>): StringEdit[] {
  const raw = args['edits'];
  if (raw === undefined) {
    const oldStr = args['old_str'];
    const newStr = args['new_str'];
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
      throw new Error('edit_file: provide either edits[], or both old_str and new_str.');
    }
    return [{ oldStr, newStr, replaceAll: replaceAllOf(args['replace_all'], '') }];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('edit_file: edits must be a non-empty array.');
  }
  if (raw.length > MAX_EDITS_PER_CALL) {
    throw new Error(`edit_file: at most ${MAX_EDITS_PER_CALL} edits per call.`);
  }
  return raw.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    const oldStr = record?.['old_str'];
    const newStr = record?.['new_str'];
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
      // Name what arrived: a model that sent `newStr`, or both shapes at once
      // (a placeholder edits[] plus the real top-level pair, seen 2026-11-05),
      // cannot tell from "needs old_str" which key it got wrong.
      const fields =
        record !== null && typeof record === 'object' ? Object.keys(record).join(', ') : '';
      const mixed =
        args['old_str'] !== undefined || args['new_str'] !== undefined
          ? ' Top-level old_str/new_str were sent too: use edits[] or the top-level pair, not both.'
          : '';
      throw new Error(
        `edit_file: edit ${index + 1} needs string old_str and new_str (it has: ${fields || 'no fields'}).${mixed}`,
      );
    }
    return {
      oldStr,
      newStr,
      replaceAll: replaceAllOf(record['replace_all'], `edit ${index + 1} `),
    };
  });
}

/**
 * `replace_all` as one edit sent it.
 *
 * `ToolRegistry.invalidArgs` type-checks the fields it can see — the top-level
 * properties — and nothing inside an `edits[]` item, so a string "true" here
 * would otherwise reach the splice and read as false: the model would ask for
 * all three copies, get one, and see a result that said the edit worked.
 */
function replaceAllOf(value: unknown, where: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throw new Error(
      `edit_file: ${where}replace_all must be true or false, not ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

export function makeEditFileTool(
  extraRoots: () => readonly string[] = () => [],
  lengthWarning: FileLengthWarningGetter = () => undefined,
  watchProblems: ProblemWatcher = NO_PROBLEM_WATCHER,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Replace the FIRST occurrence of old_str with new_str in a file. old_str must be an ' +
          'exact match including whitespace (a block that differs only by one uniform indentation ' +
          'shift is found and new_str is shifted to match; the result says so). replace_all: true ' +
          'replaces EVERY occurrence and names the count; when only the first was replaced the ' +
          'result says how many copies of old_str are still in the file. Pass `edits` to ' +
          'apply several replacements to the same file in ONE call — strongly preferred over one ' +
          'call per edit. Edits apply in order; an edit whose old_str is not found is skipped and ' +
          'reported while the others are written, so resend only the missed ones.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path (absolute or workspace-relative).',
            },
            old_str: {
              type: 'string',
              description: 'Exact string to find (whitespace-sensitive). Single-edit form.',
            },
            new_str: {
              type: 'string',
              description: 'Replacement string. Single-edit form.',
            },
            replace_all: {
              type: 'boolean',
              description:
                'Replace every occurrence of old_str, not only the first (default false). The ' +
                'result says how many it replaced. Applies to one item of edits[] when put there.',
            },
            edits: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_EDITS_PER_CALL,
              description:
                'Up to 200 replacements applied in order to this one file. Each later old_str is ' +
                'matched against the result of the earlier edits.',
              items: {
                type: 'object',
                properties: {
                  old_str: { type: 'string' },
                  new_str: { type: 'string' },
                  replace_all: { type: 'boolean' },
                },
                required: ['old_str', 'new_str'],
                additionalProperties: false,
              },
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string], showDiff: true },
    handler: async (args, context) => {
      const workspaceRoot = defaultWorkspaceRoot();
      const requestedPath = args['path'] as string;
      const filepath = await resolveRealWorkspacePath(requestedPath, workspaceRoot, {
        allowMissing: true,
        extraRoots: extraRoots(),
      });
      const edits = parseEdits(args);

      let content: string;
      let fileState: ExpectedFileState;
      try {
        fileState = (() => {
          const stat = fs.statSync(filepath);
          return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
        })();
        content = fs.readFileSync(filepath, 'utf8');
        const afterRead = fs.statSync(filepath);
        if (
          afterRead.size !== fileState.size ||
          afterRead.mtimeMs !== fileState.mtimeMs ||
          afterRead.ctimeMs !== fileState.ctimeMs
        ) {
          throw new Error('file changed while it was being read; re-read and retry');
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `edit_file: no file at ${filepath} (the path "${requestedPath}" resolved against the workspace root ${workspaceRoot}). edit_file changes an existing file only: to create it, use write_file; to look for it, use find_files.`,
          );
        }
        throw new Error(`edit_file: cannot read file — ${(err as Error).message}`);
      }

      // Applied to a buffer and written once. A missed edit is skipped, not
      // fatal: all-or-nothing made the model regenerate every matched edit for
      // one bad anchor (253 resent edits over 66 misses in 3 days, 2026-10-09).
      // Edits apply in order, so one that needs a skipped edit's text misses
      // too and is reported. Inserted text takes the file's own line ending, so
      // an edit never leaves a CRLF file with stray LF lines.
      const eol = dominantEol(content);
      let updated = content;
      const applied: number[] = [];
      const misses: { number: number; diagnosis: string }[] = [];
      const shifted: string[] = [];
      const joins: string[] = [];
      const repeats: { number: number; count: number }[] = [];
      const leftCopies: { number: number; left: number; total: number; insideNew: number }[] = [];
      let singleReplaced = 1;
      for (const [index, edit] of edits.entries()) {
        const before = updated;
        const which = edits.length === 1 ? '' : `edit ${index + 1}: `;
        // One scan answers both "where is it" and "how many copies are there",
        // so the replace_all decision and the warning about the copies this
        // call did not replace come from the same look.
        const copies = findAllEditMatches(before, edit.oldStr);
        const shiftedMatch =
          copies.length === 0
            ? findIndentShiftedMatch(before, edit.oldStr, edit.newStr)
            : undefined;
        const found: EditMatch[] = copies.length ? copies : shiftedMatch ? [shiftedMatch] : [];
        if (found.length === 0) {
          misses.push({ number: index + 1, diagnosis: describeEditMiss(before, edit.oldStr) });
          continue;
        }
        if (shiftedMatch) {
          shifted.push(
            `${which}indentation adjusted by ${shiftedMatch.shift > 0 ? '+' : ''}${shiftedMatch.shift} at line ${shiftedMatch.line}`,
          );
        }
        // Default false keeps what this tool has always done: the first
        // occurrence, and the result saying so. `replace_all` takes every
        // non-overlapping copy in ascending order.
        const chosen = edit.replaceAll ? found : found.slice(0, 1);
        applied.push(index + 1);
        const inserted = applyEol(shiftedMatch ? shiftedMatch.newStr : edit.newStr, eol);
        // One pass builds the result and every seam's line number. Each match
        // used to splice a copy of the whole file, and each seam counted its
        // line from the start of the file again, so a replace_all over 20,000
        // copies cost 20,000 scans of the file instead of one. The join check
        // still reads the finished text: jelly-press joined two statements by
        // dropping a line break and found it 45 minutes later (2026-10-09),
        // and a replace_all that did it to three copies had to name all three.
        const seams: ReplaceSeam[] = [];
        const pieces: string[] = [];
        let cursor = 0;
        let built = 0; // length of the text emitted so far, in the finished string
        let newlines = 0; // '\n' in that same prefix
        for (const [seen, match] of chosen.entries()) {
          if (seen !== 0 && seen % ABORT_CHECK_MATCHES === 0 && context?.abortSignal?.aborted) {
            throw new Error(
              'edit_file: cancelled during a long replace_all, before anything was written.',
            );
          }
          const piece = before.slice(cursor, match.index);
          const pieceNewlines = countNewlines(piece);
          const lineStart = newlines + pieceNewlines + 1;
          const start = built + piece.length;
          pieces.push(piece, inserted);
          built = start + inserted.length;
          newlines += pieceNewlines + countNewlines(inserted);
          seams.push({ match, start, end: built, lineStart, lineEnd: newlines + 1 });
          cursor = match.index + match.length;
        }
        pieces.push(before.slice(cursor));
        updated = pieces.join('');
        for (const seam of seams) {
          const replaced = before.slice(seam.match.index, seam.match.index + seam.match.length);
          const joinedLine = lineJoinedBy(
            updated,
            seam.start,
            seam.end,
            replaced,
            seam.lineStart,
            seam.lineEnd,
          );
          if (joinedLine !== undefined) joins.push(`${which}line ${joinedLine}`);
        }
        if (chosen.length > 1) repeats.push({ number: index + 1, count: chosen.length });
        if (chosen.length < found.length) {
          // Count what the file still holds from the text this edit just built,
          // not from the copies it did not take: new_str can contain old_str,
          // and those copies were invisible to the old count, so the result
          // under-reported what was left and the next round built its anchor
          // from a file that did not match what it thought it had written.
          const stillInFile = findAllEditMatches(updated, edit.oldStr).length;
          leftCopies.push({
            number: index + 1,
            left: stillInFile,
            total: found.length,
            insideNew: stillInFile - (found.length - chosen.length),
          });
        }
        if (edits.length === 1) singleReplaced = chosen.length;
      }
      if (applied.length === 0) {
        const which = edits.length === 1 ? '' : ` (all ${edits.length} edits)`;
        throw new Error(
          `edit_file: old_str not found in file${which} — the text must match exactly, ` +
            'apart from line endings, which are ignored. The file may have changed since you read ' +
            'it. No changes were written.' +
            describeMisses(misses, edits.length),
        );
      }
      // Snapshot before the write, so "what is new" can only mean "what this
      // edit introduced"; the wait happens after it, once, with the call's
      // abortSignal so a Stop returns the result at once. Awaiting it here also
      // loads the document into the language service BEFORE the bytes change,
      // which is what turns "nothing reported on this file" into a real answer.
      const watch = await watchProblems(filepath);
      let contentionNote = '';
      await writeFileAtomic(
        filepath,
        updated,
        agentWriteOptions(context?.abortSignal, { expected: fileState }, (report) => {
          contentionNote = delayedWriteNote(report);
        }),
      );
      const suppliedPath = args['path'] as string;
      const adjusted = shifted.length > 0 ? ` (${shifted.join('; ')})` : '';
      /**
       * What `replace_all` did, and what it did not.
       *
       * The count is cheap. The warning is the point: a file that still holds
       * two copies of the text the model just replaced reads as a completed
       * edit, and the next round builds its anchor from a file that no longer
       * matches what the model thinks it wrote.
       */
      const multi =
        repeats.length > 0 && edits.length > 1
          ? `\n${repeats
              .map((repeat) => `edit ${repeat.number}: ${repeat.count} occurrences replaced`)
              .join('\n')}.`
          : '';
      const copiesNote =
        leftCopies.length > 0
          ? `\n${leftCopies
              .slice(0, DIAGNOSED_MISSES)
              .map((copy) => {
                const plural = copy.left !== 1;
                // Says so when the copies left are not simply the ones this
                // edit skipped: some of them sit inside the text just written.
                const inside = copy.insideNew ? `, ${copy.insideNew} inside the new text` : '';
                return edits.length === 1
                  ? `${copy.left} more ${plural ? 'copies' : 'copy'} of old_str ` +
                      `${plural ? 'are' : 'is'} still in the file (only the first of ` +
                      `${copy.total} was replaced${inside}). Use replace_all: true to replace every one.`
                  : `edit ${copy.number}: ${copy.left} ${plural ? 'copies' : 'copy'} of ` +
                      `old_str left in the file (only the first of ${copy.total} replaced${inside}; ` +
                      'use replace_all: true).';
              })
              .join('\n')}${
              leftCopies.length > DIAGNOSED_MISSES
                ? `\nEdit(s) ${leftCopies
                    .slice(DIAGNOSED_MISSES)
                    .map((copy) => copy.number)
                    .join(', ')} also left copies.`
                : ''
            }`
          : '';
      const joined =
        joins.length > 0
          ? `\nWarning: the replacement removed a line break, so two lines are now one (${joins.join('; ')}). ` +
            'If that was not intended, re-read that line and put the line break back.'
          : '';
      const text =
        misses.length === 0
          ? edits.length === 1
            ? `${
                singleReplaced > 1 ? `Replaced ${singleReplaced} occurrences in` : 'Replaced in'
              } ${suppliedPath}${adjusted}${multi}${copiesNote}${joined}`
            : `Applied ${edits.length} edits to ${suppliedPath}${adjusted}${multi}${copiesNote}${joined}`
          : `Partly applied: edit(s) ${applied.join(', ')} of ${edits.length} written to ${suppliedPath}` +
            `${adjusted}${multi}. Edit(s) ${misses.map((m) => m.number).join(', ')} not found — the applied edits ` +
            'are already in the file, so resend ONLY the missed edit(s), corrected.' +
            describeMisses(misses, edits.length) +
            copiesNote +
            joined;
      // A partly-applied call still grew the file, so the line count is said
      // for it too: the agent needs to know before its next edit, not after.
      const note = watch ? await watch.settle(context?.abortSignal) : '';
      return withFileLengthWarning(
        withProblemNote(text + (contentionNote ? `\n${contentionNote}` : ''), note),
        filepath,
        lengthWarning(),
      );
    },
  };
}

/**
 * Where one replacement sits in the text being built: its offsets in the
 * finished string and the 1-based lines on each side of it, both counted in
 * the same pass that built the text, so a replace_all can name its seams
 * without re-scanning the file for each one.
 */
interface ReplaceSeam {
  match: EditMatch;
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
}

/** Matches between cancellable checks: 2,000 replacements is well under a second. */
const ABORT_CHECK_MATCHES = 2_000;

/** '\n' in a piece, so line numbers come from one pass over the file. */
function countNewlines(text: string): number {
  let count = 0;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) count++;
  return count;
}

/**
 * The 1-based line where an edit merged two lines, or undefined. That happens
 * when the replaced text began or ended with a line break that the replacement
 * dropped, and text sits on both sides of the seam: jelly-press joined two
 * statements this way and found it 45 minutes later (2026-10-09). Deleting
 * whole lines is not a join — the seam then still ends at a line break.
 */
function lineJoinedBy(
  updated: string,
  start: number,
  end: number,
  replaced: string,
  lineAtStart: number,
  lineAtEnd: number,
): number | undefined {
  const isBreak = (char: string | undefined): boolean => char === '\n' || char === '\r';
  if (replaced.endsWith('\n') && end > 0 && end < updated.length) {
    if (!isBreak(updated[end - 1]) && !isBreak(updated[end])) return lineAtEnd;
  }
  if (/^\r?\n/.test(replaced) && start > 0 && start < updated.length) {
    if (!isBreak(updated[start - 1]) && !isBreak(updated[start])) return lineAtStart;
  }
  return undefined;
}

/** Full diagnoses for the first misses; numbers only past that, to bound the result. */
const DIAGNOSED_MISSES = 3;

function describeMisses(misses: { number: number; diagnosis: string }[], total: number): string {
  if (total === 1) return misses[0]?.diagnosis ?? '';
  const detailed = misses
    .slice(0, DIAGNOSED_MISSES)
    .map((miss) => `\nEdit ${miss.number}:${miss.diagnosis}`)
    .join('');
  const rest = misses.slice(DIAGNOSED_MISSES).map((miss) => miss.number);
  return rest.length > 0
    ? `${detailed}\nEdit(s) ${rest.join(', ')} also missed; re-read their regions before resending.`
    : detailed;
}
