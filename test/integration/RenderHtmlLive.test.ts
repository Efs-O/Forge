import * as http from 'http';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import { makeRenderHtmlToImageTool } from '../../src/tools/renderHtmlToImageTool';
import type { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import type { RegisteredTool, ToolHandlerContext } from '../../src/tools/ToolRegistry';

/**
 * The plan's "→ integration" rows for `render_html_to_image`. The unit suite
 * drives a fake Playwright, which proves the tool ASKS for the hardened setup
 * but cannot prove real Chrome accepts it — the launch-flag set, `full_page`
 * geometry, and above all that the network really is closed. Those are exactly
 * the assumptions a fake rubber-stamps, so they run against real headless
 * Chrome here and skip with a message where no browser is installed (the shape
 * `test/integration/BrowserTools.test.ts` already uses).
 *
 * A local HTTP server is part of the fixture: the security claim is not
 * "the render looked fine", it is "the server recorded zero hits".
 */

const CHANNEL = 'chrome';

/**
 * Skip ONLY for "this host has no browser", so a security or behaviour
 * regression can never be reported as "Chrome unavailable" (Codex review
 * NICE-TO-HAVE). Playwright's own launch failures name the browser type, the
 * missing executable, or the channel.
 */
function skipIfNoBrowser(ctx: { skip: (msg: string) => void }, err: unknown): never | void {
  const message = err instanceof Error ? err.message : String(err);
  const missing =
    /browserType\.launch|Executable doesn't exist|please run.*install|channel .*not found|chrome could not be launched|msedge could not be launched/i.test(
      message,
    );
  if (!missing) throw err;
  ctx.skip(`no ${CHANNEL} on this host: ${message}`);
}

