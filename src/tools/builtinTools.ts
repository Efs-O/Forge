import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { CHUNKED_WRITE_ADVICE } from './writeChunking';

export function makeReadFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description:
          "Read a file's contents. Returns the whole file by default; pass start_line/end_line (1-based, inclusive) to read only a range — prefer a range for large files to save context.",
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            start_line: {
              type: 'integer',
              minimum: 1,
              description: 'Optional 1-based first line to read (inclusive).',
            },
            end_line: {
              type: 'integer',
              minimum: 1,
              description:
                'Optional 1-based last line to read (inclusive). Defaults to end of file.',
            },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const filePath = resolveWorkspacePath(args['path'] as string);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        throw new Error(`read_file: ${(err as Error).message}`);
      }

      const startLine = typeof args['start_line'] === 'number' ? args['start_line'] : undefined;
      const endLine = typeof args['end_line'] === 'number' ? args['end_line'] : undefined;
      if (startLine === undefined && endLine === undefined) return content;

      const lines = content.split('\n');
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? lines.length);
      if (start > end) {
        throw new Error(
          `read_file: start_line ${start} is past end_line ${end} (file has ${lines.length} lines).`,
        );
      }
      return lines.slice(start - 1, end).join('\n');
    },
  };
}

export function makeWriteFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          'Write content to a file, creating it (and any missing directories) if needed. ' +
          `Overwrites any existing content. ${CHUNKED_WRITE_ADVICE}`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            content: {
              type: 'string',
              description: `File content to write. ${CHUNKED_WRITE_ADVICE}`,
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string], showDiff: true },
    handler: async (args) => {
      const filePath = resolveWorkspacePath(args['path'] as string);
      const content = args['content'] as string;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf8');
      return `Written ${filePath}`;
    },
  };
}

export function makeAppendFileTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'append_file',
        description:
          'Append content to the end of a file, creating it (and any missing directories) ' +
          `if it does not exist. Use this to build a large file across several calls: ${CHUNKED_WRITE_ADVICE}`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            content: {
              type: 'string',
              description: 'Content to append verbatim. No separator is inserted.',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string], showDiff: true },
    handler: async (args) => {
      const filePath = resolveWorkspacePath(args['path'] as string);
      const content = args['content'] as string;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // appendFileSync creates the file when absent, so a chunked write can
      // start with either tool.
      fs.appendFileSync(filePath, content, 'utf8');
      const total = fs.statSync(filePath).size;
      return `Appended ${content.length} chars to ${filePath} (${total} bytes total)`;
    },
  };
}

export function makeReplaceSelectionTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'replace_selection',
        description: 'Replace the current editor selection with new text.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Replacement text.' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: {
      paths: () =>
        vscode.window.activeTextEditor?.document.uri.fsPath
          ? [vscode.window.activeTextEditor.document.uri.fsPath]
          : [],
      showDiff: true,
    },
    handler: async (args) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) throw new Error('replace_selection: no active editor');
      await editor.edit((b) => b.replace(editor.selection, args['text'] as string));
      return 'Selection replaced.';
    },
  };
}

export function makeInsertCodeTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'insert_code',
        description: 'Insert a line of code at a zero-based line number in the active editor.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Code to insert (a trailing newline is added).' },
            line: { type: 'integer', description: 'Zero-based line number to insert at.' },
          },
          required: ['text', 'line'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: {
      paths: () =>
        vscode.window.activeTextEditor?.document.uri.fsPath
          ? [vscode.window.activeTextEditor.document.uri.fsPath]
          : [],
      showDiff: true,
    },
    handler: async (args) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) throw new Error('insert_code: no active editor');
      const line = args['line'] as number;
      await editor.edit((b) =>
        b.insert(new vscode.Position(line, 0), (args['text'] as string) + '\n'),
      );
      return `Inserted at line ${line}.`;
    },
  };
}
