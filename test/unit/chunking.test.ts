import { describe, expect, it, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { buildChunkSeeds } from '../../src/search/chunking';
import { estimateTokens, type TokenCounter } from '../../src/search/embeddingBudget';
import { formatDocument } from '../../src/search/embeddingPrompts';

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

describe('buildChunkSeeds token-budget fit pass', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A 22-line symbol (~330 est tokens) that exceeds the small budget below.
  function makeBigSymbol(): { source: string; endLine0: number } {
    const body = Array.from({ length: 20 }, (_, i) => `  const value${i} = compute(${i});`);
    const source = ['export function big() {', ...body, '}'].join('\n');
    return { source, endLine0: source.split('\n').length - 1 };
  }

  it('returns a single seed unchanged when it fits the budget', async () => {
    const { source, endLine0 } = makeBigSymbol();
    stubSymbol('big', 0, endLine0);

    // Budget far above the symbol's estimate -> no split.
    const seeds = await buildChunkSeeds(makeDocument(source), 'src/sample.ts', 10_000);

    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.symbolName).toBe('big');
  });

  it('splits an oversized symbol into sub-chunks that each fit the budget', async () => {
    const { source, endLine0 } = makeBigSymbol();
    stubSymbol('big', 0, endLine0);

    // Budget of 100 tokens (~200 chars) forces the ~330-token symbol to split.
    const seeds = await buildChunkSeeds(makeDocument(source), 'src/sample.ts', 100);

    expect(seeds.length).toBeGreaterThan(1);
    for (const seed of seeds) {
      expect(estimateTokens(seed.text)).toBeLessThanOrEqual(100);
      // The symbol name is retained on every fragment so it stays findable.
      expect(seed.symbolName).toBe('big');
    }
    // Ranges cover the whole symbol: first starts at the declaration (1-based),
    // last ends at the closing brace (1-based).
    expect(seeds[0]!.startLine).toBe(1);
    expect(seeds[seeds.length - 1]!.endLine).toBe(endLine0 + 1);
    expect(seeds[seeds.length - 1]!.text).toContain('}');
  });

  it('keeps sub-chunk line ranges monotonic and non-empty', async () => {
    const { source, endLine0 } = makeBigSymbol();
    stubSymbol('big', 0, endLine0);

    const seeds = await buildChunkSeeds(makeDocument(source), 'src/sample.ts', 100);

    for (let i = 1; i < seeds.length; i++) {
      expect(seeds[i]!.startLine).toBeGreaterThanOrEqual(seeds[i - 1]!.startLine);
      expect(seeds[i]!.endLine).toBeGreaterThanOrEqual(seeds[i]!.startLine);
      expect(seeds[i]!.text.length).toBeGreaterThan(0);
    }
  });

  it('splits a single over-long line by character when line-splitting cannot break it', async () => {
    // A single line with no newlines (e.g. minified JSON on one line): the
    // line-based split has no boundary to cut on, so splitSeedToFit must fall
    // back to character splitting. This is the regression that 500s the
    // embedding server — one seed that no line split can make fit.
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([] as never);
    const longLine = 'x'.repeat(5000); // ~2500 est tokens, far over the budget
    const source = longLine; // one line, no trailing newline

    // Budget of 100 tokens (~200 chars) forces the 2500-token line to split.
    const seeds = await buildChunkSeeds(makeDocument(source), 'src/blob.json', 100);

    expect(seeds.length).toBeGreaterThan(1);
    for (const seed of seeds) {
      // Every piece fits the budget — this is the invariant that prevents the 500.
      expect(estimateTokens(seed.text)).toBeLessThanOrEqual(100);
    }
    // All content is preserved: the concatenated pieces equal the original line.
    expect(seeds.map((s) => s.text).join('')).toBe(longLine);
  });

  it('reserves the prompt prefix so a raw chunk at the budget edge still fits once formatted', async () => {
    // Regression for a live failure during development: a raw 4093-char single line has
    // raw est 2047 (<= 2048), so the raw-fit pass kept it whole — but the
    // request layer embeds the FORMATTED text (gemma prefix "title: none |
    // text: ", +20 chars), pushing it to est 2057 > 2048 -> HTTP 500. The fit
    // pass must measure the formatted text, so this line is now split.
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([] as never);
    const raw = 'x'.repeat(4093); // raw est 2047; formatted est 2057
    expect(estimateTokens(raw)).toBeLessThanOrEqual(2048); // raw fits the window
    expect(estimateTokens(formatDocument(raw, 'gemma'))).toBeGreaterThan(2048); // formatted overflows

    const seeds = await buildChunkSeeds(makeDocument(raw), 'src/blob.json', 2048, 'gemma');

    expect(seeds.length).toBeGreaterThan(1);
    for (const seed of seeds) {
      // Every piece, WITH the gemma prefix, fits the window — the invariant that
      // prevents the 500.
      expect(estimateTokens(formatDocument(seed.text, 'gemma'))).toBeLessThanOrEqual(2048);
    }
    // All content preserved.
    expect(seeds.map((s) => s.text).join('')).toBe(raw);
  });

  it('splits a chunk the estimate says fits but the exact counter says overflows', async () => {
    // Regression for the live 500: a 4063-char chunk estimated at 2032 tokens
    // (<= 2048) was kept whole, but the real tokenizer produced 2566 (> 2048).
    // The fit pass must verify with the EXACT counter, not the estimate.
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([] as never);
    const raw = 'x'.repeat(4063); // estimate 2032 <= 2048, but a dense tokenizer overflows
    expect(estimateTokens(raw)).toBeLessThanOrEqual(2048);

    // A counter that reports one token per character — denser than the
    // estimate, simulating minified/base64/CJK content where it undercounts.
    const denseCounter: TokenCounter = { count: async (text: string) => text.length };

    const seeds = await buildChunkSeeds(makeDocument(raw), 'src/blob.json', 2048, 'none', denseCounter);

    expect(seeds.length).toBeGreaterThan(1);
    for (const seed of seeds) {
      // Every piece, measured by the EXACT counter, fits the window.
      expect(await denseCounter.count(seed.text)).toBeLessThanOrEqual(2048);
    }
    // All content preserved.
    expect(seeds.map((s) => s.text).join('')).toBe(raw);
  });

  it('keeps a chunk whole when the exact counter fits but the byte bound does not', async () => {
    // Multi-byte content: 1500 CJK chars = 4500 bytes. The byte bound (4504)
    // exceeds the window, but the real token count (~1500, one per char) fits.
    // Without the counter the byte bound would over-split this; with it the
    // chunk is kept whole — the counter improves chunk size without risking a
    // 500, because it measures the same tokens the embedding path uses.
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([] as never);
    const cjk = '中'.repeat(1500); // 3 bytes/char = 4500 bytes
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(2048); // byte bound overflows
    const exactCounter: TokenCounter = { count: async (text: string) => text.length };

    const seeds = await buildChunkSeeds(makeDocument(cjk), 'src/blob.json', 2048, 'none', exactCounter);

    // The chunk fits per the exact counter, so it is kept whole.
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.text).toBe(cjk);
  });
});