function pngDims(png: Buffer): { width: number; height: number } {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG');
  }
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('render_html_to_image against real Chrome', () => {
  let root: string;
  let tool: RegisteredTool;
  let delivered: Array<{ imagePath: string; text: string }>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-render-live-'));
    (
      vscode.workspace as unknown as {
        workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
      }
    ).workspaceFolders = [{ uri: { fsPath: root } }];
    delivered = [];
    const notifications = {
      deliverFile: async (opts: { imagePath: string; text: string }) => {
        delivered.push(opts);
        return { kind: 'queued' as const, chats: 1 };
      },
    } as unknown as UserNotificationService;
    const getConfig = (): ForgeConfig =>
      ({
        active_model: 'primary',
        llama_server: {},
        models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
        image_generation: { output_dir: 'renders' },
        browser: { channel: CHANNEL, headless: true },
      }) as ForgeConfig;
    tool = makeRenderHtmlToImageTool({ getConfig, notifications });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function render(
    args: Record<string, unknown>,
    context?: Partial<ToolHandlerContext>,
  ): Promise<string> {
    return (await tool.handler(args, {
      beforeMutate: () => undefined,
      ...context,
    })) as string;
  }

  async function pngFor(deliveryIndex = 0): Promise<Buffer> {
    const written = await fs.readdir(path.join(root, 'renders'));
    return fs.readFile(path.join(root, 'renders', written[deliveryIndex] ?? written[0]!));
  }

  it('renders a poster to a PNG Chrome actually accepted', async (ctx) => {
    let result: string;
    try {
      result = await render({
        html:
          '<!doctype html><html><head><title>Neon Poster</title></head>' +
          '<body style="margin:0;background:#0b0b12">' +
          '<div style="font:700 96px system-ui;color:#39ff14;padding:80px">NEON</div>' +
          '</body></html>',
        width: 800,
        height: 600,
      });
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(result).toContain('Rendered');
    expect(result).toContain('Queued for 1 remote chat(s).');    expect(delivered).toHaveLength(1);

    const png = await pngFor();
    expect(png.length).toBeGreaterThan(1_000);
    // Viewport-clipped by default: exactly width x height, whatever the content is.
    expect(pngDims(png)).toEqual({ width: 800, height: 600 });
    expect(path.basename(delivered[0]!.imagePath)).toMatch(/-neon-poster\.png$/);
  }, 90_000);

  it('full_page grows the PNG past the viewport; the default clips it', async (ctx) => {
    // Same <title> on purpose: the tool now deconflicts a name collision to
    // `-2`, which is what makes two renders in one second both deliverable.
    const tall = (title: string): string =>
      '<!doctype html><html><head><title>' +
      title +
      '</title></head><body style="margin:0">' +
      '<div style="height:3000px;background:linear-gradient(#fff,#000)"></div>' +
      '</body></html>';
    let clipped: string;
    try {
      clipped = await render({ html: tall('Same Title'), width: 600, height: 400 });
      await render({ html: tall('Same Title'), width: 600, height: 400, full_page: true });
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(clipped).toContain('at 600x400');
    // Read them in DELIVERY order, not sorted-filename order: `-2.png` sorts
    // before `.png` because '-' (0x2D) < '.' (0x2E), so a sort would swap them.
    // Whether the second name is a `-2` deconfliction or a fresh stamp depends
    // on which side of a second boundary the two renders land on; what must
    // always hold is that they are DIFFERENT paths.
    const [nameA, nameB] = delivered.map((d) => path.basename(d.imagePath));
    expect(nameA).not.toBe(nameB);
    const first = pngDims(await fs.readFile(delivered[0]!.imagePath));
    const second = pngDims(await fs.readFile(delivered[1]!.imagePath));
    expect(first).toEqual({ width: 600, height: 400 });
    // The poster case: content height, not viewport height, and inside the cap.
    expect(second.width).toBe(600);
    expect(second.height).toBeGreaterThanOrEqual(3000);
    expect(second.height).toBeLessThanOrEqual(16_384);
  }, 120_000);

  it('blocks every external request: a local server records zero hits', async (ctx) => {
    // The load-bearing security row: an <img>, an <iframe> and a CSS @import all
    // point at a real listening server. If any of them reached it, the render
    // engine could be used to port-scan the machine or exfiltrate via URL.
    const hits: string[] = [];
    const server: http.Server = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(Buffer.from('89504e470d0a1a0a', 'hex'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      let result: string;
      try {
        result = await render({
          html:
            `<html><head><title>Leak Attempt</title>` +
            `<style>@import url('http://127.0.0.1:${port}/css');</style></head><body>` +
            `<img src="http://127.0.0.1:${port}/img.png">` +
            `<iframe src="http://127.0.0.1:${port}/frame"></iframe>` +
            `<img src="https://example.invalid/x.png">` +
            '</body></html>',
          width: 400,
          height: 300,
        });
      } catch (err) {
        return skipIfNoBrowser(ctx, err);
      }
      // The render still SUCCEEDS — blocking is silent, not an error.
      expect(result).toContain('Rendered');
      expect(hits).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);

  it('cannot read the local disk: no file:// resource is ever loaded', async (ctx) => {
    // Deterministic proof rather than a size heuristic: render the SAME page
    // twice, once pointing at a real 300x200 red SVG on disk and once at a
    // missing file. If Chrome loaded the real one, the two PNGs differ; if the
    // file:// scheme is closed, they are byte-identical. `setContent` gives the
    // page an about:blank origin and the hardened launch args keep file: off the
    // table — this asserts that, not just that the output looked small.
    const dir = path.join(root, 'secrets');
    await fs.mkdir(dir, { recursive: true });
    const secret = path.join(dir, 'secret.svg');
    await fs.writeFile(
      secret,
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">' +
        '<rect width="300" height="200" fill="#ff0000"/></svg>',
    );
    const url = (file: string): string => `file:///${file.replace(/\\/g, '/')}`;
    const page = (file: string): string =>
      `<html><body style="margin:0"><img src="${url(file)}" width="300" height="200"></body></html>`;

    try {
      await render({ html: page(secret), width: 300, height: 200 });
      await render({ html: page(path.join(dir, 'missing.svg')), width: 300, height: 200 });
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }

    const written = (await fs.readdir(path.join(root, 'renders'))).sort();
    expect(written).toHaveLength(2);
    const withSecret = await fs.readFile(path.join(root, 'renders', written[0]!));
    const withMissing = await fs.readFile(path.join(root, 'renders', written[1]!));
    expect(withSecret.equals(withMissing)).toBe(true);
  }, 90_000);
});
