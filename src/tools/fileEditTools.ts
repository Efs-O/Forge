import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import { diagnoseTrashRefusal, forgetTrashRefusal, rememberTrashRefusal } from './trashRefusal';
import { applyAndSaveWorkspaceEdit } from './workspaceEditApply';

/** Join a result line to its optional follow-up sentence. */
function withWarning(result: string, warning: string): string {
  return warning ? `${result}\n${warning}` : result;
}

/**
 * Ask git about a path that is about to be deleted, without dragging the git
 * discovery stack into this module's load.
 *
 * `gitDiscovery` instantiates the extension logger at import time, which needs
 * a live `vscode.window`. Importing it statically here made every consumer of
 * these pure-filesystem tools depend on that, breaking tests that stub only
 * what they use. The import happens on the delete path or not at all.
 */
async function trackedWarningFor(filePath: string): Promise<string> {
  try {
    const { describeDeletedTrackedFile, describeTrackedState } = await import('./gitTrackedStatus');
    return describeDeletedTrackedFile(await describeTrackedState(filePath), filePath);
  } catch {
    // Advisory only: a deletion the caller asked for must not fail because git
    // could not be consulted.
    return '';
  }
}

// ── create_directory ───────────────────────────────────────────────────────────

/** `extraRoots` (here and in every file-writing tool) is config.yaml `extra_file_roots`:
 *  folders outside the workspace the tool may also change. Every writer must take
 *  it: write_file once ignored it and refused a configured folder. */
export function makeCreateDirectoryTool(
  extraRoots: () => readonly string[] = () => [],
): RegisteredTool {
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
              description:
                'Directory path (absolute or workspace-relative). Outside the workspace only ' +
                'inside a folder listed under extra_file_roots in config.yaml.',
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
      const resolvedPath = await resolveRealWorkspacePath(dirPath, undefined, {
        allowMissing: true,
        extraRoots: extraRoots(),
      });
      fs.mkdirSync(resolvedPath, { recursive: true });
      return `Created: ${dirPath}`;
    },
  };
}

// ── move_file ──────────────────────────────────────────────────────────────────

export function makeMoveFileTool(extraRoots: () => readonly string[] = () => []): RegisteredTool {
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
      const src = await resolveRealWorkspacePath(args['source'] as string, undefined, {
        allowMissing: true,
        extraRoots: extraRoots(),
      });
      const dst = await resolveRealWorkspacePath(args['destination'] as string, undefined, {
        allowMissing: true,
        extraRoots: extraRoots(),
      });
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return `Moved to ${args['destination'] as string}`;
    },
  };
}

// ── delete_file ────────────────────────────────────────────────────────────────

