import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';
import { withDiagnosticsReady } from './codeActionTools';
import { describePosition, primeSymbolAtPosition } from './symbolSearch';
import {
  formatLocationResults,
  formatSymbolTree,
  formatWorkspaceSymbols,
  noSymbolMessage,
  POSITION_NOTE,
} from './lspFormat';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolves a path and makes sure the language service has actually seen it.
 *
 * VS Code's language servers analyse open documents. A file the user has never
 * opened may have no symbols, no hover and no definitions — not because the
 * code lacks them, but because nothing asked for the file to be parsed. That
 * reads as a broken code-intelligence operation: measured on a real run, a
 * file containing `export class Game` returned "No symbols found." while a
 * plain text search found the class on line 32.
 *
 * `openTextDocument` loads the document into the workspace without showing it
 * in an editor. TypeScript diagnostics and quick fixes need a tab; diagnostics
 * use `withDiagnosticsReady` in codeActionTools.ts.
 */
async function openForAnalysis(pathArg: string): Promise<vscode.Uri> {
  const uri = resolveWorkspaceUri(pathArg);
  try {
    await vscode.workspace.openTextDocument(uri);
  } catch {
    // Binary, deleted, or unreadable — let the provider call report the real
    // problem rather than failing here on a preparatory step.
  }
  return uri;
}

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

function noProviderAnswer(
  kind: 'references' | 'definition' | 'implementations' | 'hover information',
  description: Awaited<ReturnType<typeof describePosition>>,
): string {
  return `No ${kind} found for \`${description.word}\` at ${description.label}. That line reads: \`${description.lineText}\`. If \`${description.word}\` is not the symbol you meant (for example a word in a comment or a string), point line and character at the symbol's name.`;
}

function missingTextSearchFiles(
  result: readonly (vscode.Location | vscode.LocationLink)[] | undefined,
  searched: readonly string[],
): string[] {
  const reported = new Set(
    (result ?? []).map((location) => {
      const link = location as vscode.LocationLink;
      const plain = location as vscode.Location;
      return pathKey(vscode.workspace.asRelativePath(link.targetUri ?? plain.uri));
    }),
  );
  return searched
    .map((file) => vscode.workspace.asRelativePath(vscode.Uri.file(file)).replace(/\\/gu, '/'))
    .filter((file) => !reported.has(pathKey(file)))
    .sort();
}

function pathKey(value: string): string {
  return value.replace(/\\/gu, '/').toLowerCase();
}

function referencesTextNote(name: string, missing: readonly string[]): string {
  return missing.length
    ? `\n\nNote: a text search also finds \`${name}\` in ${missing.length} file(s) the language server did not report: ${missing.join(', ')}. The language server may still be loading this project; ask again in a few seconds, or check those files with grep_search.`
    : '';
}

const HOVER_LOADING_NOTE =
  '\n\nNote: `(loading...)` means the language server has not finished loading this project, so this answer may lack types. Ask again in a few seconds.';

function hoverText(result: vscode.Hover[] | undefined): string {
  if (!result?.length) return '';
  const parts: string[] = [];
  for (const hover of result) {
    for (const content of hover.contents) {
      if (typeof content === 'string') parts.push(content);
      else if ('value' in content) parts.push(content.value);
    }
  }
  return parts.join('\n\n');
}

async function hoverWithLoadingRetry(uri: vscode.Uri, position: vscode.Position): Promise<string> {
  let answer = hoverText(
    await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
      'vscode.executeHoverProvider',
      uri,
      position,
    ),
  );
  for (const delay of [250, 500, 1000, 2000, 4000]) {
    if (!answer.includes('(loading...)')) return answer;
    await new Promise((resolve) => setTimeout(resolve, delay));
    answer = hoverText(
      await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
        'vscode.executeHoverProvider',
        uri,
        position,
      ),
    );
  }
  return answer.includes('(loading...)') ? `${answer}${HOVER_LOADING_NOTE}` : answer;
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

// ── Document symbols handler ───────────────────────────────────────────────────

export function makeGetDocumentSymbolsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_get_document_symbols',
        description:
          'List all symbols (functions, classes, variables, etc.) in a file as an indented tree.',
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
    permission: 'read',
    handler: async (args, context) => {
      context?.abortSignal?.throwIfAborted();
      const uri = await openForAnalysis(args['path'] as string);
      const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | undefined>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      );
      context?.abortSignal?.throwIfAborted();
      if (result === undefined) {
        // `undefined` means no provider answered at all: a language server still
        // starting, or a file type with no symbol provider. That is a different
        // answer from "this file has no symbols", and one string for both let a
        // model conclude the file was empty while it was still being parsed.
        return (
          `No symbol provider answered for ${String(args['path'] ?? 'this file')}. ` +
          'The language server may still be starting — ask again in a few seconds, or use ' +
          'grep_search. A file type with no symbol provider answers the same way.'
        );
      }
      if (result.length === 0) {
        // VS Code answers `[]` both for "this file has no symbols" and for "no
        // symbol provider is running yet"; the API cannot tell them apart, so
        // neither can this. Say the hedge rather than assert either half.
        return (
          'No symbols found. That is not proof the file has none: a language server that has not ' +
          'finished starting answers the same way. If you expected symbols here, ask again in a ' +
          'few seconds, or use grep_search.'
        );
      }
      return `${formatSymbolTree(result).join('\n')}\n\n${POSITION_NOTE}`;
    },
  };
}

