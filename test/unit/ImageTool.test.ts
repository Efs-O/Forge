import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({ workspace: { workspaceFolders: undefined } }));

import { MAX_VIEW_IMAGE_BYTES, makeViewImageTool } from '../../src/tools/imageTool';

let root: string;

function setWorkspace(folder: string): void {
  const workspace = vscode.workspace as unknown as {
    workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
  };
  workspace.workspaceFolders = [{ uri: { fsPath: folder } }];
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

function webpBytes(): Buffer {
  return Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ]);
}

/** The message a view_image call refuses with, for the file in the fixture. */
async function refusalFor(file: string): Promise<string> {
  try {
    await makeViewImageTool().handler({ path: file });
    return '<no refusal>';
  } catch (error) {
    return (error as Error).message;
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-view-image-'));
  setWorkspace(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('view_image', () => {
  it('returns the image as multimodal content for a workspace-relative path', async () => {
    const target = path.join(root, 'assets', 'diagram.png');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, pngBytes());

    const result = await makeViewImageTool().handler({ path: 'assets/diagram.png' });

    expect(typeof result).toBe('object');
    if (typeof result === 'string') throw new Error('expected multimodal result');
    expect(result.text).toContain('assets' + path.sep + 'diagram.png');
    expect(result.content).toEqual([
      { type: 'text', text: result.text },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${pngBytes().toString('base64')}` },
      },
    ]);
  });

  it('renders a PDF page into multimodal image content and passes the requested pages', async () => {
    const target = path.join(root, 'scan.pdf');
    fs.copyFileSync(new URL('../fixtures/documents/scanned.pdf', import.meta.url), target);
    const renderer = vi.fn(async (_bytes: Buffer, pageNumbers: readonly number[]) =>
      pageNumbers.map((page) => ({ page, png: Buffer.from('png'), width: 1, height: 1 })),
    );
    const result = await makeViewImageTool(undefined, renderer).handler({
      path: 'scan.pdf',
      pages: '2-3',
    });
    expect(renderer).toHaveBeenCalledWith(expect.any(Buffer), [2, 3], undefined, undefined);
    expect(typeof result === 'string' ? result : result.content).toHaveLength(3);
    expect(typeof result === 'string' ? result : result.text).toContain('pages 2, 3');
  });

  it('reads an image outside the workspace and names it by absolute path', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-view-outside-'));
    const target = path.join(outside, 'outside.png');
    fs.writeFileSync(target, pngBytes());
    try {
      const result = await makeViewImageTool().handler({ path: target });
      expect(typeof result === 'string' ? result : result.text).toContain(
        fs.realpathSync.native(target),
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses bytes that are not an image at all, and says what they may be', async () => {
    fs.writeFileSync(path.join(root, 'page.png'), '<html><body>a saved web page</body></html>');

    expect(await refusalFor('page.png')).toBe(
      'view_image: the file is not a PNG, JPEG, GIF, BMP or WebP image (it may be a web page or ' +
        'another format saved with an image extension). Check what it is with the shell tool before ' +
        'viewing it again.',
    );
  });

  it('refuses an image whose extension is not an image extension, naming the type and the fix', async () => {
    fs.writeFileSync(path.join(root, 'shot.dat'), pngBytes());

    expect(await refusalFor('shot.dat')).toBe(
      'view_image: the file is a PNG image but its extension .dat is not an image extension. ' +
        'Rename or copy it to .png and view that.',
    );
  });

  it('names the missing extension as (none)', async () => {
    fs.writeFileSync(path.join(root, 'noext'), pngBytes());

    expect(await refusalFor('noext')).toBe(
      "view_image: the file is a PNG image but its extension (none) is not an image extension. " +
        'Rename or copy it to .png and view that.',
    );
  });

  it('refuses an image whose extension belongs to another type, naming both', async () => {
    fs.writeFileSync(path.join(root, 'shot.png'), webpBytes());

    expect(await refusalFor('shot.png')).toBe(
      'view_image: the file is a WebP image but its extension .png is for PNG. ' +
        'Rename or copy it to .webp and view that.',
    );
  });

  it('still loads an image whose bytes match its extension', async () => {
    fs.writeFileSync(path.join(root, 'real.png'), pngBytes());

    const result = await makeViewImageTool().handler({ path: 'real.png' });

    expect(typeof result === 'string' ? result : result.text).toContain('image/png');
  });

  it('rejects images over the bounded upload size', async () => {
    const target = path.join(root, 'large.png');
    fs.writeFileSync(target, Buffer.alloc(MAX_VIEW_IMAGE_BYTES + 1));

    await expect(makeViewImageTool().handler({ path: 'large.png' })).rejects.toThrow(/too large/);
  });
});