export function makeDeleteFileTool(extraRoots: () => readonly string[] = () => []): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'delete_file',
        description:
          'Delete exactly one path or provide paths to delete 1–50 files or directories. Each ' +
          'path must be in the workspace or inside extra_file_roots. By default targets are ' +
          'moved to the OS recycle bin / trash so they can be restored; set to_trash=false to ' +
          'delete them permanently. Only to_trash: false is a dangerous delete. Set recursive=true ' +
          'to delete non-empty directories.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Path to delete (absolute or workspace-relative). Outside the workspace only ' +
                'inside a folder listed under extra_file_roots in config.yaml.',
            },
            paths: {
              type: 'array',
              items: { type: 'string' },
              minItems: 1,
              maxItems: 50,
              description:
                '1–50 paths to delete (absolute or workspace-relative). Each path must be ' +
                'inside the workspace or a folder listed under extra_file_roots in config.yaml. ' +
                'Provide exactly one of path or paths.',
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
          // Exactly one of path/paths, checked in the handler: a top-level
          // oneOf is a shape grammar converters and strict schemas handle badly.
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'delete',
    mutation: {
      paths: (args) =>
        Array.isArray(args['paths']) ? (args['paths'] as string[]) : [args['path'] as string],
      showDiff: true,
    },
    handler: async (args) => {
      const hasPath = typeof args['path'] === 'string';
      const hasPaths = Array.isArray(args['paths']);
      if (hasPath === hasPaths) {
        throw new Error('delete_file requires exactly one of "path" or "paths".');
      }
      const filePaths = hasPaths ? (args['paths'] as string[]) : [args['path'] as string];
      if (
        filePaths.length < 1 ||
        filePaths.length > 50 ||
        filePaths.some((item) => typeof item !== 'string')
      ) {
        throw new Error('delete_file "paths" must contain 1–50 strings.');
      }
      const recursive = args['recursive'] === true;
      const results: string[] = [];
      let deleted = 0;
      for (const filePath of filePaths) {
        try {
          const resolved = await resolveRealWorkspacePath(filePath, undefined, {
            allowMissing: true,
            extraRoots: extraRoots(),
          });
          if (!fs.existsSync(resolved)) {
            results.push(`Missing: ${filePath}`);
            continue;
          }
          // Asked before the delete: afterwards the path is gone from the
          // working tree and `ls-files` cannot distinguish absent from deleted.
          const warning = await trackedWarningFor(filePath);

          if (args['to_trash'] === false) {
            fs.rmSync(resolved, { recursive });
            forgetTrashRefusal(resolved);
            results.push(withWarning(`Permanently deleted: ${filePath}`, warning));
            deleted++;
            continue;
          }
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(resolved), {
              recursive,
              useTrash: true,
            });
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            const diagnosis = await diagnoseTrashRefusal(resolved);
            rememberTrashRefusal(resolved, diagnosis);
            throw new Error(
              `could not move it to the recycle bin: ${reason}. ${diagnosis} ` +
                'Call delete_file again with to_trash: false to delete it permanently.',
            );
          }
          forgetTrashRefusal(resolved);
          results.push(withWarning(`Moved to recycle bin: ${filePath}`, warning));
          deleted++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          results.push(`Failed: ${filePath}: ${reason}`);
        }
      }
      // Nothing deleted is a failed call, so the failure tracker and the model
      // both see it as one; a partial batch reports each path's outcome.
      if (deleted === 0) throw new Error(results.join('\n'));
      return results.join('\n');
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

export function makeFormatFileTool(extraRoots: () => readonly string[] = () => []): RegisteredTool {
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
      const uri = vscode.Uri.file(
        await resolveRealWorkspacePath(filePath, undefined, {
          allowMissing: true,
          extraRoots: extraRoots(),
        }),
      );
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
      const versionBeforeApply = doc.version;
      const applied = await vscode.workspace.applyEdit(workspaceEdit);
      if (!applied) throw new Error(`format_file: workspace edit was rejected for ${filePath}`);
      // applyEdit commits the formatter's ranges as a single transaction, bumping
      // the version by exactly one. A user keystroke that lands while the async
      // apply is in flight bumps it again; saving that would persist an edit the
      // formatter never computed against. Refuse rather than save a document we
      // did not fully author.
      if (doc.version !== versionBeforeApply + 1) {
        throw new Error(`format_file: ${filePath} changed while the edit was applied; not saved`);
      }

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

export function makeRenameSymbolTool(
  extraRoots: () => readonly string[] = () => [],
): RegisteredTool {
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
      const uri = vscode.Uri.file(
        await resolveRealWorkspacePath(filePath, undefined, {
          allowMissing: true,
          extraRoots: extraRoots(),
        }),
      );
      const position = new vscode.Position(args['line'] as number, args['character'] as number);

      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider',
        uri,
        position,
        newName,
      );

      if (!edit) throw new Error('rename_symbol: no rename provider available for this file type');
      await applyAndSaveWorkspaceEdit('rename_symbol', edit, extraRoots(), context);
      return `Renamed to ${newName}`;
    },
  };
}
