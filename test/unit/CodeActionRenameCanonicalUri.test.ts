import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const canonicalUri = { scheme: 'file', fsPath: 'N:\\workspace\\canonical.ts', toString: () => 'file:///N:/workspace/canonical.ts' };
  return {
    canonicalUri,
    openTextDocument: vi.fn(),
    textDocuments: [] as Array<{ uri: typeof canonicalUri }>,
    getDiagnostics: vi.fn(),
    onDidChangeDiagnostics: vi.fn(),
    diagnosticListener: undefined as ((event: { uris: Array<{ toString(): string }> }) => void) | undefined,
    disposeDiagnosticsListener: vi.fn(),
    executeCommand: vi.fn(),
    applyAndSaveWorkspaceEdit: vi.fn(),
    describePosition: vi.fn(),
    primeSymbolAtPosition: vi.fn(async () => ({ name: 'sumPricesC1', files: [] })),
    remainingSymbolFiles: vi.fn(async () => []),
  };
});

vi.mock('vscode', () => {
  class Position {
    constructor(readonly line: number, readonly character: number) {}
  }
  class Range {
    constructor(readonly start: Position, readonly end: Position) {}
  }
  class Uri {
    static file(fsPath: string) {
      return { scheme: 'file', fsPath, toString: () => `file://${fsPath}` };
    }
  }
  return {
    Position,
    Range,
    Uri,
    workspace: { openTextDocument: mocks.openTextDocument, textDocuments: mocks.textDocuments },
    commands: { executeCommand: mocks.executeCommand },
    languages: {
      getDiagnostics: mocks.getDiagnostics,
      onDidChangeDiagnostics: mocks.onDidChangeDiagnostics,
    },
  };
});

vi.mock('../../src/util/WorkspacePaths', () => ({
  resolveWorkspaceUri: (_path: string) => mocks.canonicalUri,
  resolveRealWorkspacePath: async (path: string) => `N:\\workspace\\${path}`,
}));

vi.mock('../../src/tools/workspaceEditApply', () => ({
  applyAndSaveWorkspaceEdit: mocks.applyAndSaveWorkspaceEdit,
}));

vi.mock('../../src/sidebar/approvalKeyGrammar', () => ({ commonFolderOf: vi.fn() }));
vi.mock('../../src/tools/trashRefusal', () => ({
  diagnoseTrashRefusal: vi.fn(),
  forgetTrashRefusal: vi.fn(),
  rememberTrashRefusal: vi.fn(),
}));
vi.mock('../../src/tools/lspTools', () => ({
  makeFindImplementationsTool: () => ({ handler: vi.fn() }),
  makeFindReferencesTool: () => ({ handler: vi.fn() }),
  makeGetDiagnosticsTool: () => ({ handler: vi.fn() }),
  makeGetDocumentSymbolsTool: () => ({ handler: vi.fn() }),
  makeGetHoverTool: () => ({ handler: vi.fn() }),
  makeGetWorkspaceSymbolsTool: () => ({ handler: vi.fn() }),
  makeGoToDefinitionTool: () => ({ handler: vi.fn() }),
}));
vi.mock('../../src/tools/symbolSearch', () => ({
  describePosition: mocks.describePosition,
  primeSymbolAtPosition: mocks.primeSymbolAtPosition,
  remainingSymbolFiles: mocks.remainingSymbolFiles,
}));

import * as vscode from 'vscode';
import { makeApplyCodeActionTool } from '../../src/tools/codeActionTools';
import { makeCodeIntelTool } from '../../src/tools/codeIntelTool';
import { makeRenameSymbolTool } from '../../src/tools/fileEditTools';

const errorFrom = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => '',
    (error: Error) => error.message,
  );

