import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openTextDocument: vi.fn() }));

vi.mock('vscode', () => ({
  Position: class Position {
    constructor(readonly line: number, readonly character: number) {}
  },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'N:/workspace' } }],
    openTextDocument: mocks.openTextDocument,
  },
  env: { appRoot: undefined },
}));

import { primeSymbolAtPosition } from '../../src/tools/symbolSearch';

const declaration = 'export function sumPricesR1(items: number[]): number {';

function documentForLine(text: string) {
  const rangeAt = (character: number) => {
    const words = [...text.matchAll(/[\p{L}\p{N}_$]+/gu)];
    const containing = words.find((word) => {
      const start = word.index ?? 0;
      return start <= character && character < start + word[0].length;
    });
    const ending = words.find((word) => (word.index ?? 0) + word[0].length === character);
    const word = containing ?? ending;
    if (!word) return undefined;
    const start = word.index ?? 0;
    return { start: { character: start }, end: { character: start + word[0].length } };
  };
  return {
    lineAt: () => ({ text }),
    getWordRangeAtPosition: (position: { character: number }) => rangeAt(position.character),
    getText: (range: { start: { character: number }; end: { character: number } }) =>
      text.slice(range.start.character, range.end.character),
  };
}

describe('language-server project priming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('searches the identifier and opens every matched file before returning', async () => {
    const opened: string[] = [];
    mocks.openTextDocument.mockImplementation(async (uri: { fsPath: string }) => {
      opened.push(uri.fsPath);
      if (uri.fsPath.endsWith('use.ts')) {
        return documentForLine('sumPricesR1');
      }
      return { uri };
    });
    const searched: string[] = [];
    const result = await primeSymbolAtPosition(
      { fsPath: 'N:/workspace/use.ts' } as never,
      { line: 0, character: 1 } as never,
      async (name) => {
        searched.push(name);
        return ['N:/workspace/math.ts', 'N:/workspace/use.ts'];
      },
    );
    expect(searched).toEqual(['sumPricesR1']);
    expect(opened).toEqual([
      'N:/workspace/use.ts',
      'N:/workspace/math.ts',
      'N:/workspace/use.ts',
    ]);
    expect(result).toEqual({ name: 'sumPricesR1', files: ['N:/workspace/math.ts', 'N:/workspace/use.ts'] });
  });

  it('skips text search when the position has no word', async () => {
    mocks.openTextDocument.mockResolvedValue(documentForLine(''));
    const search = vi.fn(async () => []);
    await expect(
      primeSymbolAtPosition({ fsPath: 'N:/workspace/use.ts' } as never, { line: 0, character: 0 } as never, search),
    ).resolves.toEqual({ files: [] });
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    [15, 'sumPricesR1'],
    [16, 'sumPricesR1'],
    [20, 'sumPricesR1'],
    [27, 'sumPricesR1'],
    [3, 'export'],
  ])('selects %s as %s', async (character, expectedName) => {
    mocks.openTextDocument.mockResolvedValue(documentForLine(declaration));
    const search = vi.fn(async () => []);
    await expect(
      primeSymbolAtPosition(
        { fsPath: 'N:/workspace/use.ts' } as never,
        { line: 0, character } as never,
        search,
      ),
    ).resolves.toEqual({ name: expectedName, files: [] });
    expect(search).toHaveBeenCalledExactlyOnceWith(expectedName);
  });

  it('skips priming for whitespace at the end of the line', async () => {
    mocks.openTextDocument.mockResolvedValue(documentForLine(`${declaration}   `));
    const search = vi.fn(async () => []);
    await expect(
      primeSymbolAtPosition(
        { fsPath: 'N:/workspace/use.ts' } as never,
        { line: 0, character: declaration.length + 1 } as never,
        search,
      ),
    ).resolves.toEqual({ files: [] });
    expect(search).not.toHaveBeenCalled();
  });
});
