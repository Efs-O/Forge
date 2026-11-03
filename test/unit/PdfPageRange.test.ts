import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDocument } from '../../src/documents';
import { extractPdfPages, readPdf } from '../../src/documents/pdf';
import { makeReadFileTool } from '../../src/tools/readFileTool';
import {
  isCapTruncated,
  MAX_DOCUMENT_READ_CHARS,
  MAX_READ_FILE_CHARS,
} from '../../src/tools/resultCap';

// `resolveWorkspacePath` needs a workspace folder and the temp folder is where
// the PDF goes — the same fake `ReadFileDocumentRange.test.ts` uses, needed
// here because the last two tests go through `read_file` itself.
vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: require('os').tmpdir() } }],
  },
}));

/**
 * A fake pdfjs whose `getPage` calls are counted, because the defect here was
 * parsing every page of a large PDF for a read that asked for two of them. The
 * fake and its state both live inside the `vi.mock` factory: the factory is
 * hoisted above this file's statements, so a `const` declared below would still
 * be in its temporal dead zone when the factory runs. It returns what the real
 * module returns — a loading task with `promise` and `destroy`, and page text
 * as `{ items: [{ str }] }` — so the code under test cannot tell them apart.
 */
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => {
  const state = {
    numPages: 5,
    pageChars: 20,
    getPageCalls: [] as number[],
  };
  const document = {
    get numPages() {
      return state.numPages;
    },
    getPage: async (page: number) => {
      if (page < 1 || page > state.numPages) throw new Error(`Requested page ${page} does not exist.`);
      state.getPageCalls.push(page);
      return {
        getTextContent: async () => ({ items: [{ str: 'x'.repeat(state.pageChars) }] }),
      };
    },
    destroy: async () => {},
  };
  return {
    __pdfFake: state,
    getDocument: () => ({ promise: Promise.resolve(document), destroy: async () => {} }),
  };
});

interface PdfFake {
  numPages: number;
  pageChars: number;
  getPageCalls: number[];
}

async function pdfFake(): Promise<PdfFake> {
  return ((await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    __pdfFake: PdfFake;
  }).__pdfFake;
}

const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

beforeEach(async () => {
  const fake = await pdfFake();
  fake.numPages = 5;
  fake.pageChars = 20;
  fake.getPageCalls.length = 0;
});

describe('PDF page range', () => {
  it('parses only the pages the range asks for and still reports the whole page count', async () => {
    const fake = await pdfFake();
    fake.numPages = 5;
    const extracted = await extractPdfPages(bytes, undefined, { pages: { first: 2, last: 3 } });
    expect(fake.getPageCalls).toEqual([2, 3]);
    expect(extracted.pages.map((row) => row.page)).toEqual([2, 3]);
    expect(extracted.numPages).toBe(5);
    expect(extracted.notRead).toEqual([
      { first: 1, last: 1 },
      { first: 4, last: 5 },
    ]);
  });

  it('refuses a range the document cannot answer, naming its real page count and parsing nothing', async () => {
    const fake = await pdfFake();
    fake.numPages = 1;
    await expect(extractPdfPages(bytes, undefined, { pages: { first: 5, last: 9 } })).rejects.toThrow(
      /PDF pages 5-9 are outside this document's 1-1 range/,
    );
    expect(fake.getPageCalls).toEqual([]);
  });

  it('stops at the read cap instead of parsing 8,000 pages, and names the pages it did not read', async () => {
    const fake = await pdfFake();
    fake.numPages = 8000;
    fake.pageChars = 3000;
    const text = await readPdf(bytes, undefined, { maxTextChars: 120_000 });
    // The page that pushed the total past the budget is parsed and THEN left out
    // whole — one page of wasted parse, bought to know its size — so the last
    // page fetched is not the last page printed, and the note starts at it.
    // That is what makes the window it suggests the one the model can use.
    const fetched = fake.getPageCalls.length;
    expect(fetched).toBeGreaterThan(30);
    expect(fetched).toBeLessThan(60);
    expect(text).toContain('--- page 1 ---');
    expect(text).not.toContain(`--- page ${fetched} ---`);
    expect(text.slice(text.lastIndexOf('\n') + 1)).toBe(
      `(pages ${fetched}-8000 of 8000 not read; read them with pages: "${fetched}-${fetched + 39}")`,
    );
  });

  it('parses every page and adds no note when neither a range nor a budget was asked for', async () => {
    const fake = await pdfFake();
    fake.numPages = 3;
    const text = await readPdf(bytes);
    expect(fake.getPageCalls).toEqual([1, 2, 3]);
    expect(text).toContain('--- page 1 ---');
    expect(text).toContain('--- page 3 ---');
    expect(text).not.toContain('not read');
  });

  it('readDocument hands the page range down to the PDF reader', async () => {
    const fake = await pdfFake();
    fake.numPages = 5;
    const text = await readDocument(
      'sample.pdf',
      Buffer.from(bytes),
      undefined,
      { pages: { first: 2, last: 3 } },
    );
    expect(fake.getPageCalls).toEqual([2, 3]);
    expect(text).toContain('--- page 2 ---');
    expect(text).not.toContain('--- page 1 ---');
    expect(text).toContain('(pages 1, 4-5 of 5 not read)');
  });
});

