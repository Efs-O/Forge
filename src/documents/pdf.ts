export interface ExtractedPdfPage {
  page: number;
  text: string;
}

/** A 1-based, inclusive page range. */
export interface PdfPageRange {
  first: number;
  last: number;
}

/**
 * What a document read is allowed to do. `read_file` sets one or the other: a
 * page range, so the parse touches the pages it was asked for and nothing
 * else, or a character budget, so an 8,000-page PDF does not parse all 8,000
 * pages for a read whose result the tool would then cut anyway. `readDocument`
 * passes them for every format, and only the PDF reader acts on them — the
 * Office readers parse the whole archive either way, so their caller slices
 * the slides and sheets it asked for out of the text. A reader given a budget
 * never returns more than `maxTextChars` characters, its own note included:
 * the caller caps what it prints, and it caps from the END, so a reader that
 * filled the budget to the last character had its note cut off first — the one
 * part of a capped read the model cannot act on without.
 */
export interface PdfReadOptions {
  pages?: PdfPageRange;
  maxTextChars?: number;
}

export interface ExtractedPdfDocument {
  /** The pages parsed, in the order the document numbers them. */
  pages: ExtractedPdfPage[];
  /** Every page the document holds, whether or not this parse read it. */
  numPages: number;
  /** Pages this parse did not read: those outside a requested range, or the tail its budget cut. */
  notRead?: PdfPageRange[];
  /** True when `maxTextChars` stopped the parse before the last page it was asked for. */
  stoppedByCap?: boolean;
  /**
   * Set when the FIRST page it printed is alone longer than `maxTextChars`: how
   * many characters of its body the read could print. Without it a document
   * whose first page is a wall of text would answer with nothing, and the model
   * could not tell a page it never got from a page cut short.
   */
  cutPage?: { page: number; keptChars: number };
}

/**
 * Characters held back for the "pages not read" note, so the model always sees
 * it. Sized on the longest note this file can print — a cut page, two page
 * ranges and six-digit page numbers, `(page 1 cut at 119728 chars; pages
 * 2-100000 of 100000 not read; read them with pages: "2-41")`, 93 characters —
 * so `maxTextChars` is the ceiling on what the read returns, not just on the
 * page bodies it holds.
 */
const OMISSION_NOTE_RESERVE_CHARS = 128;
/** How many pages the note suggests reading next, because the model cannot tell how many fit. */
const SUGGESTED_PAGE_WINDOW = 40;

/** The line `readPdf` prints above each page. */
function pageHeader(page: number): string {
  return `--- page ${page} ---`;
}

/** What follows a page's header: its text, or the note that says the page has none. */
function pageBody(page: number, text: string): string {
  return text || `(page ${page} has no text — view it with view_image and pages: "${page}")`;
}

/**
 * One page's whole contribution to the printed result: header, body, and the
 * newline `readPdf` joins pages with is counted by the caller. The character
 * budget counts THIS length, because the budget is the size of the result the
 * model receives, not the sum of the page bodies.
 */
function pagePrinted(page: number, text: string): string {
  return `${pageHeader(page)}\n${pageBody(page, text)}`;
}

/** A page range the document cannot answer; it goes out unwrapped, not as a parse error. */
class PdfPageRangeError extends Error {}

