/**
 * The VS Code-backed `DiagnosticsSource` that `editDiagnostics.ts` uses.
 *
 * Split out on 2026-10-29 while fixing Claude's review of 7f05a5d5 (item 2,
 * closed files): the note module had grown four answers and two waits, and the
 * adapter that talks to `vscode.languages` and `vscode.workspace` was sharing
 * its file at the 500-line `max-lines` gate. This is where the host's API shape
 * lives — "this host has no diagnostics", "this path is outside every workspace
 * root", "this file cannot be opened" — and `editDiagnostics.ts` stays testable
 * through the source it is injected with.
 *
 * The type-only import back into `editDiagnostics.ts` is deliberate: the runtime
 * dependency runs one way only, so the two files cannot form a cycle.
 */
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { isPathInside } from '../util/pathContainment';
import type { DiagnosticsSource, ReportedProblem } from './editDiagnostics';

/**
 * The largest file this will open just so a service has something to report on.
 *
 * `openTextDocument` loads the whole file into the language service, and the
 * note is only willing to wait a couple of seconds for an answer: past a few
 * megabytes the parse that has to finish before any problem can be reported is
 * the very thing that misses the deadline, so the open buys a stall and no
 * answer. 5 MB is well past what TypeScript or ESLint report usefully inside
 * that window, and a file that big is usually generated, vendored or a lock
 * file — the kind where "this edit was not checked" is the honest answer
 * anyway. Skipping it costs nothing: the note says why, and names the tool that
 * can still check it on demand.
 */
const MAX_PRIMED_FILE_BYTES = 5 * 1024 * 1024;

const TS_JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const TS_JS_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);
const pendingDiagnostics = new Map<string, PendingDiagnosticsMark>();
const reportedDiagnosticsUris = new Set<string>();
const completedDiagnosticsChecks = new Set<string>();
const timedOutDiagnosticsChecks = new Set<string>();
let pendingDiagnosticsSubscription: vscode.Disposable | undefined;

/** The instant a Forge edit began waiting for its next diagnostics check. */
export interface PendingDiagnosticsMark {
  markedAt: number;
}

/** Mark an eligible Forge-written document until its next diagnostics check. */
export function markDiagnosticsPending(uriOrPath: vscode.Uri | string): void {
  const uri = typeof uriOrPath === 'string' ? vscode.Uri.file(uriOrPath) : uriOrPath;
  const key = uri.toString();
  if (!hasDiagnosticsProvider(uri) || !installDiagnosticsObserver()) return;

  reportedDiagnosticsUris.add(key);
  completedDiagnosticsChecks.delete(key);
  timedOutDiagnosticsChecks.delete(key);
  pendingDiagnostics.set(key, { markedAt: Date.now() });
}

/** Whether a Forge edit still needs a diagnostics change event for this document. */
export function hasPendingDiagnostics(uri: vscode.Uri): boolean {
  return pendingDiagnostics.has(uri.toString());
}

/** The timestamp for a pending edit, so its wait ends four seconds after the edit. */
export function pendingDiagnosticsMark(uri: vscode.Uri): PendingDiagnosticsMark | undefined {
  return pendingDiagnostics.get(uri.toString());
}

/** Clear only the same mark that timed out, preserving a newer edit's wait. */
export function clearPendingDiagnostics(uri: vscode.Uri, mark: PendingDiagnosticsMark): void {
  const key = uri.toString();
  if (pendingDiagnostics.get(key) === mark) {
    pendingDiagnostics.delete(key);
    timedOutDiagnosticsChecks.add(key);
    disposeDiagnosticsObserverWhenIdle();
  }
}

/** Whether a matching diagnostics event already cleared a mark for this edit. */
export function hasCompletedDiagnosticsCheck(uri: vscode.Uri): boolean {
  return completedDiagnosticsChecks.has(uri.toString());
}

/** Whether a prior timeout should keep retries from starting another cold wait. */
export function hasTimedOutDiagnosticsCheck(uri: vscode.Uri): boolean {
  return timedOutDiagnosticsChecks.has(uri.toString());
}

/** Whether VS Code has a known diagnostics provider for this document. */
export function hasDiagnosticsProvider(uri: vscode.Uri): boolean {
  const key = uri.toString();
  if (reportedDiagnosticsUris.has(key)) return true;

  const languages = getLanguages();
  const getDiagnostics = languages?.['getDiagnostics'] as
    | ((resource: vscode.Uri) => vscode.Diagnostic[])
    | undefined;
  try {
    if (typeof getDiagnostics === 'function' && getDiagnostics(uri).length > 0) {
      reportedDiagnosticsUris.add(key);
      return true;
    }
  } catch {
    // A diagnostics read that cannot run is not evidence that a provider exists.
  }

  const documents = vscode.workspace.textDocuments ?? [];
  const languageId = documents.find((document) => document.uri.toString() === key)?.languageId;
  if (languageId !== undefined && TS_JS_LANGUAGES.has(languageId)) return true;
  return TS_JS_EXTENSIONS.has(pathExtension(uri.fsPath));
}

