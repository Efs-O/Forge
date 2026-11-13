/**
 * `format_file`, and the two questions its result used to skip.
 *
 * The lab's student ran it on a file `npx prettier --check` had already passed,
 * and the editor's formatter rewrote 165 lines; the result said `Formatted: a.ts`
 * and the run carried on building on it. The tool could not have answered either
 * of the questions that mattered — WHICH formatter ran, and HOW MUCH it changed —
 * so it did not ask itself. Now: prefer the formatter the project itself chose,
 * and name the formatter and the line count on every path that changes a file.
 *
 * Split out of `fileEditTools.ts` (move_file, delete_file, format_file,
 * rename_symbol) because this one carries a formatter lookup of its own.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveRealWorkspacePath } from '../util/WorkspacePaths';
import { diffContents } from '../sidebar/DiffUtils';
import { diffStats } from '../sidebar/diffMessages';

/** How long the project's own formatter may take before Forge calls it a failure. */
const FORMATTER_TIMEOUT_MS = 60_000;
/** A rewrite bigger than this, in lines, gets said out loud. */
const LARGE_REWRITE_LINES = 40;

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

interface ProjectFormatter {
  /** The folder whose `package.json` declares prettier — also its working
   *  directory, so the run finds the config the project's own scripts find. */
  projectDir: string;
  /** The CLI to run, or undefined when the package is declared but not installed. */
  cli: string | undefined;
}

/**
 * The formatter the project chose for itself, when it declared one.
 *
 * The signal is a `prettier` entry in the nearest `package.json`, not a config
 * file: a `.prettierrc` can sit in a parent folder belonging to another project,
 * while the dependency line says what `npm run` on THIS project would run.
 */
function findProjectPrettier(filePath: string): ProjectFormatter | undefined {
  let projectDir: string | undefined;
  for (let cursor = path.dirname(filePath); ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(path.join(cursor, 'package.json'))) {
      projectDir = cursor;
      break;
    }
    if (path.dirname(cursor) === cursor) return undefined;
  }
  let declared: boolean;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'),
    ) as Record<string, Record<string, unknown> | unknown>;
    const deps = ['dependencies', 'devDependencies'];
    declared =
      deps.some(
        (key) => (raw[key] as Record<string, unknown> | undefined)?.['prettier'] !== undefined,
      ) || raw['prettier'] !== undefined;
  } catch {
    return undefined;
  }
  if (!declared) return undefined;
  const cli = [
    path.join(projectDir, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
    path.join(projectDir, 'node_modules', 'prettier', 'bin-prettier.js'),
  ].find((candidate) => fs.existsSync(candidate));
  return { projectDir, cli };
}

/** Run the project's own formatter over one file. A formatter that cannot run is
 *  a fact to report, and the editor's formatter is still available — but Stop is
 *  not a formatter failure: a killed child may have left a part-written file. */
function runProjectFormatter(
  formatter: ProjectFormatter,
  filePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [formatter.cli as string, '--write', filePath],
      {
        cwd: formatter.projectDir,
        timeout: FORMATTER_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve(undefined);
          return;
        }
        if (signal?.aborted) {
          reject(
            new Error(
              `format_file: cancelled while the formatter ran; ${filePath} may be part-written — read it before retrying`,
            ),
          );
          return;
        }
        const reason = (stderr || error.message).replace(/\s+/gu, ' ').trim().slice(0, 300);
        resolve(reason || 'the formatter exited with a failure and said nothing');
      },
    );
  });
}

/** The last line of a text is not a line unless it ends with a newline — the same
 *  rule `DiffUtils.splitLines` keeps, so the two counts cannot disagree. */
function countLines(text: string): number {
  if (text === '') return 0;
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').length;
}

/** Join a result sentence to its optional follow-up note. */
function withNote(text: string, note?: string): string {
  return note ? `${text}\n${note}` : text;
}

/**
 * The one result sentence for "the formatter ran", built from the two facts the
 * old result left out. Every formatter path returns through here, so no path can
 * claim success without naming what it used and what it cost.
 *
 * The byte comparison comes first and decides "nothing changed": a line diff
 * cannot see a formatter that only added the missing trailing newline, and a
 * file too large to diff would otherwise be reported as formatted when it was not.
 */
function describeChange(
  filePath: string,
  before: string,
  after: string,
  formatterLabel: string,
  note?: string,
): string {
  if (before === after) {
    return withNote(
      `No changes: ${formatterLabel} left ${filePath} as it is — it is already formatted, or an ` +
        'ignore file excludes it.',
      note,
    );
  }
  const hunks = diffContents(before, after);
  if (hunks === null) {
    return withNote(
      `Formatted with ${formatterLabel}: ${filePath} — the change is too large for Forge to count ` +
        'lines. Read the diff before building on it.',
      note,
    );
  }
  const { added, removed } = diffStats(hunks);
  if (added === 0 && removed === 0) {
    return withNote(
      `Formatted with ${formatterLabel}: ${filePath} — no whole line changed, but the text did ` +
        `(${String(before.length)} → ${String(after.length)} characters: line endings or the ` +
        'trailing newline).',
      note,
    );
  }
  const changed = added + removed;
  const beforeLines = countLines(before);
  const headline =
    `Formatted with ${formatterLabel}: ${filePath} — ${String(changed)} line(s) changed ` +
    `(+${String(added)} -${String(removed)}, ${String(beforeLines)} → ${String(countLines(after))} lines).`;
  const large =
    changed > LARGE_REWRITE_LINES && changed * 5 > beforeLines
      ? `Note: that rewrote ${String(changed)} of ${String(beforeLines)} lines. If you expected a ` +
        'small change, read the diff before building on it: Forge runs the formatter, it cannot ' +
        'know what the file was meant to look like.'
      : undefined;
  return withNote([headline, large].filter((part) => part !== undefined).join('\n'), note);
}

