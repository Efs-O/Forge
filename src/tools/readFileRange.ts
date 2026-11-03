/**
 * Reading ONE range of ONE file for `read_file`: the on-disk read itself — the
 * binary refusal, document page selection, line slicing and numbering.
 * `readFileTool.ts` owns the tool around it: the schema, the `reads` batch,
 * section headers and the secret approval hook.
 */
import * as fs from 'fs';
import { mimeFromHeader } from './imageTool';
import { MAX_DOCUMENT_READ_CHARS } from './resultCap';
import { describePathMiss } from './pathErrorHint';
import {
  isSupportedDocument,
  LEGACY_OFFICE_EXTENSIONS,
  readDocument,
  type PdfPageRange,
} from '../documents';
import { refuseOversize } from './readFileGuards';
import { resolveWorkspacePath } from '../util/WorkspacePaths';

/** How much of a file to sniff for NUL bytes before calling it binary. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Binary files have no business being decoded as UTF-8 and fed to a model — a
 * 1.3 MB PNG became ~1.3 M characters of replacement glyphs and exhausted a
 * one-slot context in a single tool result. Refuse, and for an image name the
 * tool that does handle it rather than leaving the model to find a workaround.
 */
function binaryRefusal(bytes: Buffer, requestedPath: string): string | null {
  const imageMime = mimeFromHeader(bytes);
  if (imageMime) {
    return (
      `read_file: ${requestedPath} is an image (${imageMime}), not text. Use view_image to look at it; ` +
      'view_image itself says so if the active model has no vision.'
    );
  }
  if (!bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return null;
  return `read_file: ${requestedPath} appears to be a binary file, not text. Refusing to decode it as UTF-8.`;
}

/** Parse the `pages` argument before the read, so the reader can act on it. */
function parsePageRange(pages: string): PdfPageRange {
  const match = pages.match(/^(\d+)(?:-(\d+))?$/);
  const first = match ? Number(match[1]) : Number.NaN;
  const last = match?.[2] ? Number(match[2]) : first;
  if (!Number.isInteger(first) || first < 1 || !Number.isInteger(last) || last < first)
    throw new Error(
      'read_file: pages must be an increasing 1-based page, slide, or sheet range such as "2-4".',
    );
  return { first, last };
}

/** One file, one range, exactly the text a single read_file call returned, plus
 *  the line total the batch header needs — so a batch never reads the same file
 *  twice just to label its own section.
 */
export async function readRange(
  rawPath: string,
  startLine: number | undefined,
  endLine: number | undefined,
  numbered: boolean,
  pages: string | undefined,
  abortSignal: AbortSignal | undefined,
  maxTextFileBytes: number | undefined,
  readDoc: typeof readDocument,
): Promise<{ text: string; totalLines: number }> {
  const filePath = resolveWorkspacePath(rawPath);
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  const isDocument = isSupportedDocument(filePath) || LEGACY_OFFICE_EXTENSIONS.has(extension);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    throw new Error(describePathMiss('read_file', rawPath, err));
  }
  refuseOversize(rawPath, stat.size, extension, maxTextFileBytes);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    throw new Error(describePathMiss('read_file', rawPath, err));
  }
  let content: string;
  if (isDocument) {
    if (pages && extension === '.docx')
      throw new Error('read_file: pages applies to PDF pages, PPTX slides, and XLSX sheets only.');
    const selection = pages === undefined ? undefined : parsePageRange(pages);
    // A PDF read for pages 2-3 now parses those two pages instead of the whole
    // document; a PDF read with no range stops at MAX_DOCUMENT_READ_CHARS — the
    // cap minus room for the header this tool prepends — and names the pages it
    // did not read. The Office readers ignore this and are sliced below.
    content = await readDoc(filePath, bytes, abortSignal, {
      ...(selection ? { pages: selection } : { maxTextChars: MAX_DOCUMENT_READ_CHARS }),
    });
    if (selection && extension !== '.pdf') {
      const blocks = content.split(/(?=^--- (?:page|slide|sheet) .+ ---$)/m);
      if (selection.last > blocks.length)
        throw new Error(
          `read_file: pages ${selection.first}-${selection.last} is outside this document's 1-${blocks.length} range.`,
        );
      const selected = blocks.slice(selection.first - 1, selection.last);
      const omitted = blocks.length - selected.length;
      content = selected.join('').trim();
      if (omitted > 0) content += `\n${omitted} more pages/sheets/slides`;
    }
  } else {
    if (pages)
      throw new Error('read_file: pages is available for PDF, PPTX, and XLSX documents only.');
    const refusal = binaryRefusal(bytes, rawPath);
    if (refusal) throw new Error(refusal);
    content = bytes.toString('utf8');
  }

  // A final newline ends the last line; it does not start another. Counting
  // the empty tail showed a phantom line 501 on a 500-line file, which is
  // exactly the off-by-one that sent Qwen splitting files ESLint accepted.
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const totalLines = lines.length;
  if (startLine === undefined && endLine === undefined && !numbered)
    return { text: content, totalLines };
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, endLine ?? lines.length);
  if (start > lines.length) {
    throw new Error(
      `read_file: start_line ${start} is past the end of the file (${lines.length} lines).`,
    );
  }
  if (start > end) {
    throw new Error(
      `read_file: start_line ${start} is past end_line ${end} (file has ${lines.length} lines).`,
    );
  }
  const selected = lines.slice(start - 1, end);
  if (!numbered) return { text: selected.join('\n'), totalLines };
  // `apply_line_edits` wants 1-based line numbers, but the only way to read
  // a file gave none — so the model counted them itself and got it wrong:
  // 14 of its 19 calls failed on stale or miscounted `expected_lines`.
  const width = String(end).length;
  // No space after the "|". A separator of "| " is NOT reversible: the
  // model cannot tell the separator's space from the line's first column,
  // so every old_str composed from a numbered read carries one extra
  // leading space and edit_file refuses text that was quoted perfectly.
  // That is what stalled the 2026-09-05 config.yaml session — six edit
  // attempts, all off by exactly one space, against a YAML file where
  // indentation is load-bearing. The number is right-padded instead, so
  // the "|" column still lines up and the character after it is column 1.
  return {
    text: selected
      .map((line, index) => `${String(start + index).padStart(width, ' ')}|${line}`)
      .join('\n'),
    totalLines,
  };
}
