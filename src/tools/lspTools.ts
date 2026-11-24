import * as vscode from 'vscode';
import type { RegisteredTool } from './ToolRegistry';
import { resolveWorkspaceUri } from '../util/WorkspacePaths';
import { formatSymbolTree, formatWorkspaceSymbols, POSITION_NOTE } from './lspFormat';

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
export async function openForAnalysis(pathArg: string): Promise<vscode.Uri> {
  const uri = resolveWorkspaceUri(pathArg);
  try {
    await vscode.workspace.openTextDocument(uri);
  } catch {
    // Binary, deleted, or unreadable — let the provider call report the real
    // problem rather than failing here on a preparatory step.
  }
  return uri;
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
