import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import {
  agentWriteOptions,
  delayedWriteNote,
  writeFileAtomic,
  type ExpectedFileState,
} from '../util/atomicWrite';
import { withFileLengthWarning, type FileLengthWarningGetter } from './fileLengthWarning';
import { NO_PROBLEM_WATCHER, withProblemNote, type ProblemWatcher } from './editDiagnostics';
import { applyWriteEol, chooseWriteEol, readExistingForWrite } from './writeEol';

/**
 * `read_file` moved to `src/tools/readFileTool.ts` on 2026-10-29 (tool-trim
 * lane A, item A3): this file was 463 lines against the eslint `max-lines` gate
 * at 500, and multi-range reads did not fit in the headroom that was left. The
 * re-export is deliberate — `registerAllTools.ts`, `FileToolExecution`,
 * `BatchEditExecution`, `OwnerOnlyFileTools` and the live capability harness all
 * import `makeReadFileTool` from here, so the split cost no call-site churn.
 * `docs/OWNERS.md` now names `readFileTool.ts` as the owner of file reads.
 */
export { makeReadFileTool } from './readFileTool';

interface AppendFileSnapshot {
  bytes: Buffer;
  text: string | undefined;
  expected: ExpectedFileState | null;
}

/** Read append bytes and their state from the same open file handle. */
function readAppendSnapshot(filePath: string): AppendFileSnapshot {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { bytes: Buffer.alloc(0), text: undefined, expected: null };
    }
    throw error;
  }

  try {
    const bytes = fs.readFileSync(descriptor);
    const stat = fs.fstatSync(descriptor);
    return {
      bytes,
      text: bytes.toString('utf8'),
      expected: { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs },
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function makeWriteFileTool(
  extraRoots: () => readonly string[] = () => [],
  lengthWarning: FileLengthWarningGetter = () => undefined,
  watchProblems: ProblemWatcher = NO_PROBLEM_WATCHER,
): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description:
          'Write content to a file, creating it (and any missing directories) if needed. ' +
          'Overwrites any existing content. Write the whole file in one call, even when large; ' +
          'do not split it into part-files to join with the shell. If a call is cut off, Forge ' +
          'reports that and gives the retry size.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Workspace-relative or absolute path. Include a nested repository directory prefix.',
            },
            content: {
              type: 'string',
              description: 'File content to write.',
            },
            mode: {
              type: 'string',
              enum: ['overwrite', 'append'],
              description:
                '"overwrite" (default) replaces existing content; "append" adds to the end of ' +
                'the file, creating it when absent. Use append only to continue a write that ' +
                'was cut off.',
            },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
    },
    permission: 'write',
    mutation: { paths: (args) => [args['path'] as string], showDiff: true },
    handler: async (args, context) => {
      const mode = args['mode'];
      if (mode !== undefined && mode !== 'overwrite' && mode !== 'append') {
        throw new Error(
          `write_file: mode must be "overwrite" or "append", not ${JSON.stringify(mode)}.`,
        );
      }
      const filePath = await resolveRealWorkspacePath(args['path'] as string, undefined, {
        allowMissing: true,
        extraRoots: extraRoots(),
      });
      const appendSnapshot = mode === 'append' ? readAppendSnapshot(filePath) : undefined;
      const existing = mode === 'append' ? appendSnapshot?.text : readExistingForWrite(filePath);
      const content = args['content'] as string;
      const converted = applyWriteEol(content, await chooseWriteEol(filePath, existing));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Snapshot before the write, whatever the mode: the append path is where a
      // cut-off write resumes, and a resumed write can introduce an error too.
      // Awaiting the watcher here is what opens the document first, so the
      // language service sees the bytes this call is about to write.
      const watch = await watchProblems(filePath);
      if (mode === 'append') {
        // Preserve append semantics while using the same lock-aware atomic save
        // path as overwrite. The decoded text chooses EOL; the original bytes
        // remain untouched, including when the file is not valid UTF-8.
        const snapshot = appendSnapshot!;
        const appended = Buffer.concat([snapshot.bytes, Buffer.from(converted.content, 'utf8')]);
        let contentionNote = '';
        await writeFileAtomic(
          filePath,
          appended,
          agentWriteOptions(context?.abortSignal, { expected: snapshot.expected }, (report) => {
            contentionNote = delayedWriteNote(report);
          }),
        );
        const total = fs.statSync(filePath).size;
        const note = watch ? await watch.settle(context?.abortSignal) : '';
        return withFileLengthWarning(
          withProblemNote(
            `Appended ${content.length} chars to ${filePath} (${total} bytes total)${converted.note}` +
              (contentionNote ? `\n${contentionNote}` : ''),
            note,
          ),
          filePath,
          lengthWarning(),
        );
      }
      let contentionNote = '';
      await writeFileAtomic(
        filePath,
        converted.content,
        agentWriteOptions(context?.abortSignal, {}, (report) => {
          contentionNote = delayedWriteNote(report);
        }),
      );
      const note = watch ? await watch.settle(context?.abortSignal) : '';
      return withFileLengthWarning(
        withProblemNote(
          `Written ${filePath}${converted.note}${contentionNote ? `\n${contentionNote}` : ''}`,
          note,
        ),
        filePath,
        lengthWarning(),
      );
    },
  };
}

// The two active-editor writers (`replace_selection`, `insert_code`) and their
// `editAndSave` helper were retired on 2026-11-13: across the whole session
// archive they had been called 19 and 13 times, every call from a tool harness
// probe, against 10,969 uses of `edit_file`. Both names now resolve through
// `sidebar/retiredTools.ts`, so a saved conversation still replays and a model
// that calls one is pointed at `edit_file`, which takes an explicit path.
//
// What is lost with them is the ability to write the file the USER has focused
// without knowing its path — `get_editor_context` reads that picture, and
// `edit_file` then writes it by name.

/**
 * The read side of the active editor. The two tools that used to write it —
 * `replace_selection` and `insert_code` — are retired above, so this is how a
 * model finds out what the user is looking at before it names a path.
 *
 * Nothing else could read the editor back: a user saying "fix this" with a
 * selection highlighted gave the model no way to
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
          'Reports the window\'s editor: active file, selection and range, cursor, and open tab paths. Other chats in this window share this editor, so it may show their files. Use when the user says "this", "here", or "the selection" without naming a file.',
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