describe('language-service tools pass the opened document URI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openTextDocument.mockImplementation(async (uri: unknown) => ({ uri }));
    mocks.textDocuments.splice(0, mocks.textDocuments.length, { uri: mocks.canonicalUri });
    mocks.getDiagnostics.mockReturnValue([]);
    mocks.onDidChangeDiagnostics.mockImplementation((listener: typeof mocks.diagnosticListener) => {
      mocks.diagnosticListener = listener ?? undefined;
      return { dispose: mocks.disposeDiagnosticsListener };
    });
    mocks.executeCommand.mockResolvedValue(undefined);
    mocks.applyAndSaveWorkspaceEdit.mockResolvedValue(undefined);
    mocks.describePosition.mockImplementation(async (_uri, position, displayPath) => ({
      word: 'sumPricesC1',
      lineText: 'export function sumPricesC1(items: number[]): number {',
      label: `${displayPath} line ${position.line} character ${position.character} (zero-based)`,
      lineCount: 4,
    }));
  });

  it('calls the code action provider with the canonical document URI and a zero-width range', async () => {
    mocks.openTextDocument.mockResolvedValue({ uri: mocks.canonicalUri });
    mocks.executeCommand.mockResolvedValue([{ title: 'Fix typo' }]);

    await expect(
      makeCodeIntelTool().handler({ operation: 'code_actions', path: 'src/file.ts', line: 0, character: 16 }),
    ).resolves.toBe('{"actions":[{"title":"Fix typo","has_edit":false}]}');
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.executeCodeActionProvider',
      mocks.canonicalUri,
      new vscode.Range(new vscode.Position(0, 16), new vscode.Position(0, 16)),
    );
  });

  it('reports the complete actionable code action error', async () => {
    mocks.openTextDocument.mockResolvedValue({ uri: mocks.canonicalUri });
    mocks.executeCommand.mockRejectedValue(new Error('Illegal argument'));

    expect(
      await errorFrom(
        makeCodeIntelTool().handler({ operation: 'code_actions', path: 'src/file.ts', line: 0, character: 16 }),
      ),
    ).toBe(
      'code_intel code_actions failed at src/file.ts:0:16 (zero-based): VS Code said "Illegal argument". Check the position is on code (read_file the line), or use code_intel diagnostics to see what the language server reports for this file.',
    );
  });

  it('waits for diagnostics on a cold file before requesting code actions', async () => {
    mocks.textDocuments.splice(0);
    mocks.getDiagnostics.mockReturnValue([]);
    mocks.executeCommand.mockResolvedValue([{ title: 'Add declaration' }]);
    const request = makeCodeIntelTool().handler({
      operation: 'code_actions',
      path: 'src/file.ts',
      line: 0,
      character: 16,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    mocks.diagnosticListener?.({ uris: [{ toString: () => 'file:///other.ts' }] });
    expect(mocks.executeCommand).not.toHaveBeenCalled();
    mocks.diagnosticListener?.({ uris: [mocks.canonicalUri] });

    await expect(request).resolves.toBe('{"actions":[{"title":"Add declaration","has_edit":false}]}');
    expect(mocks.executeCommand).toHaveBeenCalledOnce();
    expect(mocks.disposeDiagnosticsListener).toHaveBeenCalledOnce();
  });

  it('adds the cold-file note after diagnostics wait timeout and disposes the listener', async () => {
    vi.useFakeTimers();
    try {
      mocks.textDocuments.splice(0);
      mocks.getDiagnostics.mockReturnValue([]);
      mocks.executeCommand.mockResolvedValue([{ title: 'Move to file' }]);
      const request = makeCodeIntelTool().handler({
        operation: 'code_actions',
        path: 'src/file.ts',
        line: 0,
        character: 16,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(mocks.executeCommand).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(request).resolves.toBe(
        '{"actions":[{"title":"Move to file","has_edit":false}],"note":"No problems are reported for this file yet, so quick fixes (such as adding a missing import) may be missing. If you expect one, open_file the file and ask again."}',
      );
      expect(mocks.disposeDiagnosticsListener).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait or add a note for an already-open file', async () => {
    mocks.executeCommand.mockResolvedValue([{ title: 'Fix typo' }]);

    await expect(
      makeCodeIntelTool().handler({
        operation: 'code_actions',
        path: 'src/file.ts',
        line: 0,
        character: 16,
      }),
    ).resolves.toBe('{"actions":[{"title":"Fix typo","has_edit":false}]}');
    expect(mocks.onDidChangeDiagnostics).not.toHaveBeenCalled();
  });

  it('lists only applicable titles in provider order when an apply title is unmatched', async () => {
    mocks.executeCommand.mockResolvedValue([
      { title: 'First fix', edit: {} },
      { title: 'Disabled fix', edit: {}, disabled: { reason: 'Unavailable' } },
      { title: 'Run command', edit: {}, command: { command: 'extension.run' } },
      { title: 'Second fix', edit: {} },
      { title: 'First fix', edit: {} },
    ]);

    await expect(
      errorFrom(
        makeApplyCodeActionTool().handler(
          { path: 'src/file.ts', line: 3, character: 4, title: 'Guessed title' },
          { beforeMutate: vi.fn() },
        ),
      ),
    ).resolves.toBe(
      'apply_code_action: no current action titled "Guessed title" at src/file.ts:3:4 (zero-based). Actions it can apply there now: "First fix", "Second fix". Pass one of these titles exactly, or make the change with edit_file.',
    );
  });

  it('names the empty actionable set when an apply title is unmatched', async () => {
    mocks.executeCommand.mockResolvedValue([
      { title: 'Disabled fix', edit: {}, disabled: { reason: 'Unavailable' } },
      { title: 'Run command', command: { command: 'extension.run' } },
    ]);

    await expect(
      errorFrom(
        makeApplyCodeActionTool().handler(
          { path: 'src/file.ts', line: 3, character: 4, title: 'Guessed title' },
          { beforeMutate: vi.fn() },
        ),
      ),
    ).resolves.toBe(
      'apply_code_action: no current action titled "Guessed title" at src/file.ts:3:4 (zero-based), and no action it can apply is offered there now. Make the change with edit_file.',
    );
  });

  it('preserves the refusal for disabled and command-backed matching actions', async () => {
    const tool = makeApplyCodeActionTool();
    mocks.executeCommand.mockResolvedValue([
      { title: 'Disabled fix', disabled: { reason: 'Unavailable' } },
    ]);
    await expect(
      errorFrom(
        tool.handler(
          { path: 'src/file.ts', line: 3, character: 4, title: 'Disabled fix' },
          { beforeMutate: vi.fn() },
        ),
      ),
    ).resolves.toBe('apply_code_action: Unavailable');

    mocks.executeCommand.mockResolvedValue([
      { title: 'Run command', edit: {}, command: { command: 'extension.run' } },
    ]);
    await expect(
      errorFrom(
        tool.handler(
          { path: 'src/file.ts', line: 3, character: 4, title: 'Run command' },
          { beforeMutate: vi.fn() },
        ),
      ),
    ).resolves.toBe('apply_code_action: this action is not a workspace-edit-only action.');
  });

  it('applies a matching workspace-edit action', async () => {
    mocks.executeCommand.mockResolvedValue([{ title: 'Apply fix', edit: {} }]);

    await expect(
      makeApplyCodeActionTool().handler(
        { path: 'src/file.ts', line: 3, character: 4, title: 'Apply fix' },
        { beforeMutate: vi.fn() },
      ),
    ).resolves.toBe('Applied code action: Apply fix');
    expect(mocks.applyAndSaveWorkspaceEdit).toHaveBeenCalledOnce();
  });

  it('calls the rename provider with the canonical document URI and succeeds', async () => {
    const edit = { entries: () => [] };
    mocks.openTextDocument.mockResolvedValue({ uri: mocks.canonicalUri });
    mocks.executeCommand.mockResolvedValue(edit);

    await expect(
      makeRenameSymbolTool().handler(
        { path: 'src/file.ts', line: 0, character: 16, new_name: 'renamedThing' },
        { beforeMutate: vi.fn() },
      ),
    ).resolves.toBe('Renamed to renamedThing');
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.executeDocumentRenameProvider',
      mocks.canonicalUri,
      new vscode.Position(0, 16),
      'renamedThing',
    );
  });

  it('renames the fixture symbol at line 1 character 16', async () => {
    const edit = { entries: () => [] };
    mocks.openTextDocument.mockResolvedValue({ uri: mocks.canonicalUri });
    mocks.executeCommand.mockResolvedValue(edit);

    await expect(
      makeRenameSymbolTool().handler(
        { path: 'src/file.ts', line: 1, character: 16, new_name: 'sumPricesNew' },
        { beforeMutate: vi.fn() },
      ),
    ).resolves.toBe('Renamed to sumPricesNew');
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      'vscode.executeDocumentRenameProvider',
      mocks.canonicalUri,
      new vscode.Position(1, 16),
      'sumPricesNew',
    );
  });

  it('refuses a position with no symbol before calling the rename provider', async () => {
    mocks.describePosition.mockResolvedValue({
      lineText: '// Lab fixture s15c-r1 - do not delete.',
      label: 'src/file.ts line 0 character 0 (zero-based)',
      lineCount: 4,
    });

    expect(
      await errorFrom(
        makeRenameSymbolTool().handler(
          { path: 'src/file.ts', line: 0, character: 0, new_name: 'sumPricesNew' },
          { beforeMutate: vi.fn() },
        ),
      ),
    ).toBe(
      "rename_symbol: No symbol at src/file.ts line 0 character 0 (zero-based). That line reads: `// Lab fixture s15c-r1 - do not delete.`. Point line and character at the symbol's name. The first line of a file is line 0; document_symbols lists each symbol's zero-based line and character.",
    );
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('reports the complete actionable rename error', async () => {
    mocks.openTextDocument.mockResolvedValue({ uri: mocks.canonicalUri });
    mocks.executeCommand.mockRejectedValue(new Error('Unexpected type'));

    expect(
      await errorFrom(
        makeRenameSymbolTool().handler(
          { path: 'src/file.ts', line: 0, character: 16, new_name: 'renamedThing' },
          { beforeMutate: vi.fn() },
        ),
      ),
    ).toBe(
      "rename_symbol failed at src/file.ts:0:16 (zero-based): VS Code said \"Unexpected type\". Check the position is on the symbol's name (code_intel definition at the same position should find it).",
    );
  });
});
