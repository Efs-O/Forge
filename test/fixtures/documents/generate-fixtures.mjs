import fs from 'node:fs';
import { deflateRawSync, deflateSync } from 'node:zlib';

const output = new URL('./', import.meta.url);
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
function zip(parts, { encrypted = false, bomb = false, cutCentral = 0, pastEndLocalOffset = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const filename = Buffer.from(name);
    const raw = Buffer.from(text);
    const compressed = bomb ? Buffer.from([0x03, 0x00]) : deflateRawSync(raw);
    const flags = encrypted ? 1 : 0;
    const local = Buffer.alloc(30 + filename.length);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bomb ? 10_000 : raw.length, 22);
    local.writeUInt16LE(filename.length, 26); filename.copy(local, 30);
    locals.push(local, compressed);
    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bomb ? 10_000 : raw.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); filename.copy(central, 46);
    centrals.push(central);
    offset += local.length + compressed.length;
  }
  const directory = Buffer.concat(centrals).subarray(0, cutCentral || undefined);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(parts).length, 8);
  end.writeUInt16LE(Object.keys(parts).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const out = Buffer.concat([...locals, directory, end]);
  // The central entry's own promise about where its local header sits, moved past
  // the last byte of the file. Read at that offset, so it has to be refused first.
  if (pastEndLocalOffset) out.writeUInt32LE(out.length + 500, offset + 42);
  return out;
}
function pdf(text = '') {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = text ? `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n'; const offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}
function png() {
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const body = Buffer.concat([name, data]);
    const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([header, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 30, 120, 220, 255]))), chunk('IEND', Buffer.alloc(0)),
  ]);
}
function write(name, bytes) { fs.writeFileSync(new URL(name, output), bytes); }
const docx = {
  'word/document.xml': '<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p><w:p><w:r><w:t>Revenue grew.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:tc></w:tr></w:tbl></w:body></w:document>',
};
const orderedDocx = {
  'word/document.xml': '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Before the table</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After the table</w:t></w:r></w:p></w:body></w:document>',
};
const xlsx = {
  'xl/workbook.xml': '<workbook xmlns:r="x"><sheets><sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Costs" sheetId="2" r:id="rId2"/><sheet name="Forecast" sheetId="3" r:id="rId3"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><t>Widget</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>Qty</v></c></row><row><c r="A2" t="s"><v>1</v></c><c r="B2"><f>2+3</f><v>5</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row><c r="A1"><v>Expenses</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet3.xml': '<worksheet><sheetData><row><c r="A1"><v>Forecast 2027</v></c></row></sheetData></worksheet>',
};
const pptx = {
  'ppt/presentation.xml': '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="2" r:id="rId2"/><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
  'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Plan</a:t></a:r></a:p><a:p><a:r><a:t>Ship Friday</a:t></a:r></a:p></p:sld>',
  'ppt/slides/_rels/slide1.xml.rels': '<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide3.xml"/></Relationships>',
  'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Earlier slide in presentation</a:t></a:r></a:p></p:sld>',
  'ppt/notesSlides/notesSlide3.xml': '<p:notes><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>',
};
write('sample.pdf', pdf('PDF sample text'));
write('scanned.pdf', pdf());
write('sample.docx', zip(docx)); write('ordered.docx', zip(orderedDocx)); write('sample.xlsx', zip(xlsx)); write('sample.pptx', zip(pptx));
write('sample.png', png());
write('sample.md', Buffer.from('# Quarterly Report\n\nRevenue improved.\n\n- North\n- South\n\n| Region | Sales |\n| --- | ---: |\n| North | 12 |\n\n![Tiny sample](sample.png)\n'));
write('legacy.doc', Buffer.from('old word format'));
write('encrypted.docx', zip(docx, { encrypted: true }));
write('zip-bomb.docx', zip({ 'word/document.xml': '<x>'.repeat(3_000) }, { bomb: true }));
write('malformed.docx', Buffer.from('PK\x03\x04truncated'));
// Two archives that are valid up to the byte they break: the first has its one
// central entry cut 22 bytes into its 46-byte fixed header, so the fields past
// the cut sit where the end record is; the second keeps its directory intact
// but promises a local header 500 bytes past the last byte of the file. Each
// used to answer Node's own "outside buffer bounds" RangeError instead of a
// named ZIP refusal.
write('cut-central.docx', zip(docx, { cutCentral: 22 }));
write('past-offset.docx', zip(docx, { pastEndLocalOffset: true }));
