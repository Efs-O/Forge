/**
 * The diagnostics half of `code_intel`: what the language service has already
 * recorded about a file, printed the one way Forge prints it.
 *
 * Split out of `lspTools.ts` on 2026-11-24
 * (`docs/plans/LSP_TOOLS_SPLIT_PLAN.md`, Seam 1). Nothing in this file asks a
 * provider about a symbol — it reads `vscode.languages.getDiagnostics`, and for
 * a cold file waits for a fresh check through `withDiagnosticsReady`.
 * `formatDiagnosticLine` is the single owner of the
 * `path:line: severity code: message` spelling, called by the handler below and
 * by `editDiagnosticsNotes.ts`, so the same problem cannot reach a model
 * written two ways.
 */
import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';
import { withDiagnosticsReady } from './codeActionTools';

/** Severity as a word, the way a model reads it in a result. */
export function severityLabel(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    case vscode.DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'unknown';
  }
}

/**
 * The single owner of the `path:line: severity code: message` spelling
 * (tools-expansion lane F1, item 1.3): `__code_intel_get_diagnostics` and the
 * "new problems after this edit" note that `edit_file`, `write_file` and
 * `apply_line_edits` append (`editDiagnostics.ts`) both call it, so the same
 * problem cannot reach a model written two ways. The code sits between the
 * severity and the message because `TS2345` is what a model looks up, and a
 * problem with no code prints exactly what it used to. Whitespace inside a
 * message is flattened so one problem stays one line — otherwise the cap on how
 * many problems a result may name stops counting problems.
 */
export function formatDiagnosticLine(
  relativePath: string,
  problem: {
    /** One-based line, the way a result and an editor both show it. */
    line: number;
    severity: vscode.DiagnosticSeverity;
    message: string;
    code?: string | number | { value: string | number; target?: vscode.Uri | string };
  },
): string {
  const raw = problem.code;
  const code =
    raw === undefined || raw === ''
      ? ''
      : ` ${typeof raw === 'object' ? String(raw.value) : String(raw)}`;
  return (
    `${relativePath}:${problem.line}: ` +
    `${severityLabel(problem.severity)}${code}: ${problem.message.replace(/\s+/gu, ' ')}`
  );
}

// ── Diagnostics handler ────────────────────────────────────────────────────────

export function makeGetDiagnosticsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_get_diagnostics',
        description:
          'Get language diagnostics. Without a path, reports only files open in the editor; with a path, checks that file even when closed.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'File path (absolute or workspace-relative). Omit to report only files open in the editor; provide a path to check that file even when closed.',
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      context?.abortSignal?.throwIfAborted();
      const p = args['path'] as string | undefined;
      let pairs: [vscode.Uri, vscode.Diagnostic[]][];
      let timedOutEmpty = false;
      let freshnessNote = '';
      if (p) {
        const uri = resolveWorkspaceUri(p);
        const ready = await withDiagnosticsReady(
          uri,
          async () => vscode.languages.getDiagnostics(uri),
          { waitForFreshDiagnostics: true },
        );
        pairs = [[uri, ready.result]];
        timedOutEmpty = ready.diagnosticsWaitTimedOut && ready.diagnosticsStillEmpty;
        if (ready.diagnosticsFreshnessWaitTimedOut) {
          freshnessNote =
            `Note: VS Code reported no new check of ${p} in the 4 s after Forge's edit, ` +
            'so these diagnostics may predate it.';
        }
      } else {
        pairs = vscode.languages.getDiagnostics();
      }
      context?.abortSignal?.throwIfAborted();

      const lines: string[] = [];
      for (const [uri, diags] of pairs) {
        for (const d of diags) {
          lines.push(
            formatDiagnosticLine(vscode.workspace.asRelativePath(uri), {
              line: d.range.start.line + 1,
              severity: d.severity,
              message: d.message,
              ...(d.code === undefined ? {} : { code: d.code }),
            }),
          );
        }
      }
      const diagnosticsText = lines.length
        ? lines.join('\n')
        : timedOutEmpty
          ? `No diagnostics reported for ${p} after Forge opened it in an editor tab and waited 4 s. If you expect errors, ask again in a few seconds or run the project's type checker with shell.`
          : 'No diagnostics found.';
      return freshnessNote ? `${freshnessNote}\n${diagnosticsText}` : diagnosticsText;
    },
  };
}
