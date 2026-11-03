import { requiredPart, unzipTextParts, xmlElements, xmlText } from './zipXml';

function paragraph(xml: string): string {
  const text = xmlElements(xml, 'w:t').map(xmlText).join('');
  if (!text.trim()) return '';
  const style = xml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/i)?.[1] ?? '';
  const heading = style.match(/Heading([1-6])/i)?.[1];
  return heading ? `${'#'.repeat(Number(heading))} ${text}` : text;
}

export function readDocx(bytes: Buffer, abortSignal?: AbortSignal): string {
  const parts = unzipTextParts(bytes, (name) => /\.(?:xml|rels)$/.test(name), abortSignal);
  const xml = requiredPart(parts, 'word/document.xml');
  const body = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)?.[1];
  if (!body) throw new Error('ZIP part "word/document.xml": document body is malformed.');
  const blocks: Array<{ index: number; text: string }> = [];
  const tablesInBody = [...body.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)];
  const paragraphsOnly = body.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/g, (table) =>
    ' '.repeat(table.length),
  );
  for (const match of paragraphsOnly.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const text = paragraph(match[0]);
    if (text) blocks.push({ index: match.index ?? 0, text });
  }
  for (const match of tablesInBody) {
    const rows = xmlElements(match[0], 'w:tr').map((row) =>
      xmlElements(row, 'w:tc').map((cell) =>
        xmlElements(cell, 'w:p').map(paragraph).filter(Boolean).join(' '),
      ),
    );
    const text = rows
      .map((cells) => `| ${cells.join(' | ')} |\n| ${cells.map(() => '---').join(' | ')} |`)
      .join('\n');
    blocks.push({ index: match.index ?? 0, text });
  }
  const text = blocks
    .sort((a, b) => a.index - b.index)
    .map((block) => block.text)
    .join('\n\n')
    .trim();
  if (!text) throw new Error('ZIP part "word/document.xml": no readable text found.');
  return text;
}