function pathExtension(filePath: string): string {
  const filename = filePath.replace(/\\/gu, '/').split('/').pop() ?? '';
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

/** Install one observer for provider history and pending-mark cleanup. */
function installDiagnosticsObserver(): boolean {
  if (pendingDiagnosticsSubscription) return true;
  const languages = getLanguages();
  const onDidChange = languages?.['onDidChangeDiagnostics'] as
    | ((listener: (event: { uris: vscode.Uri[] }) => void) => vscode.Disposable)
    | undefined;
  if (typeof onDidChange !== 'function') return false;

  try {
    pendingDiagnosticsSubscription = onDidChange((event) => {
      for (const changedUri of event.uris) {
        const key = changedUri.toString();
        reportedDiagnosticsUris.add(key);
        if (pendingDiagnostics.delete(key)) completedDiagnosticsChecks.add(key);
      }
      disposeDiagnosticsObserverWhenIdle();
    });
    return true;
  } catch {
    return false;
  }
}

function disposeDiagnosticsObserverWhenIdle(): void {
  if (pendingDiagnostics.size > 0) return;
  pendingDiagnosticsSubscription?.dispose();
  pendingDiagnosticsSubscription = undefined;
}

/** VS Code's test hosts may omit the language namespace entirely. */
function getLanguages(): Record<string, unknown> | undefined {
  try {
    return (vscode as unknown as { languages?: Record<string, unknown> }).languages;
  } catch {
    return undefined;
  }
}

/**
 * The VS Code-backed source, or undefined when this host has no diagnostics API.
 *
 * Both halves are required: without the event, the wait could only ever sleep
 * the full deadline, and a host that has one and not the other is not a real
 * language service to diff against. That is what makes the forge-bench tool
 * host — which has no `vscode` at all — a no-op rather than a two-second stall
 * and a sentence about a service that was never there.
 */
export function vscodeDiagnosticsSource(): DiagnosticsSource | undefined {
  const languages = getLanguages();
  const getDiagnostics = languages?.['getDiagnostics'] as
    | (() => [vscode.Uri, vscode.Diagnostic[]][])
    | undefined;
  const onDidChange = languages?.['onDidChangeDiagnostics'] as
    | ((listener: (event: { uris: vscode.Uri[] }) => void) => { dispose(): void })
    | undefined;
  if (typeof getDiagnostics !== 'function' || typeof onDidChange !== 'function') {
    return undefined;
  }
  return {
    reported() {
      const pairs = getDiagnostics();
      if (!Array.isArray(pairs)) return undefined;
      return pairs.map(([uri, problems]) => {
        reportedDiagnosticsUris.add(uri.toString());
        return [uri.fsPath, problems.map(toReportedProblem)];
      });
    },
    onChange(listener) {
      const subscription = onDidChange((event) => listener(event.uris.map((uri) => uri.fsPath)));
      return () => subscription.dispose();
    },
    /**
     * Load the document so a language service has something to report on.
     *
     * VS Code's services only diagnose documents they hold, so an agent's edit
     * to a file no editor has open would otherwise sit in the note as "nothing
     * reported on it" forever. `openTextDocument` loads it without showing it —
     * the same priming `lspTools.ts` does for symbols, hover and definitions,
     * which is where this came from.
     * The edit tools already show the edited file in a tab through `ToolDispatch.ts`.
     *
     * Files outside every workspace folder are skipped: the services analyse
     * documents the workspace knows, and a target the tool reached through
     * `extra_file_roots` is outside that, so opening it would cost a document
     * load for a file nothing will ever report on. So is a file past
     * `MAX_PRIMED_FILE_BYTES`, and that one says why, because "the file is too
     * large to check" is something the model can act on and "nothing reported
     * on it" is not.
     */
    async ensureChecked(path: string): Promise<string | undefined> {
      const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
      if (!roots.some((root) => isPathInside(root, path))) return undefined;
      let size: number;
      try {
        size = (await fs.stat(path)).size;
      } catch {
        // Gone or unreadable before the open lands: the open would have failed
        // the same way, and the note already says what an unchecked edit means.
        return undefined;
      }
      if (size > MAX_PRIMED_FILE_BYTES) {
        return (
          `the file is ${(size / 1_048_576).toFixed(1)} MB and this host opens only ` +
          `files up to ${MAX_PRIMED_FILE_BYTES / 1_048_576} MB for checking`
        );
      }
      try {
        await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      } catch {
        // Binary, unreadable, or gone by the time the open lands: the note reads
        // whatever the service did report, so a failed priming step has to fail
        // nothing here.
      }
      return undefined;
    },
    /**
     * The language id of an open document, if one holds this file.
     *
     * Only open documents are asked: `ensureChecked` has already opened the file
     * it intends to have checked, and a language id for a file nothing holds
     * would be a guess.
     */
    languageOf(path: string): string | undefined {
      const target = vscode.Uri.file(path).fsPath;
      // A host without the document list simply has no answer here.
      const documents: readonly vscode.TextDocument[] = vscode.workspace.textDocuments ?? [];
      return documents.find((document) => document.uri.fsPath === target)?.languageId;
    },
  };
}

function toReportedProblem(diagnostic: vscode.Diagnostic): ReportedProblem {
  const code = diagnostic.code;
  return {
    // Zero-based in the API, one-based in everything a model reads.
    line: diagnostic.range.start.line + 1,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
    ...(code === undefined
      ? {}
      : { code: typeof code === 'object' ? String(code.value) : String(code) }),
  };
}
