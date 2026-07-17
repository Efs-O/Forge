import { describe, expect, it, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { buildChunkSeeds } from '../../src/search/chunking';

/** Minimal TextDocument over a string, enough for buildChunkSeeds. */
function makeDocument(source: string): vscode.TextDocument {
  const lines = source.split('\n');
  return {
    languageId: 'typescript',
    lineCount: lines.length,
    uri: vscode.Uri.file('/repo/src/sample.ts'),
    lineAt: (line: number) => ({ text: lines[line] ?? '' }),
    getText: (range?: vscode.Range) => {
      if (!range) return source;
      const slice = lines.slice(range.start.line, range.end.line + 1);
      return slice.join('\n');
    },
  } as unknown as vscode.TextDocument;
}

/** Stub the document-symbol provider with one symbol spanning [start,end]. */
function stubSymbol(name: string, start: number, end: number): void {
  vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([
    {
      name,
      children: [],
      range: new vscode.Range(new vscode.Position(start, 0), new vscode.Position(end, 0)),
    },
  ] as unknown as never);
}

afterEach(() => vi.restoreAllMocks());

describe('buildChunkSeeds - leading doc comments', () => {
  it('includes a JSDoc block directly above the symbol', async () => {
    // Regression: DocumentSymbol.range starts at the declaration, so the JSDoc
    // above it was dropped — losing the prose that best describes the symbol.
    const source = [
      "import x from 'y';", // 0
      '', // 1
      '/**', // 2
      ' * Routes a request to the right client.', // 3
      ' */', // 4
      'export function route() {', // 5
      '  return 1;', // 6
      '}', // 7
    ].join('\n');
    stubSymbol('route', 5, 7);

    const [seed] = await buildChunkSeeds(makeDocument(source), 'src/sample.ts');

    expect(seed!.text).toContain('Routes a request to the right client.');
    expect(seed!.text).toContain('export function route()');
    expect(seed!.startLine).toBe(3); // 1-based line of `/**`
  });

  it('includes a contiguous run of line comments', async () => {
    const source = [
      '// picks the backend', // 0
      '// based on provider', // 1
      'export function route() {', // 2
      '  return 1;', // 3
      '}', // 4
    ].join('\n');
    stubSymbol('route', 2, 4);

    const [seed] = await buildChunkSeeds(makeDocument(source), 'src/sample.ts');

    expect(seed!.text).toContain('picks the backend');
    expect(seed!.text).toContain('based on provider');
    expect(seed!.startLine).toBe(1);
  });

  it('stops at a blank line - a detached comment may describe something else', async () => {
    const source = [
      '// unrelated trailing note', // 0
      '', // 1
      'export function route() {', // 2
      '  return 1;', // 3
      '}', // 4
    ].join('\n');
    stubSymbol('route', 2, 4);

    const [seed] = await buildChunkSeeds(makeDocument(source), 'src/sample.ts');

    expect(seed!.text).not.toContain('unrelated trailing note');
    expect(seed!.startLine).toBe(3);
  });

  it('leaves a symbol with no leading comment unchanged', async () => {
    const source = ['export function route() {', '  return 1;', '}'].join('\n');
    stubSymbol('route', 0, 2);

    const [seed] = await buildChunkSeeds(makeDocument(source), 'src/sample.ts');

    expect(seed!.text.startsWith('export function route()')).toBe(true);
    expect(seed!.startLine).toBe(1);
  });

  it('caps the comment block so a licence header is not pulled in', async () => {
    const header = ['/*', ...Array.from({ length: 40 }, (_, i) => ` * header line ${i}`), ' */'];
    const source = [...header, 'export function route() {', '  return 1;', '}'].join('\n');
    stubSymbol('route', header.length, header.length + 2);

    const [seed] = await buildChunkSeeds(makeDocument(source), 'src/sample.ts');

    // Block opener sits beyond MAX_COMMENT_LINES, so the symbol is left as-is
    // rather than swallowing a 42-line header.
    expect(seed!.text).not.toContain('header line 0');
    expect(seed!.text.startsWith('export function route()')).toBe(true);
  });
});
