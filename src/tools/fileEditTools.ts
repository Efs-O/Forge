import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspacePath } from '../util/WorkspacePaths';

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
          'Move or rename a file or a directory (a directory moves with all its contents). ' +
          'Destination parent directories are created automatically.',
        parameters: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: 'Source file or directory path (absolute or workspace-relative).',
            },
            destination: {
              type: 'string',
              description: 'Destination file or directory path (absolute or workspace-relative).',
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
          'Delete a file or directory. By default the target is moved to the OS recycle bin / ' +
          'trash so it can be restored; set to_trash=false to delete it permanently. ' +
          'Set recursive=true to delete a non-empty directory.',
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
            to_trash: {
              type: 'boolean',
              description:
                'If true (default), move to the recycle bin instead of deleting permanently. ' +
                'Set false for permanent deletion, or when the target lives on a filesystem ' +
                'with no recycle bin (network shares, most remote/WSL paths).',
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
      const recursive = args['recursive'] === true;
      if (args['to_trash'] === false) {
        fs.rmSync(resolved, { recursive });
        return `Permanently deleted: ${filePath}`;
      }
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(resolved), {
          recursive,
          useTrash: true,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Could not move ${filePath} to the recycle bin: ${reason}. ` +
            'Filesystems such as network shares have no recycle bin — ' +
            'call delete_file again with to_trash: false to delete it permanently.',
        );
      }
      return `Moved to recycle bin: ${filePath}`;
    },
  };
}

// ── format_file ────────────────────────────────────────────────────────────────

/**
 * Formatting options for a document we deliberately do not open in an editor.
 *
 * A visible editor already carries VS Code's *resolved* options (including the
 * result of `editor.detectIndentation`), so we reuse them when one happens to
 * exist — without activating it. Otherwise we read the document- and
 * language-scoped configuration. `detectIndentation` cannot be honoured without
 * an editor, so the configured values are used as-is; that is stated here
 * rather than hidden behind hardcoded defaults.
 */
export function resolveFormattingOptions(doc: vscode.TextDocument): vscode.FormattingOptions {
  const visible = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.fsPath === doc.uri.fsPath,
  );
  if (visible) {
    const { tabSize, insertSpaces } = visible.options;
    if (typeof tabSize === 'number' && typeof insertSpaces === 'boolean') {
      return { tabSize, insertSpaces };
    }
  }

  const cfg = vscode.workspace.getConfiguration('editor', {
    uri: doc.uri,
    languageId: doc.languageId,
  });
  const configuredTabSize = cfg.get('tabSize');
  const configuredInsertSpaces = cfg.get('insertSpaces');
  return {
    // `editor.tabSize` is declared as a number but users can leave a string in
    // settings.json; a bad value must not silently become NaN downstream.
    tabSize:
      typeof configuredTabSize === 'number' && Number.isInteger(configuredTabSize)
        ? configuredTabSize
        : 4,
    insertSpaces: typeof configuredInsertSpaces === 'boolean' ? configuredInsertSpaces : true,
  };
}

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
    handler: async (args, context) => {
      const filePath = args['path'] as string;
      const uri = vscode.Uri.file(resolveWorkspacePath(filePath));
      // Load the document only. Never show, activate or close an editor: a tool
      // call must not move the user's focus, and the close command acted on
      // whatever was active by the time it ran, not necessarily on this file.
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty) {
        throw new Error(
          `format_file: ${filePath} has unsaved editor changes; refusing to save unrelated user edits`,
        );
      }

      const versionBeforeFormat = doc.version;
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
        'vscode.executeFormatDocumentProvider',
        uri,
        resolveFormattingOptions(doc),
      );

      if (!edits) {
        // Undefined covers both "no formatter registered" and a provider that
        // returned nothing. We cannot tell them apart, so we do not claim the
        // file was already formatted.
        return `No formatting edits returned; a formatter may not be available: ${filePath}`;
      }
      if (context?.abortSignal?.aborted) {
        throw new Error('format_file: cancelled before edits were applied');
      }
      if (doc.version !== versionBeforeFormat) {
        // The document changed while the provider ran, so the returned ranges
        // may no longer address the text they were computed against.
        throw new Error(`format_file: ${filePath} changed while formatting; no edits were applied`);
      }
      if (edits.length === 0) return `No changes: the formatter returned no edits: ${filePath}`;

      const workspaceEdit = new vscode.WorkspaceEdit();
      workspaceEdit.set(uri, edits);
      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      if (!applied) throw new Error(`format_file: workspace edit was rejected for ${filePath}`);

      const saved = await doc.save();
      if (!saved) {
        // The buffer holds the formatted text and the checkpoint already covers
        // this path, so the change is recoverable — but it is not on disk.
        throw new Error(
          `format_file: formatted ${filePath} but the file could not be saved; ` +
            'the change is present in the editor buffer only',
        );
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
