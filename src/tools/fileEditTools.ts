import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveRealWorkspacePath, resolveWorkspacePath } from '../util/WorkspacePaths';
import { commonFolderOf } from '../sidebar/approvalKeyGrammar';
import { diagnoseTrashRefusal, forgetTrashRefusal, rememberTrashRefusal } from './trashRefusal';
import { applyAndSaveWorkspaceEdit } from './workspaceEditApply';
import { noSymbolMessage } from './lspFormat';
import { describePosition, primeSymbolAtPosition, remainingSymbolFiles } from './symbolSearch';

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

// ── move_file ──────────────────────────────────────────────────────────────────

/** `extraRoots` (here and in every file-writing tool) is config.yaml `extra_file_roots`:
 *  folders outside the workspace the tool may also change. Every writer must take
 *  it: write_file once ignored it and refused a configured folder. */
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
    /**
     * The key for a permanent delete, from the gate that knows the targets.
     *
     * `isDangerousDelete` is `to_trash: false` — a permanent delete of paths the call
     * names, not a recursive one specifically — so a recycle-bin move gets nothing
     * here (it is recoverable and stays card-free as before) and a permanent delete
     * gets `rdelete:` with the folder its targets sit in, which is the folder the
     * card shows. One judgement call worth stating: a permanent delete of a single
     * FILE is keyed the same way, so a chat allowed `rdelete:D:/Downloads` also lets
     * future permanent deletes of other files in `D:/Downloads` through. That follows
     * the plan's rule that the key is the target's parent and the owner may only pick
     * narrower, and it is why `approvalKeysFor` re-checks every target against the
     * folder the key names before trusting it.
     *
     * A path this tool cannot resolve gets no key at all, and the call asks.
     */
    approval: (args) => {
      if (args['to_trash'] !== false) return undefined;
      const requested = Array.isArray(args['paths'])
        ? (args['paths'] as unknown[])
        : [args['path']];
      const targets: string[] = [];
      for (const value of requested) {
        if (typeof value !== 'string' || value.trim().length === 0) return { dangerous: true };
        try {
          targets.push(resolveWorkspacePath(value));
        } catch {
          return { dangerous: true };
        }
      }
      if (targets.length === 0) return { dangerous: true };
      const folder = commonFolderOf(targets, {
        platform: process.platform,
        home: os.homedir(),
        workspaceRoot: undefined,
        ownerOnly: [],
        extraFileRoots: [],
      });
      return {
        dangerous: true,
        ...(folder ? { approvalKey: `rdelete:${folder}`, approvalTargets: targets } : {}),
      };
    },
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
            line: {
              type: 'integer',
              description: 'Zero-based line number (the first line of the file is 0).',
            },
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
      const line = args['line'] as number;
      const character = args['character'] as number;
      const position = new vscode.Position(line, character);
      const description = await describePosition(uri, position, filePath);
      if (!description.word) {
        throw new Error(`rename_symbol: ${noSymbolMessage(description, position)}`);
      }
      const primed = await primeSymbolAtPosition(uri, position);

      let edit: vscode.WorkspaceEdit | undefined;
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
          'vscode.executeDocumentRenameProvider',
          document.uri,
          position,
          newName,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `rename_symbol failed at ${filePath}:${line}:${character} (zero-based): VS Code said "${message}". ` +
            "Check the position is on the symbol's name (code_intel definition at the same position should find it).",
        );
      }

      if (!edit) throw new Error('rename_symbol: no rename provider available for this file type');
      await applyAndSaveWorkspaceEdit('rename_symbol', edit, extraRoots(), context);
      const remaining = primed.name ? await remainingSymbolFiles(primed.name) : [];
      const files = remaining
        .map((file) => vscode.workspace.asRelativePath(vscode.Uri.file(file)).replace(/\\/gu, '/'))
        .sort();
      const note = files.length
        ? `\n\nNote: a text search still finds \`${primed.name}\` in ${files.length} file(s) after the rename: ${files.join(', ')}. Check them with search_code; they may be comments or strings, or files the language server had not loaded.`
        : '';
      return `Renamed to ${newName}${note}`;
    },
  };
}
