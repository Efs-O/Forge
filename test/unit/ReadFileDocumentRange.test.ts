import * as fs from 'fs';
import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same workspace-root mock as `ReadFileLineCount.test.ts`: `resolveWorkspacePath`
// needs a workspace folder, and the temp folder is where the target files go.
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: require('os').tmpdir() } }],
  },
}));

import * as path from 'path';
import { makeReadFileTool } from '../../src/tools/readFileTool';
import { MAX_DOCUMENT_READ_CHARS, MAX_READ_FILE_CHARS } from '../../src/tools/resultCap';
import type { PdfReadOptions } from '../../src/documents';

let dir: string;
const signal = new AbortController().signal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-readrange-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A document reader that records what it was asked for and returns the text the
 *  real PDF reader would return for that request — already page-selected, with
 *  its own note about the pages it did not parse. */
function fakeReader(text: string): {
  asked: PdfReadOptions[];
  readDocument: (
    file: string,
    bytes: Buffer,
    abortSignal: AbortSignal | undefined,
    options: PdfReadOptions,
  ) => Promise<string>;
} {
  const asked: PdfReadOptions[] = [];
  return {
    asked,
    readDocument: async (_file: string, _bytes: Buffer, _signal: AbortSignal | undefined, options: PdfReadOptions) => {
      asked.push(options);
      return text;
    },
  };
}

const pdfText = '--- page 2 ---\nsecond\n--- page 3 ---\nthird\n(pages 1, 4-5 of 5 not read)';

describe('read_file document ranges', () => {
  it('gives the reader the page range instead of slicing the whole document afterwards', async () => {
    const target = path.join(dir, 'sample.pdf');
    fs.writeFileSync(target, '%PDF-1.4 stub');
    const fake = fakeReader(pdfText);
    const result = await makeReadFileTool({ readDocument: fake.readDocument }).handler(
      { path: target, pages: '2-3' },
      { signal } as never,
    );
    expect(fake.asked).toEqual([{ pages: { first: 2, last: 3 } }]);
    expect(result).toContain('--- page 2 ---\nsecond');
    expect(result).toContain('(pages 1, 4-5 of 5 not read)');
    // Decisive: the old code sliced the reader's text by block index and found
    // only two blocks, so this same text made it refuse pages 2-3 outright.
    expect(result).not.toContain('outside this document');
  });

  // The budget is NOT the result cap: `capRead` cuts from the end, so a reader
  // that filled the cap had its own note cut first, and a batch read's header
  // pushed the result past the cap anyway.
  it('gives the reader the document budget, below the cap, when no pages were asked for', async () => {
    const target = path.join(dir, 'big.pdf');
    fs.writeFileSync(target, '%PDF-1.4 stub');
    const fake = fakeReader('--- page 1 ---\nfirst\n(pages 2-8000 of 8000 not read)');
    const result = await makeReadFileTool({ readDocument: fake.readDocument }).handler(
      { path: target },
      { signal } as never,
    );
    expect(fake.asked).toEqual([{ maxTextChars: MAX_DOCUMENT_READ_CHARS }]);
    expect(MAX_DOCUMENT_READ_CHARS).toBeLessThan(MAX_READ_FILE_CHARS);
    expect(result).toContain('(pages 2-8000 of 8000 not read)');
  });

  it('still slices the Office readers, which parse the whole archive and ignore the range', async () => {
    const target = path.join(dir, 'deck.pptx');
    fs.writeFileSync(target, 'PK stub');
    const all =
      '--- slide 1 ---\nfirst\n--- slide 2 ---\nsecond\n--- slide 3 ---\nthird';
    const fake = fakeReader(all);
    const result = await makeReadFileTool({ readDocument: fake.readDocument }).handler(
      { path: target, pages: '2-2' },
      { signal } as never,
    );
    expect(fake.asked).toEqual([{ pages: { first: 2, last: 2 } }]);
    expect(result).toContain('--- slide 2 ---\nsecond');
    expect(result).not.toContain('--- slide 1 ---');
    expect(result).toContain('2 more pages/sheets/slides');
  });

  it('refuses a slide range outside the slides the reader returned', async () => {
    const target = path.join(dir, 'deck.pptx');
    fs.writeFileSync(target, 'PK stub');
    const fake = fakeReader('--- slide 1 ---\nfirst\n--- slide 2 ---\nsecond\n--- slide 3 ---\nthird');
    await expect(
      makeReadFileTool({ readDocument: fake.readDocument }).handler(
        { path: target, pages: '5-9' },
        { signal } as never,
      ),
    ).rejects.toThrow(/pages 5-9 is outside this document's 1-3 range/);
  });

  it('refuses a PDF range the document cannot answer, by its real page count', async () => {
    // No fake here: this one runs the real reader on the one-page fixture, so it
    // proves the refusal the PDF reader gives reaches `read_file` unwrapped.
    const target = path.join(dir, 'tiny.pdf');
    fs.copyFileSync(path.join(process.cwd(), 'test', 'fixtures', 'documents', 'sample.pdf'), target);
    await expect(
      makeReadFileTool().handler({ path: target, pages: '2-3' }, { signal } as never),
    ).rejects.toThrow(/outside this document's 1-1 range/);
  });
});