// The cap is the tool's and the budget is the reader's, and the defect lived in
// the seam between them: a capped PDF read came back a page LONGER than
// MAX_READ_FILE_CHARS, so `capRead` cut it from the end, the cut landed inside a
// page, and the "pages not read" note went with it — leaving the model the
// generic "re-read a smaller range" marker for a file it cannot read by lines.
// These run the real reader over the fake pdfjs through the real tool, because
// neither half on its own could see the seam.
describe('read_file on a PDF bigger than one read', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pdfcap-'));
    fs.writeFileSync(path.join(dir, 'big.pdf'), '%PDF-1.4 stub');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the pages-not-read note inside the cap instead of cutting it away', async () => {
    const fake = await pdfFake();
    fake.numPages = 8000;
    fake.pageChars = 3000;
    const result = String(await makeReadFileTool().handler({ path: path.join(dir, 'big.pdf') }));
    const fetched = fake.getPageCalls.length;
    expect(isCapTruncated(result)).toBe(false);
    expect(result).toContain('not read; read them with pages:');
    // Decisive, and what the `readPdf`-only test could not see: the note names
    // the first page the read did NOT print, pages are kept whole, and the whole
    // result — note included — fits inside the cap `capRead` would cut at.
    expect(result).not.toContain(`--- page ${fetched} ---`);
    expect(result).toContain(`(pages ${fetched}-8000 of 8000 not read`);
    expect(result.length).toBeLessThanOrEqual(MAX_DOCUMENT_READ_CHARS);
    expect(result.length).toBeLessThanOrEqual(MAX_READ_FILE_CHARS);
  });

  it('prints as much of an over-long first page as fits, and says it was cut', async () => {
    const fake = await pdfFake();
    fake.numPages = 2;
    // Page 1 alone is over the whole budget: the read still has to answer with
    // something, and has to say where its text stops.
    fake.pageChars = MAX_DOCUMENT_READ_CHARS + 5000;
    const result = String(await makeReadFileTool().handler({ path: path.join(dir, 'big.pdf') }));
    expect(isCapTruncated(result)).toBe(false);
    expect(result.length).toBeLessThanOrEqual(MAX_READ_FILE_CHARS);
    expect(result).toContain('--- page 1 ---');
    expect(result).toContain('page 1 cut at');
    expect(fake.getPageCalls).toEqual([1]);
    expect(result.slice(result.lastIndexOf('\n') + 1)).toBe(
      '(page 1 cut at 119729 chars; pages 2 of 2 not read; read them with pages: "2-2")',
    );
  });
});
