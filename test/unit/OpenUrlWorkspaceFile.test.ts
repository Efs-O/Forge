import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { spawn } from 'child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn(async (_uri: { fsPath: string }) => true),
}));
vi.mock('vscode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-open-workspace-file-'));
  return {
    workspace: { workspaceFolders: [{ uri: { fsPath: root } }] },
    env: { openExternal },
    Uri: { file: (fsPath: string) => ({ fsPath }), parse: (value: string) => ({ value }) },
  };
});

import * as vscode from 'vscode';
import { makeOpenUrlTool } from '../../src/tools/uxTools';
import { openSystemBrowser } from '../../src/tools/systemBrowser';

const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const copy = (fixture: string, name: string) =>
  fs.copyFileSync(
    new URL(`../fixtures/documents/${fixture}`, import.meta.url),
    path.join(root, name),
  );

beforeAll(() => {
  copy('sample.md', 'sample.md');
  fs.mkdirSync(path.join(root, 'one'), { recursive: true });
  fs.mkdirSync(path.join(root, 'two'), { recursive: true });
  fs.writeFileSync(path.join(root, 'one', 'README.md'), '# One');
  fs.writeFileSync(path.join(root, 'two', 'README.md'), '# Two');
  copy('sample.png', 'sample.png');
  copy('sample.pdf', 'sample.pdf');
  fs.writeFileSync(path.join(root, 'page.html'), '<h1>Preview</h1>');
  fs.writeFileSync(path.join(root, '.env'), 'secret');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function fakeSpawn(emit: 'spawn' | 'error' = 'spawn') {
  const child = new EventEmitter() as ChildProcess;
  child.unref = vi.fn();
  const spawnProcess = vi.fn((() => {
    queueMicrotask(() => {
      if (emit === 'error') child.emit('error', new Error('browser missing'));
      else child.emit('spawn');
    });
    return child;
  }) as typeof spawn);
  return { child, spawnProcess };
}

describe('open_url_in_browser workspace files', () => {
  it('asks with the URL for HTTP(S), but not workspace HTML paths', () => {
    const approval = makeOpenUrlTool().approval;
    expect(approval?.({ url: 'https://example.com/' })?.detail).toBe('https://example.com/');
    expect(approval?.({ url: 'page.html' })).toBeUndefined();
  });

  it('opens HTTP(S) URLs through the system browser and returns the exact success text', async () => {
    const { spawnProcess } = fakeSpawn();
    const url = 'https://example.com/';
    const result = await makeOpenUrlTool({ spawnProcess }).handler({ url });
    expect(result).toBe('Opened https://example.com/ in the default browser.');
    expect(spawnProcess).toHaveBeenCalledWith(
      process.platform === 'win32'
        ? 'rundll32.exe'
        : process.platform === 'darwin'
          ? 'open'
          : 'xdg-open',
      process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url],
      { shell: false, detached: true, stdio: 'ignore' },
    );
  });

  it('returns the exact system browser spawn error', async () => {
    const { spawnProcess } = fakeSpawn('error');
    const error = await makeOpenUrlTool({ spawnProcess })
      .handler({ url: 'https://example.com/' })
      .catch((caught: unknown) => caught as Error);
    expect(error.message).toBe(
      'open_url_in_browser: could not start the system browser: browser missing',
    );
  });

  it.each([
    ['win32', 'rundll32.exe', ['url.dll,FileProtocolHandler', 'https://example.com/']],
    ['darwin', 'open', ['https://example.com/']],
    ['linux', 'xdg-open', ['https://example.com/']],
  ] as const)('uses the %s browser launcher argv', async (platform, command, args) => {
    const { spawnProcess } = fakeSpawn();
    await openSystemBrowser('https://example.com/', platform, spawnProcess);
    expect(spawnProcess.mock.calls[0]?.[0]).toBe(command);
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual(args);
  });

  it('opens workspace HTML/PDF and renders Markdown to a styled preview', async () => {
    const previewDir = path.join(root, '.forge', 'tmp', 'preview');
    fs.mkdirSync(previewDir, { recursive: true });
    const stale = path.join(previewDir, 'old.html');
    fs.writeFileSync(stale, 'old preview');
    fs.utimesSync(
      stale,
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
    );
    const tool = makeOpenUrlTool();
    await tool.handler({ url: 'page.html' });
    expect(path.basename(String(openExternal.mock.calls[0]?.[0]?.fsPath))).toBe('page.html');
    await tool.handler({ url: 'sample.pdf' });
    expect(path.basename(String(openExternal.mock.calls[1]?.[0]?.fsPath))).toBe('sample.pdf');
    const result = await tool.handler({ url: 'sample.md' });
    expect(result).toContain('Opened');
    expect(fs.existsSync(stale)).toBe(false);
    const preview = fs.readdirSync(previewDir).find((name) => name.startsWith('sample-'))!;
    expect(preview).toMatch(/^sample-[a-f0-9]{8}\.html$/);
    const html = fs.readFileSync(path.join(previewDir, preview), 'utf8');
    expect(html).toContain('<h1>Quarterly Report</h1>');
    expect(html).toContain('data:image/png;base64,');
  });

  // The preview page opens in the user's browser, so it gets the same kind of
  // total budget the PDF export has: without one, a Markdown file of
  // screenshots writes a hundred-megabyte HTML page that takes minutes to open.
  it('keeps a Markdown preview inside its image budget and names what it left out', async () => {
    fs.writeFileSync(path.join(root, 'big1.png'), Buffer.alloc(5_000_000, 1));
    fs.writeFileSync(path.join(root, 'big2.png'), Buffer.alloc(5_000_000, 1));
    fs.writeFileSync(path.join(root, 'big.md'), '![One](big1.png)\n\n![Two](big2.png)\n');
    const result = await makeOpenUrlTool().handler({ url: 'big.md' });
    const previewDir = path.join(root, '.forge', 'tmp', 'preview');
    const preview = fs.readdirSync(previewDir).find((name) => name.startsWith('big-'))!;
    const html = fs.readFileSync(path.join(previewDir, preview), 'utf8');
    expect(html).toContain('data:image/png;base64,');
    expect(html).toContain('image omitted: big2.png (over the preview image budget)');
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThan(8 * 1024 * 1024 + 4096);
    expect(result).toContain('Left out of the preview over the image budget: big2.png');
  });

  it('keeps same-named Markdown previews from different folders separate', async () => {
    const tool = makeOpenUrlTool();
    await tool.handler({ url: 'one/README.md' });
    await tool.handler({ url: 'two/README.md' });
    const previews = fs
      .readdirSync(path.join(root, '.forge', 'tmp', 'preview'))
      .filter((name) => name.startsWith('README-'));
    expect(previews).toHaveLength(2);
    const contents = previews.map((name) =>
      fs.readFileSync(path.join(root, '.forge', 'tmp', 'preview', name), 'utf8'),
    );
    expect(contents.some((html) => html.includes('<h1>One</h1>'))).toBe(true);
    expect(contents.some((html) => html.includes('<h1>Two</h1>'))).toBe(true);
  });

  it('refuses secret paths and files outside workspace and extra roots', async () => {
    const tool = makeOpenUrlTool();
    await expect(tool.handler({ url: '.env' })).rejects.toThrow(/secret path/);
    await expect(tool.handler({ url: path.join(os.tmpdir(), 'outside.md') })).rejects.toThrow(
      /outside the workspace/,
    );
  });
});
