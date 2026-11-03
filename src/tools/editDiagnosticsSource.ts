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
  const languages = (vscode as unknown as { languages?: Record<string, unknown> }).languages;
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
      return pairs.map(([uri, problems]) => [uri.fsPath, problems.map(toReportedProblem)]);
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