export async function extractPdfPages(
  bytes: Uint8Array,
  abortSignal?: AbortSignal,
  options: PdfReadOptions = {},
): Promise<ExtractedPdfDocument> {
  if (abortSignal?.aborted) throw new Error('PDF parsing cancelled.');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  const onAbort = () => {
    void loading.destroy();
  };
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  let document: Awaited<typeof loading.promise> | undefined;
  try {
    document = await loading.promise;
    const numPages = document.numPages;
    const first = options.pages?.first ?? 1;
    const last = options.pages?.last ?? numPages;
    if (first < 1 || last > numPages || last < first) {
      throw new PdfPageRangeError(
        `PDF pages ${first}-${last} are outside this document's 1-${numPages} range.`,
      );
    }
    const pages: ExtractedPdfPage[] = [];
    let parsedLast = first - 1;
    let cutPage: { page: number; keptChars: number } | undefined;
    /** Exact length of what `readPdf` will print for the pages kept, note excluded. */
    let printedChars = 0;
    let stoppedByCap = false;
    // The note is printed AFTER the last page, so a budget the pages alone fill
    // leaves nothing for it. Hold its room back up front and keep a page only
    // while it fits inside what is left, and the budget really is the ceiling on
    // the result instead of something the result overruns by a page.
    const bodyBudget =
      options.maxTextChars === undefined
        ? undefined
        : options.maxTextChars - OMISSION_NOTE_RESERVE_CHARS;
    for (let page = first; page <= last; page++) {
      if (abortSignal?.aborted) throw new Error('PDF parsing cancelled.');
      const content = await (await document.getPage(page)).getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .trim();
      const separator = pages.length === 0 ? 0 : 1;
      const printed = pagePrinted(page, text).length;
      if (bodyBudget !== undefined && printedChars + separator + printed > bodyBudget) {
        stoppedByCap = true;
        // A page that does not fit is left out WHOLE, so the window the note
        // suggests starts at it: a partial page would overrun the cap and lose
        // the note that says where to continue. The first page is the exception
        // — a read that printed nothing at all would answer nothing — so it is
        // printed as far as the budget reaches, and the note says it was cut.
        const headerLength = `--- page ${page} ---\n`.length;
        if (pages.length === 0 && bodyBudget > headerLength) {
          const body = pageBody(page, text).slice(0, bodyBudget - headerLength);
          pages.push({ page, text: body });
          cutPage = { page, keptChars: body.length };
          parsedLast = page;
        }
        break;
      }
      printedChars += separator + printed;
      pages.push({ page, text });
      parsedLast = page;
    }
    const notRead: PdfPageRange[] = [];
    if (first > 1) notRead.push({ first: 1, last: first - 1 });
    if (parsedLast < numPages) notRead.push({ first: parsedLast + 1, last: numPages });
    return {
      pages,
      numPages,
      ...(notRead.length ? { notRead } : {}),
      ...(stoppedByCap ? { stoppedByCap: true } : {}),
      ...(cutPage ? { cutPage } : {}),
    };
  } catch (error) {
    if (error instanceof PdfPageRangeError) throw error;
    if (abortSignal?.aborted) throw new Error('PDF parsing cancelled.');
    if (
      typeof error === 'object' &&
      error !== null &&
      'name' in error &&
      error.name === 'PasswordException'
    )
      throw new Error('PDF is encrypted; encrypted PDFs are unsupported.');
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PDF parse error: ${message}`);
  } finally {
    if (document) await document.destroy();
    else await loading.destroy();
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

export async function readPdf(
  bytes: Uint8Array,
  abortSignal?: AbortSignal,
  options: PdfReadOptions = {},
): Promise<string> {
  const extracted = await extractPdfPages(bytes, abortSignal, options);
  const text = extracted.pages.map(({ page, text }) => pagePrinted(page, text)).join('\n');
  if (!extracted.notRead && !extracted.cutPage) return text;
  const note = omissionNote(extracted);
  // A budget too small for even one page header leaves no page to print, so the
  // note is the whole answer — and it still names where the model should read on.
  return text ? `${text}\n${note}` : note;
}

/**
 * Names the pages this read did not parse, so a page range or a capped read
 * never looks like the whole document. For a read its own character budget
 * cut off, it also suggests the next window: the model cannot work out from
 * the note how many pages will fit, and guessing sends it back for another
 * whole read of a file it has already paid to open.
 */
function omissionNote(extracted: ExtractedPdfDocument): string {
  const notRead = extracted.notRead ?? [];
  const list = notRead
    .map((range) =>
      range.first === range.last ? `${range.first}` : `${range.first}-${range.last}`,
    )
    .join(', ');
  const tail = notRead[notRead.length - 1];
  const parts: string[] = [];
  if (extracted.cutPage) {
    const cut = extracted.cutPage;
    parts.push(
      tail
        ? `page ${cut.page} cut at ${cut.keptChars} chars`
        : `page ${cut.page} is longer than one read can print, so only its first ${cut.keptChars} chars are shown`,
    );
  }
  if (list) parts.push(`pages ${list} of ${extracted.numPages} not read`);
  if (extracted.stoppedByCap && tail) {
    const window = Math.min(tail.first + SUGGESTED_PAGE_WINDOW - 1, extracted.numPages);
    parts.push(`read them with pages: "${tail.first}-${window}"`);
  }
  return `(${parts.join('; ')})`;
}
