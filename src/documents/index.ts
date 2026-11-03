import * as path from 'path';
import { readDocx } from './docx';
import { readPdf } from './pdf';
import { readPptx } from './pptx';
import { readXlsx } from './xlsx';

import { extractPdfPages, type PdfReadOptions } from './pdf';

export type { PdfPageRange, PdfReadOptions } from './pdf';

/**
 * The Telegram PDF text facade: every page, because a phone attachment has no
 * page range asked for and its own 2 MB slice happens after the parse. It does
 * not stop early the way a capped `read_file` does — the parse-everything cost
 * is the same shape, but this input is already bounded by the 10 MiB
 * attachment limit in `RemoteAttachmentStore`, and nothing here is thrown away
 * before the 2 MB mark that would justify cutting the parse short.
 */
export async function extractPdfText(bytes: Buffer): Promise<string> {
  const { pages } = await extractPdfPages(bytes);
  const text = pages
    .map((page) => page.text)
    .join('\n')
    .trim();
  if (!text)
    throw new Error('PDF has no extractable text (scanned/image-only PDFs are unsupported)');
  return text.slice(0, 2 * 1024 * 1024);
}

export const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt']);
const SUPPORTED = new Set(['.pdf', '.docx', '.xlsx', '.pptx']);

export function isSupportedDocument(filePath: string): boolean {
  return SUPPORTED.has(path.extname(filePath).toLowerCase());
}

export async function readDocument(
  filePath: string,
  bytes: Buffer,
  abortSignal?: AbortSignal,
  options: PdfReadOptions = {},
): Promise<string> {
  const extension = path.extname(filePath).toLowerCase();
  if (LEGACY_OFFICE_EXTENSIONS.has(extension))
    throw new Error(
      `${extension} is an older Office format. Save it as ${extension === '.doc' ? '.docx' : extension === '.xls' ? '.xlsx' : '.ppt'} and try again.`,
    );
  try {
    if (
      ['.docx', '.xlsx', '.pptx'].includes(extension) &&
      bytes.subarray(0, 8).equals(Buffer.from('D0CF11E0A1B11AE1', 'hex'))
    )
      throw new Error(`Encrypted ${extension.toUpperCase()} Office files are unsupported.`);
    switch (extension) {
      case '.pdf':
        return await readPdf(bytes, abortSignal, options);
      case '.docx':
        return readDocx(bytes, abortSignal);
      case '.xlsx':
        return readXlsx(bytes, abortSignal);
      case '.pptx':
        return readPptx(bytes, abortSignal);
      default:
        throw new Error(`Unsupported document format: ${extension || '(no extension)'}.`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      /^(PDF|ZIP part|ZIP central directory|ZIP entry|ZIP archive|\.|Document parsing)/.test(
        error.message,
      )
    )
      throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${extension} parse error: ${message}`);
  }
}
