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

  it('rejects paths outside the workspace', async () => {
    await expect(makeViewImageTool().handler({ path: path.join(root, '..', 'outside.png') })).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it('rejects mismatched or unsupported image formats', async () => {
    const target = path.join(root, 'fake.jpg');
    fs.writeFileSync(target, pngBytes());

    await expect(makeViewImageTool().handler({ path: 'fake.jpg' })).rejects.toThrow(
      /unsupported image format/,
    );
  });

  it('rejects images over the bounded upload size', async () => {
    const target = path.join(root, 'large.png');
    fs.writeFileSync(target, Buffer.alloc(MAX_VIEW_IMAGE_BYTES + 1));

    await expect(makeViewImageTool().handler({ path: 'large.png' })).rejects.toThrow(/too large/);
  });
});
