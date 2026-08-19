import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspacePath } from '../util/WorkspacePaths';

// ── Helpers ────────────────────────────────────────────────────────────────────

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
      let updated = content;
      for (const [index, edit] of edits.entries()) {
        const idx = updated.indexOf(edit.oldStr);
        if (idx === -1) {
          const which = edits.length === 1 ? '' : ` (edit ${index + 1} of ${edits.length})`;
          throw new Error(
            `edit_file: old_str not found in file${which} — exact match required, ` +
              'including whitespace and indentation. No changes were written.',
          );
        }
        updated = updated.slice(0, idx) + edit.newStr + updated.slice(idx + edit.oldStr.length);
      }
      fs.writeFileSync(filepath, updated, 'utf8');
      const suppliedPath = args['filepath'] as string;
      return edits.length === 1
        ? `Replaced in ${suppliedPath}`
        : `Replaced ${edits.length} occurrences in ${suppliedPath}`;
    },
  };
}

// ── create_directory ───────────────────────────────────────────────────────────

export function makeCreateDirectoryTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'create_directory',
        description: 'Create a directory (including any missing parent directories).',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path (absolute or workspace-relative).',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string] },
    handler: async (args) => {
      const dirPath = args['path'] as string;
      const resolvedPath = resolveWorkspacePath(dirPath);
      fs.mkdirSync(resolvedPath, { recursive: true });
      return `Created: ${dirPath}`;
    },
  };
}

// ── move_file ──────────────────────────────────────────────────────────────────

export function makeMoveFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'move_file',
        description:
          'Move or rename a file. Destination parent directories are created automatically.',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Source file path (absolute or workspace-relative).',
            },
            destination: {
              type: 'string',
              description: 'Destination file path (absolute or workspace-relative).',
            },
          },
          required: ['source', 'destination'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: {
      paths: (args) => [args['source'] as string, args['destination'] as string],
      showDiff: true,
    },
    handler: async (args) => {
      const src = resolveWorkspacePath(args['source'] as string);
      const dst = resolveWorkspacePath(args['destination'] as string);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return `Moved to ${args['destination'] as string}`;
    },
  };
}

// ── delete_file ────────────────────────────────────────────────────────────────

export function makeDeleteFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'delete_file',
        description:
          'Delete a file or directory. Set recursive=true to delete a non-empty directory.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to delete (absolute or workspace-relative).',
            },
            recursive: {
              type: 'boolean',
              description: 'If true, delete directory and all its contents. Default false.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'delete',
    mutation: { paths: (args) => [args['path'] as string], showDiff: true },
    handler: async (args) => {
      const filePath = args['path'] as string;
      const resolved = resolveWorkspacePath(filePath);
      fs.rmSync(resolved, { recursive: args['recursive'] === true });
      return `Deleted: ${filePath}`;
    },
  };
}

// ── format_file ────────────────────────────────────────────────────────────────

export function makeFormatFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'format_file',
        description:
          'Format a file using the VS Code document formatter (e.g. Prettier, ESLint fix, etc.).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string], showDiff: true },
    handler: async (args) => {
      const filePath = args['path'] as string;
      const uri = vscode.Uri.file(resolveWorkspacePath(filePath));
      const alreadyOpen = vscode.window.visibleTextEditors.some(
        (e) => e.document.uri.fsPath === uri.fsPath,
      );
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('editor.action.formatDocument');
      await doc.save();
      if (!alreadyOpen) {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      return `Formatted: ${filePath}`;
    },
  };
}

// ── rename_symbol ──────────────────────────────────────────────────────────────

export function makeRenameSymbolTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'rename_symbol',
        description:
          'Rename a symbol at the given position using the language server rename provider.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            line: { type: 'integer', description: 'Zero-based line number of the symbol.' },
            character: {
              type: 'integer',
              description: 'Zero-based character offset of the symbol.',
            },
            new_name: { type: 'string', description: 'New name for the symbol.' },
          },
          required: ['path', 'line', 'character', 'new_name'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string], showDiff: true },
    handler: async (args, context) => {
      const filePath = args['path'] as string;
      const newName = args['new_name'] as string;
      const uri = vscode.Uri.file(resolveWorkspacePath(filePath));
      const position = new vscode.Position(args['line'] as number, args['character'] as number);

      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider',
        uri,
        position,
        newName,
      );

      if (!edit) throw new Error('rename_symbol: no rename provider available for this file type');
      context?.beforeMutate(edit.entries().map(([target]) => target.fsPath));
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) throw new Error('rename_symbol: workspace edit was rejected');
      return `Renamed to ${newName}`;
    },
  };
}
