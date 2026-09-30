import type { RegisteredTool } from './ToolRegistry';
import {
  makeFindImplementationsTool,
  makeFindReferencesTool,
  makeGetDiagnosticsTool,
  makeGetDocumentSymbolsTool,
  makeGetHoverTool,
  makeGetWorkspaceSymbolsTool,
  makeGoToDefinitionTool,
} from './lspTools';
import { getCodeActions } from './codeActionTools';

type Operation =
  | 'diagnostics'
  | 'document_symbols'
  | 'workspace_symbols'
  | 'hover'
  | 'definition'
  | 'references'
  | 'implementations'
  | 'code_actions';

const handlers: Record<Operation, RegisteredTool['handler']> = {
  diagnostics: makeGetDiagnosticsTool().handler,
  document_symbols: makeGetDocumentSymbolsTool().handler,
  workspace_symbols: makeGetWorkspaceSymbolsTool().handler,
  hover: makeGetHoverTool().handler,
  definition: makeGoToDefinitionTool().handler,
  references: makeFindReferencesTool().handler,
  implementations: makeFindImplementationsTool().handler,
  code_actions: async (args) => getCodeActions(args),
};

function validateRequired(operation: Operation, args: Record<string, unknown>): void {
  const required =
    operation === 'document_symbols'
      ? ['path']
      : operation === 'workspace_symbols'
        ? ['query']
        : ['hover', 'definition', 'references', 'implementations', 'code_actions'].includes(
              operation,
            )
          ? ['path', 'line', 'character']
          : [];
  const missing = required.filter((key) => args[key] === undefined || args[key] === null);
  if (!missing.length) return;
  const params =
    missing.length === 2 && missing[0] === 'line' && missing[1] === 'character'
      ? 'line and character'
      : missing.join(', ');
  throw new Error(`code_intel operation "${operation}" needs ${params}`);
}

export function makeCodeIntelTool(): RegisteredTool {
  return {
    definition: {
      type: 'function',
      function: {
        name: 'code_intel',
        description: [
          'Run one VS Code language service operation.',
          'diagnostics: Get language diagnostics (errors, warnings) for a file or the whole workspace. (needs: path?)',
          'document_symbols: List all symbols (functions, classes, variables, etc.) in a file as an indented tree. (needs: path)',
          'workspace_symbols: Search for symbols by name across the entire workspace. (needs: query)',
          'hover: Get hover information (type info, docs) at a specific position in a file. (needs: path, line, character)',
          'definition: Find the definition location(s) of the symbol at the given position. (needs: path, line, character)',
          'references: Find all references to the symbol at the given position (max 50). (needs: path, line, character)',
          'implementations: Find the implementations of the interface, abstract class, or abstract method at the given position (max 50). Prefer this over the references operation when you want the concrete types implementing something rather than every call site. (needs: path, line, character)',
          'code_actions: List available LSP code actions at a zero-based position in a file. (needs: path, line, character)',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: [
                'diagnostics',
                'document_symbols',
                'workspace_symbols',
                'hover',
                'definition',
                'references',
                'implementations',
                'code_actions',
              ],
              description: 'Which code intelligence operation to run.',
            },
            path: {
              type: 'string',
              description:
                'diagnostics: File path (absolute or workspace-relative). Omit for all workspace diagnostics. document_symbols, hover, definition, references, implementations: File path (absolute or workspace-relative). code_actions: File path, absolute or workspace-relative. Relative paths resolve against the first workspace folder; the repo you are working in may be nested inside it.',
            },
            line: { type: 'integer', minimum: 0, description: 'Zero-based line number.' },
            character: { type: 'integer', minimum: 0, description: 'Zero-based character offset.' },
            query: { type: 'string', description: 'Symbol name query.' },
          },
          required: ['operation'],
          additionalProperties: false,
        },
      },
    },
    permission: 'read',
    handler: async (args, context) => {
      const operation = args['operation'] as Operation;
      validateRequired(operation, args);
      return handlers[operation](args, context);
    },
  };
}
