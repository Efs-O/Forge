import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openTextDocument: vi.fn(),
  executeCommand: vi.fn(),
  getDiagnostics: vi.fn(),
  onDidChangeDiagnostics: vi.fn(),
  diagnosticListeners: [] as Array<(event: { uris: Array<{ toString(): string }> }) => void>,
  hostHasTabApi: false,
  tabs: [] as Array<{ input: { uri: { toString(): string } } }>,
  showTextDocument: vi.fn(),
  closeTab: vi.fn(),
}));

vi.mock('vscode', () => {
  class TabInputText {
    constructor(readonly uri: { toString(): string }) {}
  }
  return {
    Position: class Position {
      constructor(readonly line: number, readonly character: number) {}
    },
    TabInputText,
    ViewColumn: { Active: -1 },
    window: {
      get tabGroups() {
        return mocks.hostHasTabApi ? {
          get all() { return [{ tabs: mocks.tabs }]; },
          close: mocks.closeTab,
        } : undefined;
      },
      showTextDocument: mocks.showTextDocument,
    },
    workspace: {
      openTextDocument: mocks.openTextDocument,
      asRelativePath: (uri: { fsPath: string }) => uri.fsPath.replace('N:/workspace/', ''),
    },
    languages: {
      getDiagnostics: mocks.getDiagnostics,
      onDidChangeDiagnostics: mocks.onDidChangeDiagnostics,
    },
    commands: { executeCommand: mocks.executeCommand },
    SymbolKind: { 11: 'Function' },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  };
});

