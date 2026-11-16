import {
  requiredPart,
  resolveOpcTarget,
  unzipTextParts,
  xmlAttr,
  xmlElements,
  xmlText,
} from './zipXml';

/** The `<c>` cells of one `<row>`, as their attribute text and inner XML. A
 *  self-closing `<c r="A2" s="1"/>` — what Excel and LibreOffice write for an
 *  empty formatted cell — is skipped, not paired with the cell after it: the old
 *  pattern let its `/` sit inside the attribute group, so the empty cell ate the
 *  next cell's body and that value disappeared from the sheet. */
export function sheetRowCells(row: string): Array<{ attributes: string; body: string }> {
  const cells: Array<{ attributes: string; body: string }> = [];
  for (const match of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (match[2] === undefined) continue;
    cells.push({ attributes: match[1] ?? '', body: match[2] });
  }
  return cells;
}

export function readXlsx(bytes: Buffer, abortSignal?: AbortSignal): string {
  const parts = unzipTextParts(bytes, (name) => /\.(?:xml|rels)$/.test(name), abortSignal);
  const workbook = requiredPart(parts, 'xl/workbook.xml');
  const rels = requiredPart(parts, 'xl/_rels/workbook.xml.rels');
  const targets = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*\/?\s*>/g)].map((match) => [
      xmlAttr(match[0], 'Id') ?? '',
      xmlAttr(match[0], 'Target') ?? '',
    ]),
  );
  const stringsXml = parts.get('xl/sharedStrings.xml') ?? '';
  const shared = xmlElements(stringsXml, 'si').map((item) =>
    xmlElements(item, 't').map(xmlText).join(''),
  );
  const output: string[] = [];
  for (const sheetTag of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    if (abortSignal?.aborted) throw new Error('XLSX parsing cancelled.');
    const name = xmlAttr(sheetTag[0], 'name') ?? 'Sheet';
    const relation = xmlAttr(sheetTag[0], 'r:id');
    const target = relation ? targets.get(relation) : undefined;
    if (!target)
      throw new Error(`ZIP part "xl/workbook.xml": relationship for sheet "${name}" is missing.`);
    const file = resolveOpcTarget('xl/workbook.xml', target);
    const sheet = requiredPart(parts, file);
    const rows = xmlElements(sheet, 'row')
      .flatMap((row) => {
        const cells = sheetRowCells(row).map((matched) => {
          const attributes = `<c ${matched.attributes}>`;
          const cell = matched.body;
          const ref = xmlAttr(attributes, 'r') ?? '?';
          const type = xmlAttr(attributes, 't');
          const value = xmlElements(cell, 'v').map(xmlText)[0] ?? '';
          const formula = xmlElements(cell, 'f').map(xmlText)[0];
          let shown =
            type === 's'
              ? (shared[Number(value)] ?? '')
              : type === 'inlineStr'
                ? xmlElements(cell, 't').map(xmlText).join('')
                : value;
          if (formula) shown = `=${formula}${shown ? ` [${shown}]` : ''}`;
          return `| ${name}!${ref} | ${shown} |`;
        });
        return cells;
      })
      .filter(Boolean);
    output.push(
      `--- sheet ${name} ---\n${rows.length ? '| Cell | Value |\n| --- | --- |\n' + rows.join('\n') : '(empty sheet)'}`,
    );
  }
  if (!output.length)
    throw new Error('ZIP part "xl/workbook.xml": workbook contains no readable sheets.');
  return output.join('\n\n');
}
