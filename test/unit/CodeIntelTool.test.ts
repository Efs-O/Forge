import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openTextDocument: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock('vscode', () => ({
  Position: class Position {
    constructor(readonly line: number, readonly character: number) {}
  },
  workspace: {
    openTextDocument: mocks.openTextDocument,
    asRelativePath: (uri: { fsPath: string }) => uri.fsPath.replace('N:/workspace/', ''),
  },
  commands: { executeCommand: mocks.executeCommand },
  SymbolKind: { 11: 'Function' },
}));

vi.mock('../../src/util/WorkspacePaths', () => ({
  resolveWorkspaceUri: (file: string) => ({ fsPath: `N:/workspace/${file}` }),
}));

vi.mock('../../src/tools/symbolSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/symbolSearch')>();
  return {
    ...actual,
    primeSymbolAtPosition: vi.fn(async (uri, position) => {
      const description = await actual.describePosition(uri, position, '');
      return { ...(description.word ? { name: description.word } : {}), files: [] };
    }),
  };
});
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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.executeCommand.mockResolvedValue(undefined);
    mocks.openTextDocument.mockImplementation(async () => sourceDocument(positionFixture));
  });

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
      expect(merged).toContain(description);
    }
  });

  it('keeps the read permission every replaced read tool had (no approval)', () => {
    const tool = makeCodeIntelTool();
    expect(tool.permission).toBe('read');
    // ToolDispatch asks only for write/delete/terminal/headless/git-write permissions.
    // Each replaced read tool used a non-writing permission and required no approval.
    expect(['write', 'delete', 'terminal', 'headless', 'git-write']).not.toContain(tool.permission);
  });

  it('describes line input as zero-based', () => {
    expect(makeCodeIntelTool().definition.function.parameters.properties['line'].description).toBe(
      'Zero-based line number (the first line of the file is 0).',
    );
  });

  it('explains a position on punctuation without calling the provider', async () => {
    await expect(
      makeCodeIntelTool().handler({ operation: 'references', path: 'fixture.ts', line: 0, character: 0 }),
    ).resolves.toBe(
      "No symbol at fixture.ts line 0 character 0 (zero-based). That line reads: `// Lab fixture s15c-r1 - do not delete.`. Point line and character at the symbol's name. The first line of a file is line 0; document_symbols lists each symbol's zero-based line and character.",
    );
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('describes positions beyond the file line count', async () => {
    await expect(
      makeCodeIntelTool().handler({ operation: 'references', path: 'fixture.ts', line: 9, character: 0 }),
    ).resolves.toBe(
      'No symbol at fixture.ts line 9 character 0 (zero-based): the file has 4 lines, numbered 0 to 3.',
    );
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it.each([
    [0, 3, 'Lab'],
    [1, 27, 'sumPricesC1'],
  ])('names the selected word %s:%s when references are empty', async (line, character, word) => {
    await expect(
      makeCodeIntelTool().handler({ operation: 'references', path: 'fixture.ts', line, character }),
    ).resolves.toBe(
      `No references found for \`${word}\` at fixture.ts line ${line} character ${character} (zero-based). That line reads: \`${line === 0 ? '// Lab fixture s15c-r1 - do not delete.' : 'export function sumPricesC1(items: number[]): number {'}\`. If \`${word}\` is not the symbol you meant (for example a word in a comment or a string), point line and character at the symbol's name.`,
    );
    expect(mocks.executeCommand).toHaveBeenCalledExactlyOnceWith(
      'vscode.executeReferenceProvider',
      { fsPath: 'N:/workspace/fixture.ts' },
      expect.objectContaining({ line, character }),
    );
  });

  it.each([
    ['hover', 'hover information'],
    ['definition', 'definition'],
    ['implementations', 'implementations'],
  ] as const)('explains an empty %s result for the selected identifier', async (operation, kind) => {
    await expect(
      makeCodeIntelTool().handler({ operation, path: 'fixture.ts', line: 1, character: 16 }),
    ).resolves.toBe(
      `No ${kind} found for \`sumPricesC1\` at fixture.ts line 1 character 16 (zero-based). That line reads: \`export function sumPricesC1(items: number[]): number {\`. If \`sumPricesC1\` is not the symbol you meant (for example a word in a comment or a string), point line and character at the symbol's name.`,
    );
  });

  it('explains empty hover content with the selected identifier', async () => {
    mocks.executeCommand.mockResolvedValue([{ contents: [] }]);
    await expect(
      makeCodeIntelTool().handler({ operation: 'hover', path: 'fixture.ts', line: 1, character: 16 }),
    ).resolves.toBe(
      "No hover information found for `sumPricesC1` at fixture.ts line 1 character 16 (zero-based). That line reads: `export function sumPricesC1(items: number[]): number {`. If `sumPricesC1` is not the symbol you meant (for example a word in a comment or a string), point line and character at the symbol's name.",
    );
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

const positionFixture =
  '// Lab fixture s15c-r1 - do not delete.\n' +
  'export function sumPricesC1(items: number[]): number {\n' +
  '  return items.reduce((total, item) => total + item, 0);\n' +
  '}';

function sourceDocument(text: string) {
  const lines = text.split('\n');
  return {
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
    getWordRangeAtPosition: (position: { line: number; character: number }) => {
      const sourceLine = lines[position.line] ?? '';
      const matches = [...sourceLine.matchAll(/[\p{L}\p{N}_$]+/gu)];
      const match = matches.find((word) => {
        const start = word.index ?? 0;
        return start <= position.character && position.character < start + word[0].length;
      }) ?? matches.find((word) => (word.index ?? 0) + word[0].length === position.character);
      if (!match) return undefined;
      const start = match.index ?? 0;
      return {
        start: { line: position.line, character: start },
        end: { line: position.line, character: start + match[0].length },
      };
    },
    getText: (range: { start: { line: number; character: number }; end: { character: number } }) =>
      (lines[range.start.line] ?? '').slice(range.start.character, range.end.character),
  };
}
