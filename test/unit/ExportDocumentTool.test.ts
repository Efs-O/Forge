import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inflateRawSync } from 'zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-export-document-'));
  return { workspace: { workspaceFolders: [{ uri: { fsPath: root } }] } };
});

import * as vscode from 'vscode';
import { readDocument } from '../../src/documents';
import { unzipTextParts } from '../../src/documents/zipXml';
import { makeExportDocumentTool } from '../../src/tools/exportDocumentTool';
import { applyOwnerOnlyWriteGuard, ownerOnlySetFor } from '../../src/tools/ownerPaths';

const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const copy = (fixture: string, name: string) =>
  fs.copyFileSync(
    new URL(`../fixtures/documents/${fixture}`, import.meta.url),
    path.join(root, name),
  );

function unzipPart(bytes: Buffer, wanted: string): Buffer | undefined {
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error('ZIP end record missing');
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let i = 0; i < count; i++) {
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (name === wanted) {
      const local = bytes.readUInt32LE(offset + 42);
      const localNameLength = bytes.readUInt16LE(local + 26);
      const localExtraLength = bytes.readUInt16LE(local + 28);
      const start = local + 30 + localNameLength + localExtraLength;
      const compressed = bytes.subarray(start, start + bytes.readUInt32LE(offset + 20));
      return bytes.readUInt16LE(offset + 10) === 0 ? compressed : inflateRawSync(compressed);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

beforeAll(() => {
  copy('sample.md', 'sample.md');
  copy('sample.png', 'sample.png');
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.forge', 'config.yaml'), 'active_model: safe\n');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('export_document', () => {
  it('refuses HTML to DOCX before resolving or reading the source', async () => {
    const tool = makeExportDocumentTool();
    await expect(
      tool.handler({ source: 'missing.html', format: 'docx', output: 'out.docx' }),
    ).rejects.toThrow('HTML sources can be exported to PDF; use a Markdown source for DOCX.');
    expect(fs.existsSync(path.join(root, 'out.docx'))).toBe(false);
  });

  it('creates a DOCX with headings, lists, tables and embedded Markdown images', async () => {
    const tool = makeExportDocumentTool();
    const result = await tool.handler({ source: 'sample.md', format: 'docx', output: 'out.docx' });
    expect(result).toContain('DOCX');
    const bytes = fs.readFileSync(path.join(root, 'out.docx'));
    const includeXml = (name: string) => /\.(?:xml|rels)$/.test(name);
    const parts = unzipTextParts(bytes, includeXml);
    expect(parts.get('word/document.xml')).toContain('Quarterly Report');
    const text = await readDocument('out.docx', bytes);
    expect(text).toContain('# Quarterly Report');
    expect(text).toContain('North');
    expect(text).toContain('| Region | Sales |');
    expect(bytes.toString('latin1')).toMatch(/word\/media\/[^\u0000]+\.png/);
    const imagePart = bytes.toString('latin1').match(/word\/media\/[^\u0000]+?\.png/)?.[0];
    expect(imagePart).toBeDefined();
    expect(unzipPart(bytes, imagePart!)).toEqual(fs.readFileSync(path.join(root, 'sample.png')));
    expect(tool.mutation?.paths({ output: 'out.docx' })).toEqual(['out.docx']);
  });

  it('exports PDF through the injected print boundary and writes atomically', async () => {
    const pdf = fs.readFileSync(new URL('../fixtures/documents/sample.pdf', import.meta.url));
    const printPdf = vi.fn(async () => pdf);
    const tool = makeExportDocumentTool({ printPdf });
    const result = await tool.handler({ source: 'sample.md', format: 'pdf', output: 'out.pdf' });
    expect(printPdf).toHaveBeenCalledOnce();
    expect(result).toContain('out.pdf');
    expect(await readDocument('out.pdf', fs.readFileSync(path.join(root, 'out.pdf')))).toContain(
      'PDF sample text',
    );
  });

  it('preserves replacement-token characters in PDF image alt text', async () => {
    fs.writeFileSync(path.join(root, 'alts.md'), '![Costs $100](sample.png)\n\n![a$\'b](sample.png)');
    let printed = '';
    const printPdf = vi.fn(async (html: string) => {
      printed = html;
      return Buffer.from('%PDF-test');
    });
    const tool = makeExportDocumentTool({ printPdf });
    await tool.handler({ source: 'alts.md', format: 'pdf', output: 'alts.pdf' });
    expect(printed).toContain('alt="Costs $100"');
    expect(printed).toContain('alt="a$&#39;b"');
  });

  it('omits images over the PDF image budget and lists them in the result', async () => {
    fs.writeFileSync(path.join(root, 'large.png'), Buffer.alloc(450_000, 1));
    fs.writeFileSync(path.join(root, 'image.md'), '![Large capture](large.png)');
    let printed = '';
    const printPdf = vi.fn(async (html: string) => {
      printed = html;
      return Buffer.from('%PDF-test');
    });
    const result = await makeExportDocumentTool({ printPdf }).handler({
      source: 'image.md', format: 'pdf', output: 'image.pdf',
    });
    expect(printed).toContain('image omitted: large.png (too large for PDF export)');
    expect(result).toContain('Images omitted because they were too large for PDF export: large.png');
  });

  // One bad link used to abort the whole export: a report with a stale
  // screenshot came out as nothing at all, and the model had to guess which
  // image was the problem. Now the document is written and the names come back.
  it('writes a DOCX around images it cannot embed and names the two it skipped', async () => {
    const outside = path.join(os.tmpdir(), 'forge-export-outside.png');
    fs.writeFileSync(outside, Buffer.alloc(200, 1));
    fs.writeFileSync(
      path.join(root, 'mixed.md'),
      '![Report](sample.png)\n\n![Gone](missing.png)\n\n![Out](../forge-export-outside.png)\n',
    );
    try {
      const result = await makeExportDocumentTool().handler({
        source: 'mixed.md',
        format: 'docx',
        output: 'mixed.docx',
      });
      const bytes = fs.readFileSync(path.join(root, 'mixed.docx'));
      expect(bytes.length).toBeGreaterThan(1000);
      expect(bytes.toString('latin1')).toMatch(/word\/media\/[^\u0000]+\.png/);
      expect(await readDocument('mixed.docx', bytes)).toContain('Report');
      expect(result).toContain('Images the DOCX export did not embed');
      expect(result).toContain('missing.png');
      expect(result).toContain('forge-export-outside.png');
      expect(result).not.toContain('sample.png');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  // The total, not only the per-image cap: four fit and the fifth would push
  // the document past 20 MB of images, so it is left out and named.
  it('holds a DOCX to its total image budget and names the one that did not fit', async () => {
    for (const name of ['a.png', 'b.png', 'c.png', 'd.png', 'e.png'])
      fs.writeFileSync(path.join(root, name), Buffer.alloc(4_200_000, 1));
    fs.writeFileSync(
      path.join(root, 'many.md'),
      '![A](a.png)\n\n![B](b.png)\n\n![C](c.png)\n\n![D](d.png)\n\n![E](e.png)\n',
    );
    const result = await makeExportDocumentTool().handler({
      source: 'many.md',
      format: 'docx',
      output: 'many.docx',
    });
    expect(result).toContain('did not embed');
    expect(result).toContain('e.png');
    expect(result).not.toContain('a.png');
    expect(fs.existsSync(path.join(root, 'many.docx'))).toBe(true);
  });

  it('refuses secret outputs, Forge-owned files and paths outside allowed roots', async () => {
    const tool = makeExportDocumentTool();
    expect(tool.refuseBeforeApproval?.({ output: '.env' })).toContain('secret path');
    const guarded = applyOwnerOnlyWriteGuard(tool, () =>
      // A policy path that does not exist keeps config.yaml owner-only on a machine
      // whose real ~/.forge/policy.yaml does exist.
      ownerOnlySetFor({ workspaceRoot: root, policyPath: path.join(root, 'no-policy.yaml') }),
    );
    await expect(
      guarded.handler({ source: 'sample.md', format: 'docx', output: '.forge/config.yaml' }),
    ).rejects.toThrow(/Forge's own files/);
    await expect(
      tool.handler({
        source: 'sample.md',
        format: 'docx',
        output: path.join(os.tmpdir(), 'outside.docx'),
      }),
    ).rejects.toThrow(/outside the workspace/);
  });
});
