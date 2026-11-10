import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const canonicalUri = { scheme: 'file', fsPath: 'N:\\workspace\\canonical.ts', toString: () => 'file:///N:/workspace/canonical.ts' };
  return {
    canonicalUri,
    openTextDocument: vi.fn(),
    executeCommand: vi.fn(),
    applyAndSaveWorkspaceEdit: vi.fn(),
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
    workspace: { openTextDocument: mocks.openTextDocument },
    commands: { executeCommand: mocks.executeCommand },
  };
});

vi.mock('../../src/util/WorkspacePaths', () => ({
  resolveWorkspaceUri: (path: string) => ({ scheme: 'file', fsPath: path }),
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
  primeSymbolAtPosition: vi.fn(async () => ({ files: [] })),
  remainingSymbolFiles: vi.fn(async () => []),
}));

import * as vscode from 'vscode';
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
    mocks.executeCommand.mockResolvedValue(undefined);
    mocks.applyAndSaveWorkspaceEdit.mockResolvedValue(undefined);
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