export function makeFormatFileTool(extraRoots: () => readonly string[] = () => []): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'format_file',
        description:
          'Format one file with the formatter the project itself chose: its own Prettier when ' +
          'package.json declares it, otherwise the VS Code document formatter (Prettier, ESLint ' +
          'fix, ...). The result names the formatter that ran and counts the lines it changed, so ' +
          'read it before building on the file.',
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
      // The same refusal the provider path raises: Stop must read the same way
      // whatever step it landed on, and a bare DOMException names no tool.
      if (context?.abortSignal?.aborted) {
        throw new Error('format_file: cancelled before edits were applied');
      }

      // The project's own formatter first: the editor's formatter is whatever the
      // user happens to have installed, and the two disagree often enough to
      // rewrite a file the project's own `--check` had passed.
      const formatter = findProjectPrettier(uri.fsPath);
      const editorLabel = `the editor's formatter for ${doc.languageId} (Forge cannot see which extension answered)`;
      if (formatter?.cli !== undefined) {
        const before = doc.getText();
        const failure = await runProjectFormatter(formatter, uri.fsPath, context?.abortSignal);
        if (failure === undefined) {
          const after = await fs.promises.readFile(uri.fsPath, 'utf8');
          return describeChange(
            filePath,
            before,
            after,
            "the project's own Prettier",
            doc.isDirty
              ? 'Note: the editor buffer gained unsaved changes while the formatter ran, and it is ' +
                  'not what the formatter read — check the editor before saving over the file on disk.'
              : undefined,
          );
        }
        if (doc.isDirty) {
          throw new Error(
            `format_file: ${filePath} gained unsaved editor changes while the formatter ran; not ` +
              "falling back to the editor's formatter, which would save them",
          );
        }
        return formatWithEditorProvider(
          doc,
          filePath,
          editorLabel,
          context,
          `the project's own Prettier failed (${failure})`,
        );
      }
      return formatWithEditorProvider(
        doc,
        filePath,
        editorLabel,
        context,
        formatter === undefined
          ? undefined
          : 'package.json declares prettier, but Forge could not find its CLI in node_modules',
      );
    },
  };
}

/**
 * The editor's formatter, with every refusal it can produce named. Extracted from
 * the handler so the project-formatter branch above can fall into it with a
 * `reason` explaining why Forge did not use the project's own tool. The reason
 * is composed into the sentence only for the outcome it describes: claiming the
 * editor's formatter "answered instead" when it, too, never answered would be
 * the same overclaim this tool exists to stop.
 */
async function formatWithEditorProvider(
  doc: vscode.TextDocument,
  filePath: string,
  editorLabel: string,
  context?: Parameters<RegisteredTool['handler']>[1],
  reason?: string,
): Promise<string> {
  // Re-asked here, not only at the top of the handler: the project formatter may
  // have run first, and the user can type in that window.
  if (doc.isDirty) {
    throw new Error(
      `format_file: ${filePath} has unsaved editor changes; refusing to save unrelated user edits`,
    );
  }
  const versionBeforeFormat = doc.version;
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>(
    'vscode.executeFormatDocumentProvider',
    doc.uri,
    resolveFormattingOptions(doc),
  );

  if (!edits) {
    // Undefined covers both "no formatter registered" and a provider that
    // returned nothing. We cannot tell them apart, so we do not claim the
    // file was already formatted.
    return withNote(
      `No formatting edits returned; a formatter may not be available: ${filePath}`,
      reason ? `Note: ${reason}, and no editor formatter answered either.` : undefined,
    );
  }
  if (context?.abortSignal?.aborted) {
    throw new Error('format_file: cancelled before edits were applied');
  }
  if (doc.version !== versionBeforeFormat) {
    // The document changed while the provider ran, so the returned ranges
    // may no longer address the text they were computed against.
    throw new Error(`format_file: ${filePath} changed while formatting; no edits were applied`);
  }
  if (edits.length === 0)
    return withNote(
      `No changes: the formatter returned no edits: ${filePath}`,
      reason ? `Note: ${reason}; the editor's formatter returned no edits.` : undefined,
    );

  const before = doc.getText();
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(doc.uri, edits);
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
  return describeChange(
    filePath,
    before,
    doc.getText(),
    editorLabel,
    reason ? `Note: ${reason}; the editor's formatter answered instead.` : undefined,
  );
}
