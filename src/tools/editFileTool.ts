import * as fs from 'fs';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { applyEol, describeEditMiss, dominantEol, findEditMatch } from './editMatch';

// ── edit_file ──────────────────────────────────────────────────────────────────

/** Upper bound on edits in one `edit_file` call. */
export const MAX_EDITS_PER_CALL = 40;

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

export function makeEditFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'edit_file',
        description:
          'Replace the FIRST occurrence of old_str with new_str in a file. old_str must be an ' +
          'exact match including whitespace and indentation. Pass `edits` to apply several ' +
          'replacements to the same file in ONE call — strongly preferred over one call per ' +
          'edit. Edits apply in order and all-or-nothing: if any old_str is not found, the ' +
          'file is left untouched.',
        parameters: {
          type: 'object',
          properties: {
            filepath: {
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
                'Several replacements applied in order to this one file. Each later old_str is ' +
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
          required: ['filepath'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['filepath'] as string], showDiff: true },
    handler: async (args) => {
      const filepath = resolveWorkspacePath(args['filepath'] as string);
      const edits = parseEdits(args);

      let content: string;
      try {
        content = fs.readFileSync(filepath, 'utf8');
      } catch (err) {
        throw new Error(`edit_file: cannot read file — ${(err as Error).message}`);
      }

      // Applied to a buffer and written once. A partial write would leave the
      // file in a state neither side has read, which is worse than the failure.
      // Inserted text takes the file's own line ending, so an edit never
      // leaves a CRLF file with stray LF lines the next old_str must guess at.
      const eol = dominantEol(content);
      let updated = content;
      for (const [index, edit] of edits.entries()) {
        const match = findEditMatch(updated, edit.oldStr);
        if (!match) {
          const which = edits.length === 1 ? '' : ` (edit ${index + 1} of ${edits.length})`;
          throw new Error(
            `edit_file: old_str not found in file${which} — the text must match exactly, ` +
              'apart from line endings, which are ignored. No changes were written.' +
              describeEditMiss(updated, edit.oldStr),
          );
        }
        updated =
          updated.slice(0, match.index) +
          applyEol(edit.newStr, eol) +
          updated.slice(match.index + match.length);
      }
      fs.writeFileSync(filepath, updated, 'utf8');
      const suppliedPath = args['filepath'] as string;
      return edits.length === 1
        ? `Replaced in ${suppliedPath}`
        : `Replaced ${edits.length} occurrences in ${suppliedPath}`;
    },
  };
}
