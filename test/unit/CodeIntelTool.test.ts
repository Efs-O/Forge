import { describe, expect, it } from 'vitest';
import { makeCodeIntelTool } from '../../src/tools/codeIntelTool';
import {
  makeFindImplementationsTool,
  makeFindReferencesTool,
  makeGetDiagnosticsTool,
  makeGetDocumentSymbolsTool,
  makeGetHoverTool,
  makeGetWorkspaceSymbolsTool,
  makeGoToDefinitionTool,
} from '../../src/tools/lspTools';

const operations = [
  'diagnostics',
  'document_symbols',
  'workspace_symbols',
  'hover',
  'definition',
  'references',
  'implementations',
  'code_actions',
] as const;

describe('code_intel', () => {
  it('advertises one strict operation-enum schema', () => {
    const schema = makeCodeIntelTool().definition.function.parameters;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['operation']);
    expect(schema.properties['operation'].enum).toEqual(operations);
  });

  it('retains each replaced LSP description verbatim', () => {
    const merged = makeCodeIntelTool().definition.function.description;
    const oldDescriptions = [
      makeGetDiagnosticsTool(),
      makeGetDocumentSymbolsTool(),
      makeGetWorkspaceSymbolsTool(),
      makeGetHoverTool(),
      makeGoToDefinitionTool(),
      makeFindReferencesTool(),
      makeFindImplementationsTool(),
    ].map((tool) => tool.definition.function.description);
    oldDescriptions.push('List available LSP code actions at a zero-based position in a file.');
    for (const description of oldDescriptions) {
      expect(merged).toContain(
        description.replace(
          'Prefer this over find_references',
          'Prefer this over the references operation',
        ),
      );
    }
  });

  it.each(operations)('%s retains the old read auto-approval behavior', (operation) => {
    const tool = makeCodeIntelTool();
    expect(tool.permission).toBe('read');
    // ToolDispatch asks only for write/delete/terminal/headless/git-write permissions.
    // Each replaced read tool used a non-writing permission and required no approval.
    expect(['write', 'delete', 'terminal', 'headless', 'git-write']).not.toContain(tool.permission);
    expect(operation).toBeDefined();
  });

  it.each([
    ['document_symbols', {}, 'path'],
    ['workspace_symbols', {}, 'query'],
    ['hover', { path: 'a.ts' }, 'line and character'],
    ['definition', { path: 'a.ts' }, 'line and character'],
    ['references', { path: 'a.ts' }, 'line and character'],
    ['implementations', { path: 'a.ts' }, 'line and character'],
    ['code_actions', { path: 'a.ts' }, 'line and character'],
  ] as const)('names missing %s parameters and operation', async (operation, args, missing) => {
    await expect(makeCodeIntelTool().handler({ operation, ...args })).rejects.toThrow(
      `code_intel operation "${operation}" needs ${missing}`,
    );
  });
});