// ── Workspace symbols handler ──────────────────────────────────────────────────

export function makeGetWorkspaceSymbolsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_get_workspace_symbols',
        description: 'Search for symbols by name across the entire workspace.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Symbol name query.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const query = args['query'] as string;
      const result = await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
        'vscode.executeWorkspaceSymbolProvider',
        query,
      );
      if (result === undefined) {
        return (
          `No workspace symbol provider answered for "${query}". ` +
          'The language server may still be starting — ask again in a few seconds, or use grep_search.'
        );
      }
      if (result.length === 0) {
        return (
          `No symbols match "${query}". That is not proof none exist: a language server that has ` +
          'not finished starting answers the same way. Ask again in a few seconds, or use grep_search.'
        );
      }
      return formatWorkspaceSymbols(result);
    },
  };
}

// ── Hover handler ──────────────────────────────────────────────────────────────

export function makeGetHoverTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_get_hover',
        description: 'Get hover information (type info, docs) at a specific position in a file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            line: { type: 'integer', description: 'Zero-based line number.' },
            character: { type: 'integer', description: 'Zero-based character offset.' },
          },
          required: ['path', 'line', 'character'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const displayPath = args['path'] as string;
      const uri = await openForAnalysis(displayPath);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      const description = await describePosition(uri, position, displayPath);
      if (!description.word) return noSymbolMessage(description, position);
      const answer = await hoverWithLoadingRetry(uri, position);
      return answer || noProviderAnswer('hover information', description);
    },
  };
}

// ── Definition handler ─────────────────────────────────────────────────────────

export function makeGoToDefinitionTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_go_to_definition',
        description: 'Find the definition location(s) of the symbol at the given position.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            line: { type: 'integer', description: 'Zero-based line number.' },
            character: { type: 'integer', description: 'Zero-based character offset.' },
          },
          required: ['path', 'line', 'character'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const displayPath = args['path'] as string;
      const uri = await openForAnalysis(displayPath);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      const description = await describePosition(uri, position, displayPath);
      if (!description.word) return noSymbolMessage(description, position);
      await primeSymbolAtPosition(uri, position);
      const result = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink> | undefined
      >('vscode.executeDefinitionProvider', uri, position);
      if (!result?.length) return noProviderAnswer('definition', description);
      return formatLocationResults(result);
    },
  };
}

// ── References handler ─────────────────────────────────────────────────────────

export function makeFindReferencesTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_find_references',
        description: 'Find all references to the symbol at the given position (max 50).',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            line: { type: 'integer', description: 'Zero-based line number.' },
            character: { type: 'integer', description: 'Zero-based character offset.' },
          },
          required: ['path', 'line', 'character'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const displayPath = args['path'] as string;
      const uri = await openForAnalysis(displayPath);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      const description = await describePosition(uri, position, displayPath);
      if (!description.word) return noSymbolMessage(description, position);
      const primed = await primeSymbolAtPosition(uri, position);
      const result = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        'vscode.executeReferenceProvider',
        uri,
        position,
      );
      const answer = result?.length
        ? formatLocationResults(result.slice(0, 50))
        : noProviderAnswer('references', description);
      return (
        answer + referencesTextNote(primed.name ?? '', missingTextSearchFiles(result, primed.files))
      );
    },
  };
}

// ── Implementations handler ────────────────────────────────────────────────────

/**
 * "Who implements this?" — the question the `references` operation answers badly.
 *
 * On an interface or abstract method, references returns every call site mixed
 * in with the implementations, and the implementations are usually the few
 * rows the reader wanted. The implementation provider returns only those.
 *
 * Like the definition provider, this one may answer with LocationLink[] rather
 * than the Location[] its type claims, so it goes through formatLocationResults.
 */
export function makeFindImplementationsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: '__code_intel_find_implementations',
        description:
          'Find the implementations of the interface, abstract class, or abstract method at the ' +
          'given position (max 50). Prefer this over the references operation when you want the ' +
          'concrete types implementing something rather than every call site.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path (absolute or workspace-relative).' },
            line: { type: 'integer', description: 'Zero-based line number.' },
            character: { type: 'integer', description: 'Zero-based character offset.' },
          },
          required: ['path', 'line', 'character'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args) => {
      const displayPath = args['path'] as string;
      const uri = await openForAnalysis(displayPath);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      const description = await describePosition(uri, position, displayPath);
      if (!description.word) return noSymbolMessage(description, position);
      await primeSymbolAtPosition(uri, position);
      const result = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink> | undefined
      >('vscode.executeImplementationProvider', uri, position);
      if (!result?.length) return noProviderAnswer('implementations', description);
      return formatLocationResults(result.slice(0, 50));
    },
  };
}
