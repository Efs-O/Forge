import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { readDocument } from '../../src/documents';
import { sheetRowCells } from '../../src/documents/xlsx';

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/documents/${name}`, import.meta.url));

describe('document readers', () => {
  it('reads PDF text with per-page markers and identifies scanned pages', async () => {
    expect(await readDocument('sample.pdf', fixture('sample.pdf'))).toContain(
      '--- page 1 ---\nPDF sample text',
    );
    expect(await readDocument('scanned.pdf', fixture('scanned.pdf'))).toContain(
      'view_image and pages: "1"',
    );
  });

  it('reads Word headings, paragraphs and tables', async () => {
    const result = await readDocument('sample.docx', fixture('sample.docx'));
    expect(result).toContain('# Quarterly Report');
    expect(result).toContain('Revenue grew.');
    expect(result).toContain('| Region | Sales |');
  });

  it('preserves paragraph, table, paragraph body order in Word documents', async () => {
    const result = await readDocument('ordered.docx', fixture('ordered.docx'));
    expect(result.indexOf('Before the table')).toBeLessThan(result.indexOf('| Cell |'));
    expect(result.indexOf('| Cell |')).toBeLessThan(result.indexOf('After the table'));
  });

  it('reads Excel shared strings, sheet refs and formula values', async () => {
    const result = await readDocument('sample.xlsx', fixture('sample.xlsx'));
    expect(result).toContain('--- sheet Sales ---');
    expect(result).toContain('--- sheet Forecast ---');
    expect(result).toContain('| Sales!A2 | Widget |');
    expect(result).toContain('| Sales!B2 | =2+3 [5] |');
  });

  it('reads PowerPoint slide text and speaker notes', async () => {
    const result = await readDocument('sample.pptx', fixture('sample.pptx'));
    expect(result).toContain('--- slide 1 ---\n# Earlier slide in presentation');
    expect(result).toContain('--- slide 2 ---\n# Plan');
    expect(result).toContain('Ship Friday');
    expect(result).toContain('Speaker notes: Speaker note');
  });

  it('refuses old formats and hostile or malformed Office archives', async () => {
    await expect(readDocument('legacy.doc', fixture('legacy.doc'))).rejects.toThrow('Save');
    await expect(readDocument('encrypted.docx', fixture('encrypted.docx'))).rejects.toThrow(
      'encrypted',
    );
    await expect(readDocument('zip-bomb.docx', fixture('zip-bomb.docx'))).rejects.toThrow('100:1');
    await expect(readDocument('malformed.docx', fixture('malformed.docx'))).rejects.toThrow(
      'central directory',
    );
    await expect(readDocument('encrypted.pdf', fixture('encrypted.pdf'))).rejects.toThrow(
      'encrypted',
    );
  });

  it('honours an aborted signal before parsing', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readDocument('sample.docx', fixture('sample.docx'), controller.signal),
    ).rejects.toThrow('cancelled');
  });

  // Both archives below are valid up to the byte they break, so the refusal has
  // to name the structure. Reading an offset the archive promised without
  // checking it bought Node's own out-of-bounds RangeError, which said nothing
  // about the file and nothing about what to do next.
  it('refuses a central directory cut mid-entry by name, not with a buffer RangeError', async () => {
    const error = await readDocument('cut-central.docx', fixture('cut-central.docx')).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as Error).message).toMatch(/ZIP central directory: truncated entry 1\./);
  });

  it('refuses a local header promised past the end of the file, naming the part', async () => {
    const error = await readDocument('past-offset.docx', fixture('past-offset.docx')).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as Error).message).toMatch(
      /ZIP part "word\/document\.xml": local header is past the end of the file\./,
    );
  });
});

describe('xlsx cell parsing', () => {
  it('skips a self-closing cell instead of pairing it with the next one', () => {
    // An empty formatted cell, which is how Excel and LibreOffice write one. The
    // old pattern let its `/` sit inside the attribute group, so `A2` swallowed
    // `B2`'s body and the sheet lost the value 7 without saying so.
    expect(sheetRowCells('<row r="2"><c r="A2" s="1"/><c r="B2" t="s"><v>7</v></c></row>')).toEqual(
      [{ attributes: ' r="B2" t="s"', body: '<v>7</v>' }],
    );
  });

  it('returns the ordinary cells of a row, in order', () => {
    expect(sheetRowCells('<row r="3"><c r="A1" t="s"><v>1</v></c><c r="B1"><v>2</v></c></row>')).toEqual(
      [
        { attributes: ' r="A1" t="s"', body: '<v>1</v>' },
        { attributes: ' r="B1"', body: '<v>2</v>' },
      ],
    );
  });
});
