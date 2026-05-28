import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';

// ── Helpers ────────────────────────────────────────────────────────────────────

function resolveWorkspacePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) throw new Error('No workspace folder open — use an absolute path');
  return path.normalize(path.join(root, filePath));
}

// ── replace_in_file ────────────────────────────────────────────────────────────

export function makeReplaceInFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'replace_in_file',
        description:
          'Replace the FIRST occurrence of old_str with new_str in a file. old_str must be an exact match including whitespace and indentation.',
        parameters: {
          type: 'object',
          properties: {
            filepath: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            old_str:  { type: 'string', description: 'Exact string to find (whitespace-sensitive).' },
            new_str:  { type: 'string', description: 'Replacement string.' },
          },
          required: ['filepath', 'old_str', 'new_str'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    handler: async (args) => {
      const filepath = resolveWorkspacePath(args['filepath'] as string);
      const oldStr   = args['old_str'] as string;
      const newStr   = args['new_str'] as string;

      let content: string;
      try {
        content = fs.readFileSync(filepath, 'utf8');
      } catch (err) {
        throw new Error(`replace_in_file: cannot read file — ${(err as Error).message}`);
      }

      const idx = content.indexOf(oldStr);
      if (idx === -1) {
        throw new Error('replace_in_file: old_str not found in file (exact match required)');
      }

      const updated = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
      fs.writeFileSync(filepath, updated, 'utf8');
      return `Replaced in ${args['filepath'] as string}`;
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
            path: { type: 'string', description: 'Directory path (absolute or workspace-relative).' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    handler: async (args) => {
      const dirPath     = args['path'] as string;
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
        description: 'Move or rename a file. Destination parent directories are created automatically.',
        parameters: {
          type: 'object',
          properties: {
            source:      { type: 'string', description: 'Source file path (absolute or workspace-relative).' },
            destination: { type: 'string', description: 'Destination file path (absolute or workspace-relative).' },
          },
          required: ['source', 'destination'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
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
        description: 'Delete a file or directory. Set recursive=true to delete a non-empty directory.',
        parameters: {
          type: 'object',
          properties: {
            path:      { type: 'string',  description: 'Path to delete (absolute or workspace-relative).' },
            recursive: { type: 'boolean', description: 'If true, delete directory and all its contents. Default false.' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'delete',
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
        description: 'Format a file using the VS Code document formatter (e.g. Prettier, ESLint fix, etc.).',
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
    handler: async (args) => {
      const filePath    = args['path'] as string;
      const uri         = vscode.Uri.file(resolveWorkspacePath(filePath));
      const alreadyOpen = vscode.window.visibleTextEditors.some(e => e.document.uri.fsPath === uri.fsPath);
      const doc         = await vscode.workspace.openTextDocument(uri);
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
        description: 'Rename a symbol at the given position using the language server rename provider.',
        parameters: {
          type: 'object',
          properties: {
            path:      { type: 'string',  description: 'File path (absolute or workspace-relative).' },
            line:      { type: 'integer', description: 'Zero-based line number of the symbol.' },
            character: { type: 'integer', description: 'Zero-based character offset of the symbol.' },
            new_name:  { type: 'string',  description: 'New name for the symbol.' },
          },
          required: ['path', 'line', 'character', 'new_name'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    handler: async (args) => {
      const filePath = args['path'] as string;
      const newName  = args['new_name'] as string;
      const uri      = vscode.Uri.file(resolveWorkspacePath(filePath));
      const position = new vscode.Position(args['line'] as number, args['character'] as number);

      const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
        'vscode.executeDocumentRenameProvider',
        uri,
        position,
        newName,
      );

      if (!edit) throw new Error('rename_symbol: no rename provider available for this file type');
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) throw new Error('rename_symbol: workspace edit was rejected');
      return `Renamed to ${newName}`;
    },
  };
}
