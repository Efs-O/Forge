import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openTextDocument: vi.fn(),
  executeCommand: vi.fn(),
  primeSymbolAtPosition: vi.fn(),
  remainingSymbolFiles: vi.fn(),
  applyAndSaveWorkspaceEdit: vi.fn(),
}));

vi.mock('vscode', () => ({
  Position: class Position {
    constructor(readonly line: number, readonly character: number) {}
  },
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
  },
  workspace: {
    openTextDocument: mocks.openTextDocument,
    asRelativePath: (uri: { fsPath: string }) => uri.fsPath.replace('N:/workspace/', ''),
  },
  commands: { executeCommand: mocks.executeCommand },
}));

vi.mock('../../src/util/WorkspacePaths', () => ({
  resolveWorkspaceUri: (file: string) => ({ fsPath: `N:/workspace/${file}`, scheme: 'file' }),
  resolveRealWorkspacePath: async (file: string) => `N:/workspace/${file}`,
}));

vi.mock('../../src/tools/symbolSearch', () => ({
  primeSymbolAtPosition: mocks.primeSymbolAtPosition,
  remainingSymbolFiles: mocks.remainingSymbolFiles,
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

import { makeFindImplementationsTool, makeFindReferencesTool, makeGetHoverTool, makeGoToDefinitionTool } from '../../src/tools/lspTools';
import { makeRenameSymbolTool } from '../../src/tools/fileEditTools';

const baseArgs = { path: 'src/math.ts', line: 0, character: 12 };
const loading = '```typescript\n(loading...) function sumPricesR1(items: number[]): number\n```';

describe('language-server readiness reporting', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.openTextDocument.mockImplementation(async (uri: unknown) => ({ uri }));
    mocks.primeSymbolAtPosition.mockResolvedValue({ name: 'sumPricesR1', files: [] });
    mocks.remainingSymbolFiles.mockResolvedValue([]);
    mocks.applyAndSaveWorkspaceEdit.mockResolvedValue(undefined);
    mocks.executeCommand.mockResolvedValue(undefined);
  });

  it.each([makeGoToDefinitionTool, makeFindImplementationsTool])(
    'primes workspace files before %s asks its provider',
    async (factory) => {
      const order: string[] = [];
      mocks.primeSymbolAtPosition.mockImplementation(async () => {
        order.push('prime');
        return { name: 'sumPricesR1', files: [] };
      });
      mocks.executeCommand.mockImplementation(async () => {
        order.push('provider');
        return undefined;
      });
      await factory().handler(baseArgs);
      expect(order).toEqual(['prime', 'provider']);
    },
  );

  it('primes the identifier after whitespace for references at character 15', async () => {
    const { primeSymbolAtPosition } = await vi.importActual<
      typeof import('../../src/tools/symbolSearch')
    >('../../src/tools/symbolSearch');
    const text = 'export function sumPricesR1(items: number[]): number {';
    const rangeAt = (character: number) => {
      const words = [...text.matchAll(/[\p{L}\p{N}_$]+/gu)];
      const word = words.find((match) => {
        const start = match.index ?? 0;
        return start <= character && character < start + match[0].length;
      });
      if (!word) return undefined;
      const start = word.index ?? 0;
      return { start: { character: start }, end: { character: start + word[0].length } };
    };
    mocks.openTextDocument.mockResolvedValue({
      lineAt: () => ({ text }),
      getWordRangeAtPosition: (position: { character: number }) => rangeAt(position.character),
      getText: (range: { start: { character: number }; end: { character: number } }) =>
        text.slice(range.start.character, range.end.character),
    });
    const search = vi.fn(async () => []);
    mocks.primeSymbolAtPosition.mockImplementation((uri, position) =>
      primeSymbolAtPosition(uri as never, position as never, search),
    );

    await makeFindReferencesTool().handler({ path: 'src/math.ts', line: 0, character: 15 });

    expect(search).toHaveBeenCalledExactlyOnceWith('sumPricesR1');
  });

  it('adds the exact note when references omit searched files, including an empty provider result', async () => {
    mocks.primeSymbolAtPosition.mockResolvedValue({
      name: 'sumPricesR1',
      files: ['N:/workspace/scratch/a.ts', 'N:/workspace/scratch/z.ts'],
    });
    mocks.executeCommand.mockResolvedValue([
      { uri: { fsPath: 'N:/workspace/scratch/a.ts' }, range: { start: { line: 1, character: 2 } } },
    ]);
    const oneMissing = await makeFindReferencesTool().handler(baseArgs);
    expect(oneMissing).toBe(
      'scratch/a.ts:2:3\n\nNote: a text search also finds `sumPricesR1` in 1 file(s) the language server did not report: scratch/z.ts. The language server may still be loading this project; ask again in a few seconds, or check those files with search_code.',
    );

    mocks.executeCommand.mockResolvedValue(undefined);
    await expect(makeFindReferencesTool().handler(baseArgs)).resolves.toBe(
      'No references found.\n\nNote: a text search also finds `sumPricesR1` in 2 file(s) the language server did not report: scratch/a.ts, scratch/z.ts. The language server may still be loading this project; ask again in a few seconds, or check those files with search_code.',
    );
  });

  it('returns the clean hover answer when the loading marker clears on retry', async () => {
    vi.useFakeTimers();
    mocks.executeCommand
      .mockResolvedValueOnce([{ contents: [loading] }])
      .mockResolvedValueOnce([{ contents: ['```typescript\nfunction sumPricesR1(items: number[]): number\n```'] }]);
    const answer = makeGetHoverTool().handler(baseArgs);
    await vi.advanceTimersByTimeAsync(250);
    await expect(answer).resolves.toBe('```typescript\nfunction sumPricesR1(items: number[]): number\n```');
    expect(mocks.executeCommand).toHaveBeenCalledTimes(2);
  });

  it('adds the exact note when hover remains in the loading state', async () => {
    vi.useFakeTimers();
    mocks.executeCommand.mockResolvedValue([{ contents: [loading] }]);
    const answer = makeGetHoverTool().handler(baseArgs);
    await vi.advanceTimersByTimeAsync(7750);
    await expect(answer).resolves.toBe(
      `${loading}\n\nNote: \`(loading...)\` means the language server has not finished loading this project, so this answer may lack types. Ask again in a few seconds.`,
    );
    expect(mocks.executeCommand).toHaveBeenCalledTimes(6);
  });

  it('returns a rename result without a note when no old-name text remains', async () => {
    mocks.openTextDocument.mockResolvedValue({ uri: { fsPath: 'N:/workspace/src/math.ts' } });
    mocks.executeCommand.mockResolvedValue({ entries: () => [] });
    mocks.primeSymbolAtPosition.mockResolvedValue({ name: 'sumPricesR1', files: [] });
    mocks.remainingSymbolFiles.mockResolvedValue([]);
    await expect(
      makeRenameSymbolTool().handler(
        { ...baseArgs, new_name: 'sumPricesNew' },
        { beforeMutate: vi.fn() },
      ),
    ).resolves.toBe('Renamed to sumPricesNew');
  });

  it('adds the exact post-rename note for remaining old-name text', async () => {
    mocks.openTextDocument.mockResolvedValue({ uri: { fsPath: 'N:/workspace/src/math.ts' } });
    mocks.executeCommand.mockResolvedValue({ entries: () => [] });
    mocks.primeSymbolAtPosition.mockResolvedValue({ name: 'sumPricesR1', files: [] });
    mocks.remainingSymbolFiles.mockResolvedValue([
      'N:/workspace/scratch/a.ts',
      'N:/workspace/scratch/z.ts',
    ]);
    await expect(
      makeRenameSymbolTool().handler(
        { ...baseArgs, new_name: 'sumPricesNew' },
        { beforeMutate: vi.fn() },
      ),
    ).resolves.toBe(
      'Renamed to sumPricesNew\n\nNote: a text search still finds `sumPricesR1` in 2 file(s) after the rename: scratch/a.ts, scratch/z.ts. Check them with search_code; they may be comments or strings, or files the language server had not loaded.',
    );
  });
});
