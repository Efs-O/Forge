import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolves a path and makes sure the language service has actually seen it.
 *
 * VS Code's language servers analyse open documents. A file the user has never
 * opened may have no symbols, no hover and no definitions — not because the
 * code lacks them, but because nothing asked for the file to be parsed. That
 * reads as a broken tool: measured on a real run, `get_document_symbols` on a
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

function severityLabel(s: vscode.DiagnosticSeverity): string {
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
 * "Cannot read properties of undefined (reading 'start')" and go_to_definition
 * failed on every JS file. `find_references` was unaffected because the
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

// ── get_diagnostics ───────────────────────────────────────────────────────────

export function makeGetDiagnosticsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_diagnostics',
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
          const rel = vscode.workspace.asRelativePath(uri);
          lines.push(
            `${rel}:${d.range.start.line + 1}: ${severityLabel(d.severity)}: ${d.message}`,
          );
        }
      }
      return lines.length ? lines.join('\n') : 'No diagnostics found.';
    },
  };
}

// ── get_document_symbols ──────────────────────────────────────────────────────

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
        name: 'get_document_symbols',
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

// ── get_workspace_symbols ─────────────────────────────────────────────────────

export function makeGetWorkspaceSymbolsTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_workspace_symbols',
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

// ── get_hover ─────────────────────────────────────────────────────────────────

export function makeGetHoverTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'get_hover',
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
      const result = await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
        'vscode.executeHoverProvider',
        uri,
        position,
      );
      if (!result?.length) return 'No hover information available.';
      const parts: string[] = [];
      for (const hover of result) {
        for (const content of hover.contents) {
          if (typeof content === 'string') {
            parts.push(content);
          } else if ('value' in content) {
            parts.push(content.value);
          }
        }
      }
      return parts.join('\n\n') || 'No hover content.';
    },
  };
}

// ── go_to_definition ──────────────────────────────────────────────────────────

export function makeGoToDefinitionTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'go_to_definition',
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
      const result = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink> | undefined
      >('vscode.executeDefinitionProvider', uri, position);
      if (!result?.length) return 'No definition found.';
      return result.map(locationToString).join('\n');
    },
  };
}

// ── find_references ───────────────────────────────────────────────────────────

export function makeFindReferencesTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'find_references',
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
      const result = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
        'vscode.executeReferenceProvider',
        uri,
        position,
      );
      if (!result?.length) return 'No references found.';
      return result.slice(0, 50).map(locationToString).join('\n');
    },
  };
}

// ── find_implementations ──────────────────────────────────────────────────────

/**
 * "Who implements this?" — the question find_references answers badly.
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
        name: 'find_implementations',
        description:
          'Find the implementations of the interface, abstract class, or abstract method at the ' +
          'given position (max 50). Prefer this over find_references when you want the concrete ' +
          'types implementing something rather than every call site.',
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
      const result = await vscode.commands.executeCommand<
        Array<vscode.Location | vscode.LocationLink> | undefined
      >('vscode.executeImplementationProvider', uri, position);
      if (!result?.length) return 'No implementations found.';
      return result.slice(0, 50).map(locationToString).join('\n');
    },
  };
}
