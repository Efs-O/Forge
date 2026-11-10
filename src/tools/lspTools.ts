import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';
import { primeSymbolAtPosition } from './symbolSearch';

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
 * in an editor, which is what primes the provider.
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

function symbolKindLabel(k: vscode.SymbolKind): string {
  return vscode.SymbolKind[k] ?? String(k);
}

/**
 * Renders either shape a definition/reference provider can return.
 *
 * `executeDefinitionProvider` is typed as returning `Location[]`, but VS Code
 * lets a provider answer with `LocationLink[]` instead — and the JavaScript/
 * TypeScript server does. Those carry `targetUri`/`targetRange` and no `range`
 * at all, so reading `loc.range.start` threw
 * "Cannot read properties of undefined (reading 'start')" and definition lookup
 * failed on every JS file. The references handler was unaffected because the
 * references provider does return plain Locations.
 */
function locationToString(loc: vscode.Location | vscode.LocationLink): string {
  const link = loc as vscode.LocationLink;
  const plain = loc as vscode.Location;
  const uri = link.targetUri ?? plain.uri;
  const range = link.targetSelectionRange ?? link.targetRange ?? plain.range;
  if (!uri || !range) return '(location unavailable)';
  return `${vscode.workspace.asRelativePath(uri)}:${range.start.line + 1}:${range.start.character + 1}`;
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
    ? `\n\nNote: a text search also finds \`${name}\` in ${missing.length} file(s) the language server did not report: ${missing.join(', ')}. The language server may still be loading this project; ask again in a few seconds, or check those files with search_code.`
    : '';
}

const HOVER_LOADING_NOTE =
  '\n\nNote: `(loading...)` means the language server has not finished loading this project, so this answer may lack types. Ask again in a few seconds.';

function hoverText(result: vscode.Hover[] | undefined): string {
  if (!result?.length) return 'No hover information available.';
  const parts: string[] = [];
  for (const hover of result) {
    for (const content of hover.contents) {
      if (typeof content === 'string') parts.push(content);
      else if ('value' in content) parts.push(content.value);
    }
  }
  return parts.join('\n\n') || 'No hover content.';
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
          'Get language diagnostics (errors, warnings) for a file or the whole workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'File path (absolute or workspace-relative). Omit for all workspace diagnostics.',
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
      if (p) {
        const uri = resolveWorkspaceUri(p);
        pairs = [[uri, vscode.languages.getDiagnostics(uri)]];
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
      return lines.length ? lines.join('\n') : 'No diagnostics found.';
    },
  };
}

// ── Document symbols handler ───────────────────────────────────────────────────

function formatSymbolTree(symbols: vscode.DocumentSymbol[], indent = 0): string[] {
  const lines: string[] = [];
  for (const sym of symbols) {
    lines.push(
      `${'  '.repeat(indent)}${symbolKindLabel(sym.kind)} ${sym.name} (line ${sym.range.start.line + 1})`,
    );
    if (sym.children?.length) {
      lines.push(...formatSymbolTree(sym.children, indent + 1));
    }
  }
  return lines;
}

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
      if (!result?.length) return 'No symbols found.';
      return formatSymbolTree(result).join('\n');
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
      if (!result?.length) return 'No symbols found.';
      return result
        .map(
          (s) =>
            `${symbolKindLabel(s.kind)} ${s.name} — ${vscode.workspace.asRelativePath(s.location.uri)}:${s.location.range.start.line + 1}`,
        )
        .join('\n');
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
      const uri = await openForAnalysis(args['path'] as string);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      return hoverWithLoadingRetry(uri, position);
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
      const uri = await openForAnalysis(args['path'] as string);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      await primeSymbolAtPosition(uri, position);
      const result = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink> | undefined
      >('vscode.executeDefinitionProvider', uri, position);
      if (!result?.length) return 'No definition found.';
      return result.map(locationToString).join('\n');
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
      const uri = await openForAnalysis(args['path'] as string);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      const primed = await primeSymbolAtPosition(uri, position);
      const result = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        'vscode.executeReferenceProvider',
        uri,
        position,
      );
      const answer = result?.length
        ? result.slice(0, 50).map(locationToString).join('\n')
        : 'No references found.';
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
 * than the Location[] its type claims, so it goes through locationToString.
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
      const uri = await openForAnalysis(args['path'] as string);
      const position = new vscode.Position(args['line'] as number, args['character'] as number);
      await primeSymbolAtPosition(uri, position);
      const result = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink> | undefined
      >('vscode.executeImplementationProvider', uri, position);
      if (!result?.length) return 'No implementations found.';
      return result.slice(0, 50).map(locationToString).join('\n');
    },
  };
}
