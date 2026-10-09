import * as fs from 'fs';
import type { RegisteredTool } from './ToolRegistry';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import {
  applyEol,
  describeEditMiss,
  dominantEol,
  findEditMatch,
  findIndentShiftedMatch,
} from './editMatch';
import { writeFileAtomicSync, type ExpectedFileState } from '../util/atomicWrite';

// ── edit_file ──────────────────────────────────────────────────────────────────

/** Upper bound on edits in one `edit_file` call. */
export const MAX_EDITS_PER_CALL = 200;

interface StringEdit {
  oldStr: string;
  newStr: string;
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
    return [{ oldStr, newStr }];
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
      throw new Error(`edit_file: edit ${index + 1} needs string old_str and new_str.`);
    }
    return { oldStr, newStr };
  });
}

export function makeEditFileTool(extraRoots: () => readonly string[] = () => []): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Replace the FIRST occurrence of old_str with new_str in a file. old_str must be an ' +
          'exact match including whitespace (a block that differs only by one uniform indentation ' +
          'shift is found and new_str is shifted to match; the result says so). Pass `edits` to ' +
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
    handler: async (args) => {
      const filepath = await resolveRealWorkspacePath(args['path'] as string, undefined, {
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
      for (const [index, edit] of edits.entries()) {
        const exact = findEditMatch(updated, edit.oldStr);
        const match = exact
          ? { ...exact, newStr: edit.newStr }
          : findIndentShiftedMatch(updated, edit.oldStr, edit.newStr);
        if (!match) {
          misses.push({ number: index + 1, diagnosis: describeEditMiss(updated, edit.oldStr) });
          continue;
        }
        if ('shift' in match) {
          const which = edits.length === 1 ? '' : `edit ${index + 1}: `;
          shifted.push(
            `${which}indentation adjusted by ${match.shift > 0 ? '+' : ''}${match.shift} at line ${match.line}`,
          );
        }
        applied.push(index + 1);
        updated =
          updated.slice(0, match.index) +
          applyEol(match.newStr, eol) +
          updated.slice(match.index + match.length);
      }
      if (applied.length === 0) {
        const which = edits.length === 1 ? '' : ` (all ${edits.length} edits)`;
        throw new Error(
          `edit_file: old_str not found in file${which} — the text must match exactly, ` +
            'apart from line endings, which are ignored. No changes were written.' +
            describeMisses(misses, edits.length),
        );
      }
      writeFileAtomicSync(filepath, updated, fileState);
      const suppliedPath = args['path'] as string;
      const adjusted = shifted.length > 0 ? ` (${shifted.join('; ')})` : '';
      if (misses.length === 0) {
        return edits.length === 1
          ? `Replaced in ${suppliedPath}${adjusted}`
          : `Applied ${edits.length} edits to ${suppliedPath}${adjusted}`;
      }
      return (
        `Partly applied: edit(s) ${applied.join(', ')} of ${edits.length} written to ${suppliedPath}` +
        `${adjusted}. Edit(s) ${misses.map((m) => m.number).join(', ')} not found — the applied edits ` +
        'are already in the file, so resend ONLY the missed edit(s), corrected.' +
        describeMisses(misses, edits.length)
      );
    },
  };
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
