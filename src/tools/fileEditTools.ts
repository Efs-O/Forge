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
