import { MAX_READ_FILE_CHARS, capResultText } from './resultCap';
import { LEGACY_OFFICE_EXTENSIONS } from '../documents';

/** The largest file `read_file` will read at all, documents included. */
export const MAX_READ_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Refuse a file over the read limit, with the route that works on it.
 *
 * The route used to be `grep_search`, or a byte range with the shell, for every
 * oversized file. That is right for text and wrong for these: an Office
 * document is a ZIP of deflated XML parts and a PDF is compressed streams, so
 * a text search finds nothing in either and a byte slice returns bytes no
 * reader can use — and `view_image` has its own 10 MiB PDF limit. The limit
 * stays; only the advice changes, because a route that cannot work is a round
 * the agent spends finding that out. The ZIP advice also names WHICH shell: on
 * Windows the `shell` tool defaults to pwsh, `unzip` lives in Git's
 * `usr\bin`, and only `Git\bin` is put on a child's PATH, so the same command
 * that works in Git Bash is "not recognized" in the default one.
 */
export function refuseOversize(
  rawPath: string,
  size: number,
  extension: string,
  maxBytes: number = MAX_READ_FILE_BYTES,
): void {
  if (size <= maxBytes) return;
  const head = `read_file: ${rawPath} is ${size} bytes, over the ${maxBytes}-byte limit. `;
  if (LEGACY_OFFICE_EXTENSIONS.has(extension))
    throw new Error(
      `${head}Save it as .docx, .xlsx or .pptx first: read_file cannot open the older Office formats at any size.`,
    );
  if (['.docx', '.pptx', '.xlsx'].includes(extension))
    throw new Error(
      `${head}It is a ZIP of XML parts, so open the one part you need with the shell ` +
        'tool: run unzip -p "<path>" word/document.xml (or xl/workbook.xml, ' +
        'xl/sharedStrings.xml, ppt/slides/slide1.xml) with shell: "bash" — that is ' +
        'where unzip is on the path, and not in the default Windows shell — then ' +
        'read_file what it prints.',
    );
  if (extension === '.pdf')
    throw new Error(
      `${head}grep_search and a byte range read nothing useful in a PDF, and ` +
        'view_image stops at its own 10 MiB limit: split it with the shell first ' +
        '(qpdf or gs, if one is installed), then read_file or view_image with ' +
        'pages on a part.',
    );
  throw new Error(
    `${head}Use grep_search or the shell with a byte range to inspect it; line ranges and document parsing read the whole file.`,
  );
}

export function capRead(text: string): string {
  return capResultText(
    text,
    MAX_READ_FILE_CHARS,
    'read_file',
    'Re-read a smaller range with start_line and end_line, or ask for fewer reads items, to see the rest.',
  );
}

export function validateLineRange(record: Record<string, unknown>, label: string): void {
  for (const key of ['start_line', 'end_line'] as const) {
    if (
      record[key] !== undefined &&
      (!Number.isInteger(record[key]) || (record[key] as number) < 1)
    )
      throw new Error(
        `${label}: ${key} must be a positive integer; send a number without quotes, e.g. 12.`,
      );
  }
}

export function capBatchRead(sections: string[]): string {
  const skipped = sections.filter((section) => section.startsWith('[skipped:'));
  if (skipped.length === 0) {
    return capRead(sections.join('\n'));
  }
  const content = sections.filter((section) => !section.startsWith('[skipped:')).join('\n');
  const skippedText = skipped.join('\n');
  const contentLimit = Math.max(1, MAX_READ_FILE_CHARS - skippedText.length - 1);
  const cappedContent = capResultText(
    content,
    contentLimit,
    'read_file',
    'The batch result cap was reached; read the remaining paths in another call.',
  );
  return `${cappedContent}\n${skippedText}`;
}