vi.mock('../../src/util/WorkspacePaths', () => ({
  resolveWorkspaceUri: (file: string) => {
    const uri = { fsPath: `N:/workspace/${file}` };
    Object.defineProperty(uri, 'toString', { value: () => `file:///N:/workspace/${file}` });
    return uri;
  },
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
import * as vscode from 'vscode';
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
    mocks.getDiagnostics.mockReturnValue([]);
    mocks.hostHasTabApi = false;
    mocks.tabs.splice(0);
    mocks.diagnosticListeners.splice(0);
    mocks.showTextDocument.mockImplementation(async (document: { uri: { toString(): string } }) => {
      const tab = { input: new (vscode.TabInputText as unknown as new (uri: { toString(): string }) => object)(document.uri) };
      mocks.tabs.push(tab as typeof mocks.tabs[number]);
      return { document };
    });
    mocks.openTextDocument.mockImplementation(async (uri: unknown) => ({ ...sourceDocument(positionFixture), uri, isDirty: false }));
    mocks.closeTab.mockClear();
    mocks.onDidChangeDiagnostics.mockImplementation(
      (listener: (event: { uris: Array<{ toString(): string }> }) => void) => {
        mocks.diagnosticListeners.push(listener);
        return {
          dispose: () => {
            mocks.diagnosticListeners = mocks.diagnosticListeners.filter(
              (entry) => entry !== listener,
            );
          },
        };
      },
    );
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

  it('explains which diagnostics a missing or explicit path checks', () => {
    expect(makeCodeIntelTool().definition.function.description).toContain(
      'diagnostics: Get language diagnostics. Without a path, reports only files open in the editor; with a path, checks that file even when closed. (needs: path?)',
    );
    expect(makeCodeIntelTool().definition.function.parameters.properties['path'].description).toBe(
      'diagnostics: File path (absolute or workspace-relative). Omit to report only files open in the editor; a path checks that file even when closed. Other operations: File path (absolute or workspace-relative). Relative paths resolve against the first workspace folder; the repo may be nested inside it.',
    );
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

  it('gives the exact path diagnostic timeout note after opening a tab', async () => {
    vi.useFakeTimers();
    try {
      mocks.hostHasTabApi = true;
      const request = makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'fixture.ts' });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(request).resolves.toBe(
        "No diagnostics reported for fixture.ts after Forge opened it in an editor tab and waited 4 s. If you expect errors, ask again in a few seconds or run the project's type checker with shell.",
      );
      expect(mocks.showTextDocument).toHaveBeenCalledOnce();
      expect(mocks.closeTab).toHaveBeenCalledWith(mocks.tabs[0], true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks a closed file when diagnostics are requested by path', async () => {
    mocks.hostHasTabApi = true;
    mocks.getDiagnostics.mockReturnValue([{
      range: { start: { line: 1 } },
      severity: vscode.DiagnosticSeverity.Warning,
      code: 'TS6133',
      message: 'Unused declaration',
    }]);
    await expect(
      makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'fixture.ts' }),
    ).resolves.toBe('fixture.ts:2: warning TS6133: Unused declaration');
    expect(mocks.showTextDocument).toHaveBeenCalledOnce();
    expect(mocks.closeTab).toHaveBeenCalledOnce();
  });

  it('waits for a fresh diagnostic event after a Forge edit before reading a cached set', async () => {
    const { markDiagnosticsPending } = await import('../../src/tools/editDiagnosticsSource');
    const uri = { fsPath: 'N:/workspace/fixture.ts', toString: () => 'file:///N:/workspace/fixture.ts' };
    mocks.hostHasTabApi = true;
    mocks.tabs.push({ input: new (vscode.TabInputText as unknown as new (uri: typeof uri) => object)(uri) as typeof mocks.tabs[number]['input'] });
    mocks.getDiagnostics.mockReturnValue([{
      range: { start: { line: 1 } },
      severity: vscode.DiagnosticSeverity.Error,
      code: 'TS2304',
      message: "Cannot find name 'sumPricesBX'",
    }]);
    markDiagnosticsPending(uri as never);

    const request = makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'fixture.ts' });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    mocks.getDiagnostics.mockReturnValue([]);
    for (const listener of [...mocks.diagnosticListeners]) listener({ uris: [uri] });

    await expect(request).resolves.toBe('No diagnostics found.');
  });

  it('does not wait for diagnostics on a README.md edit', async () => {
    vi.useFakeTimers();
    try {
      const { markDiagnosticsPending } = await import('../../src/tools/editDiagnosticsSource');
      const uri = { fsPath: 'N:/workspace/README.md', toString: () => 'file:///N:/workspace/README.md' };
      mocks.getDiagnostics.mockReturnValue([]);
      markDiagnosticsPending(uri as never);

      await expect(
        makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'README.md' }),
      ).resolves.toBe('No diagnostics found.');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns fresh diagnostics immediately when the check event arrived before the read', async () => {
    vi.useFakeTimers();
    try {
      const { markDiagnosticsPending } = await import('../../src/tools/editDiagnosticsSource');
      const uri = { fsPath: 'N:/workspace/fixture.ts', toString: () => 'file:///N:/workspace/fixture.ts' };
      mocks.getDiagnostics.mockReturnValue([{
        range: { start: { line: 1 } },
        severity: vscode.DiagnosticSeverity.Error,
        code: 'TS2304',
        message: "Cannot find name 'sumPricesBX'",
      }]);
      markDiagnosticsPending(uri as never);
      for (const listener of [...mocks.diagnosticListeners]) listener({ uris: [uri] });

      await expect(
        makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'fixture.ts' }),
      ).resolves.toBe("fixture.ts:2: error TS2304: Cannot find name 'sumPricesBX'");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns current diagnostics with a note after one fresh-check timeout, then clears the mark', async () => {
    vi.useFakeTimers();
    try {
      const { hasPendingDiagnostics, markDiagnosticsPending } = await import('../../src/tools/editDiagnosticsSource');
      const uri = { fsPath: 'N:/workspace/fixture.ts', toString: () => 'file:///N:/workspace/fixture.ts' };
      mocks.hostHasTabApi = true;
      mocks.tabs.push({ input: new (vscode.TabInputText as unknown as new (uri: typeof uri) => object)(uri) as typeof mocks.tabs[number]['input'] });
      mocks.getDiagnostics.mockReturnValue([{
        range: { start: { line: 1 } },
        severity: vscode.DiagnosticSeverity.Error,
        code: 'TS2304',
        message: "Cannot find name 'sumPricesBX'",
      }]);
      markDiagnosticsPending(uri as never);

      const request = makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'fixture.ts' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(request).resolves.toBe(
        "Note: VS Code reported no new check of fixture.ts in the 4 s after Forge's edit, so these diagnostics may predate it.\nfixture.ts:2: error TS2304: Cannot find name 'sumPricesBX'",
      );
      expect(hasPendingDiagnostics(uri as never)).toBe(false);
      mocks.getDiagnostics.mockReturnValue([]);
      await expect(
        makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'fixture.ts' }),
      ).resolves.toBe('No diagnostics found.');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads only the diagnostic pairs VS Code reports when no path is supplied', async () => {
    const uri = { fsPath: 'N:/workspace/open.ts', toString: () => 'file:///N:/workspace/open.ts' };
    mocks.getDiagnostics.mockReturnValue([[
      uri,
      [{
        range: { start: { line: 0 } },
        severity: vscode.DiagnosticSeverity.Error,
        code: 'TS2322',
        message: 'Type mismatch',
      }],
    ]]);
    await expect(makeCodeIntelTool().handler({ operation: 'diagnostics' })).resolves.toBe(
      'open.ts:1: error TS2322: Type mismatch',
    );
    expect(mocks.getDiagnostics).toHaveBeenCalledOnce();
    expect(mocks.getDiagnostics).toHaveBeenCalledWith();
  });

  it('formats existing path diagnostics and leaves an existing tab alone', async () => {
    mocks.hostHasTabApi = true;
    const uri = { toString: () => 'file:///N:/workspace/fixture.ts' };
    mocks.tabs.push({ input: new (vscode.TabInputText as unknown as new (uri: typeof uri) => object)(uri) as typeof mocks.tabs[number]['input'] });
    mocks.getDiagnostics.mockReturnValue([{
      range: { start: { line: 2 } },
      severity: vscode.DiagnosticSeverity.Error,
      code: 'TS2307',
      message: 'Cannot find module',
    }]);
    await expect(makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'fixture.ts' })).resolves.toBe(
      'fixture.ts:3: error TS2307: Cannot find module',
    );
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it('keeps the stub-host diagnostics behavior when tab APIs are absent', async () => {
    mocks.hostHasTabApi = false;
    await expect(makeCodeIntelTool().handler({ operation: 'diagnostics', path: 'fixture.ts' })).resolves.toBe(
      'No diagnostics found.',
    );
    expect(mocks.openTextDocument).toHaveBeenCalledOnce();
    expect(mocks.showTextDocument).not.toHaveBeenCalled();
    expect(mocks.closeTab).not.toHaveBeenCalled();
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
