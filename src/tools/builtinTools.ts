import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspacePath } from '../util/WorkspacePaths';
import { CHUNKED_WRITE_ADVICE } from './writeChunking';
import { mimeFromHeader } from './imageTool';
import { MAX_READ_FILE_CHARS, capResultText } from './resultCap';

/** How much of a file to sniff for NUL bytes before calling it binary. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Binary files have no business being decoded as UTF-8 and fed to a model — a
 * 1.3 MB PNG became ~1.3 M characters of replacement glyphs and exhausted a
 * one-slot context in a single tool result. Refuse, and for an image name the
 * tool that does handle it rather than leaving the model to find a workaround.
 */
function binaryRefusal(bytes: Buffer, requestedPath: string): string | null {
  const imageMime = mimeFromHeader(bytes);
  if (imageMime) {
    return (
      `read_file: ${requestedPath} is an image (${imageMime}), not text. Use view_image to look at it. ` +
      'If view_image is not available to you, the active model has no vision projector configured; ' +
      'tell the user to switch to a vision-capable model.'
    );
  }
  if (!bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  return `read_file: ${requestedPath} appears to be a binary file, not text. Refusing to decode it as UTF-8.`;
}

/** Bound every read_file return path; a range re-read is the way to get more. */
function capRead(text: string): string {
  return capResultText(
    text,
    MAX_READ_FILE_CHARS,
    'read_file',
    'Re-read a smaller range with start_line and end_line to see the rest.',
  );
}

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
            path: {
              type: 'string',
              description:
                'File path, relative to the WORKSPACE ROOT (not to any project directory named in the task) or absolute. For a repository nested in the workspace, keep its directory as a prefix, e.g. "subproject/src/main.ts".',
            },
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
            numbered: {
              type: 'boolean',
              description:
                'Prefix each line with its 1-based number as "  12| text". Use when you need ' +
                'line numbers, e.g. to build apply_line_edits operations. The prefix is display ' +
                'only — never copy it into old_str or expected_lines.',
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
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(filePath);
      } catch (err) {
        throw new Error(`read_file: ${(err as Error).message}`);
      }
      const refusal = binaryRefusal(bytes, args['path'] as string);
      if (refusal) throw new Error(refusal);
      const content = bytes.toString('utf8');

      const startLine = typeof args['start_line'] === 'number' ? args['start_line'] : undefined;
      const endLine = typeof args['end_line'] === 'number' ? args['end_line'] : undefined;
      const numbered = args['numbered'] === true;
      if (startLine === undefined && endLine === undefined && !numbered) return capRead(content);

      const lines = content.split('\n');
      const start = Math.max(1, startLine ?? 1);
      const end = Math.min(lines.length, endLine ?? lines.length);
      if (start > end) {
        throw new Error(
          `read_file: start_line ${start} is past end_line ${end} (file has ${lines.length} lines).`,
        );
      }
      const selected = lines.slice(start - 1, end);
      if (!numbered) return capRead(selected.join('\n'));
      // `apply_line_edits` wants 1-based line numbers, but the only way to read
      // a file gave none — so the model counted them itself and got it wrong:
      // 14 of its 19 calls failed on stale or miscounted `expected_lines`.
      const width = String(end).length;
      return capRead(
        selected
          .map((line, index) => `${String(start + index).padStart(width, ' ')}| ${line}`)
          .join('\n'),
      );
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
            path: {
              type: 'string',
              description:
                'File path, relative to the WORKSPACE ROOT (not to any project directory named in the task) or absolute. For a repository nested in the workspace, keep its directory as a prefix, e.g. "subproject/src/main.ts".',
            },
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
            path: {
              type: 'string',
              description:
                'File path, relative to the WORKSPACE ROOT (not to any project directory named in the task) or absolute. For a repository nested in the workspace, keep its directory as a prefix, e.g. "subproject/src/main.ts".',
            },
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
        description:
          'Replace the current editor selection with new text, in the ACTIVE EDITOR — the file ' +
          'the user currently has focused, which you cannot choose or see. Prefer edit_file, ' +
          'which takes an explicit path. The result names the file that was written; check it.',
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
      // Name the file, for the same reason insert_code does.
      return `Selection replaced in ${vscode.workspace.asRelativePath(editor.document.uri)}.`;
    },
  };
}

export function makeInsertCodeTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'insert_code',
        description:
          'Insert a line of code at a zero-based line number in the ACTIVE EDITOR — the file ' +
          'the user currently has focused, which you cannot choose or see. Prefer edit_file, ' +
          'which takes an explicit path. The result names the file that was written; check it.',
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
      // Name the file. The target is whatever the user has focused, which the
      // model cannot choose or inspect — so a bare "Inserted at line 0." let a
      // write land in an unrelated file with nothing in the transcript to show
      // it. Reporting the path turns a silent mistake into a visible one.
      return `Inserted at line ${line} of ${vscode.workspace.asRelativePath(editor.document.uri)}.`;
    },
  };
}

/**
 * The read-side counterpart to replace_selection / insert_code.
 *
 * Those two write into the active editor, but nothing could read it back: a
 * user saying "fix this" with a selection highlighted gave the model no way to
 * see what "this" was, so it re-read whole files and guessed. One call returns
 * the whole "what is the user looking at" picture — active file, selection,
 * cursor, and the other open tabs — because a separate tool per fact would
 * cost three tool rounds and three tool definitions to answer one question.
 */
export function makeGetEditorContextTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_editor_context',
        description:
          'Read what the user currently has open: the active file, the selected text and its ' +
          'range, the cursor position, and the paths of all open editor tabs. Use this when the ' +
          'user refers to "this", "here", or "the selection" without naming a file.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async () => {
      const lines: string[] = [];
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        lines.push('Active editor: (none)');
      } else {
        const doc = editor.document;
        const rel = vscode.workspace.asRelativePath(doc.uri);
        const sel = editor.selection;
        lines.push(`Active editor: ${rel} (${doc.languageId}, ${doc.lineCount} lines)`);
        // One-based to match every other position the user sees in the UI and
        // the gutter; the write-side tools take zero-based lines, so the
        // convention is stated rather than left to be inferred.
        lines.push(
          `Cursor (1-based): line ${sel.active.line + 1}, column ${sel.active.character + 1}`,
        );
        if (sel.isEmpty) {
          lines.push('Selection: (empty)');
        } else {
          const text = doc.getText(sel);
          lines.push(
            `Selection (1-based): lines ${sel.start.line + 1}-${sel.end.line + 1}, ` +
              `${text.length} chars`,
          );
          lines.push('--- selected text ---');
          lines.push(text);
          lines.push('--- end selected text ---');
        }
      }

      // tabGroups sees every open tab, including ones scrolled out of view and
      // non-text tabs; visibleTextEditors only sees split panes currently on
      // screen, which under-reports what the user considers "open".
      const tabs: string[] = [];
      for (const group of vscode.window.tabGroups?.all ?? []) {
        for (const tab of group.tabs) {
          const input = tab.input as { uri?: vscode.Uri } | undefined;
          if (input?.uri) tabs.push(vscode.workspace.asRelativePath(input.uri));
        }
      }
      const unique = [...new Set(tabs)];
      lines.push(
        unique.length ? `Open tabs (${unique.length}):\n${unique.join('\n')}` : 'Open tabs: (none)',
      );

      return lines.join('\n');
    },
  };
}
