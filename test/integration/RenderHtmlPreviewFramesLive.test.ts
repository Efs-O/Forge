import * as fs from 'fs/promises';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { inflateSync } from 'zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import { makeRenderHtmlToImageTool } from '../../src/tools/renderHtmlToImageTool';
import type { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import type { MultimodalToolResult, RegisteredTool } from '../../src/tools/ToolRegistry';
import { useRealProfileForBrowser } from '../support/realHome';

// Chrome hangs on Windows under the throwaway home the temp guard sets; see the helper.
useRealProfileForBrowser();

const CHANNEL = 'chrome';

function skipIfNoBrowser(ctx: { skip: (msg: string) => void }, err: unknown): never | void {
  const message = err instanceof Error ? err.message : String(err);
  const missing =
    /browserType\.launch|Executable doesn't exist|please run.*install|channel .*not found|chrome could not be launched|msedge could not be launched/i.test(
      message,
    );
  if (!missing) throw err;
  ctx.skip(`no ${CHANNEL} on this host: ${message}`);
}

function httpbinReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.request(
      'https://httpbin.org/delay/1',
      { method: 'GET', timeout: 8_000 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) < 400);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function imagePngs(result: string | MultimodalToolResult): Buffer[] {
  if (typeof result === 'string') return [];
  return result.content.flatMap((part) =>
    part.type === 'image_url'
      ? [Buffer.from(part.image_url.url.replace(/^data:image\/png;base64,/, ''), 'base64')]
      : [],
  );
}

function resultText(result: string | MultimodalToolResult): string {
  return typeof result === 'string' ? result : result.text;
}

/** Return the left edge of a saturated red box at a canvas scanline. */
function redPixelLeft(png: Buffer, y: number): number | undefined {
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const data: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString('ascii', offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      bitDepth = chunk[8]!;
      colorType = chunk[9]!;
      interlace = chunk[12]!;
    } else if (kind === 'IDAT') {
      data.push(chunk);
    }
    offset += length + 12;
  }
  const bytesPerPixel = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as const)[colorType as 0 | 2 | 4 | 6];
  if (bitDepth !== 8 || interlace !== 0 || !bytesPerPixel || y >= height) {
    throw new Error(`Unsupported screenshot PNG format: ${bitDepth}-bit type ${colorType}`);
  }
  const rowBytes = width * bytesPerPixel;
  const raw = inflateSync(Buffer.concat(data));
  let previous = Buffer.alloc(rowBytes);
  for (let rowIndex = 0; rowIndex <= y; rowIndex += 1) {
    const filter = raw[rowIndex * (rowBytes + 1)]!;
    const current = Buffer.alloc(rowBytes);
    const start = rowIndex * (rowBytes + 1) + 1;
    for (let i = 0; i < rowBytes; i += 1) {
      const left = i >= bytesPerPixel ? current[i - bytesPerPixel]! : 0;
      const up = previous[i]!;
      const upperLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, upperLeft);
      current[i] = (raw[start + i]! + predictor) & 0xff;
    }
    if (rowIndex === y) {
      for (let x = 0; x < width; x += 1) {
        const startPixel = x * bytesPerPixel;
        const red = current[startPixel]!;
        const grayscale = colorType === 0 || colorType === 4;
        const green = grayscale ? red : current[startPixel + 1]!;
        const blue = grayscale ? red : current[startPixel + 2]!;
        const alpha =
          colorType === 4 ? current[startPixel + 1]! : colorType === 6 ? current[startPixel + 3]! : 255;
        if (red > 180 && green < 80 && blue < 80 && alpha > 0) return x;
      }
      return undefined;
    }
    previous = current;
  }
  return undefined;
}

function paeth(left: number, up: number, upperLeft: number): number {
  const p = left + up - upperLeft;
  const leftDistance = Math.abs(p - left);
  const upDistance = Math.abs(p - up);
  const upperLeftDistance = Math.abs(p - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance
    ? left
    : upDistance <= upperLeftDistance
      ? up
      : upperLeft;
}

describe('render_html_to_image preview page time against real Chrome', () => {
  let root: string;
  let tool: RegisteredTool;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-preview-frames-live-'));
    (
      vscode.workspace as unknown as {
        workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
      }
    ).workspaceFolders = [{ uri: { fsPath: root } }];
    const getConfig = (): ForgeConfig =>
      ({
        active_model: 'primary',
        llama_server: {},
        models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
        browser: { channel: CHANNEL, headless: true },
        fetch: { allowed_hosts: ['httpbin.org'] },
      }) as ForgeConfig;
    tool = makeRenderHtmlToImageTool({
      getConfig,
      notifications: {
        deliverFile: async () => ({ kind: 'queued' as const, chats: 1 }),
        remainingFileDeliveries: () => 5,
      } as unknown as UserNotificationService,
    });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function preview(
    html: string,
    extra: Record<string, unknown> = {},
  ): Promise<string | MultimodalToolResult> {
    await fs.writeFile(path.join(root, 'page.html'), html, 'utf8');
    return tool.handler(
      { mode: 'preview', path: 'page.html', ...extra },
      { beforeMutate: () => undefined, isVisionModel: true },
    );
  }

  it('captures identical PNGs at exact requested animation times', async (ctx) => {
    const html =
      '<style>html,body{margin:0}canvas{display:block}</style>' +
      '<canvas id="c" width="300" height="100"></canvas><script>' +
      'const g=document.getElementById("c").getContext("2d");' +
      'function draw(){const x=(performance.now()*0.1)%300;g.fillStyle="#fff";' +
      'g.fillRect(0,0,300,100);g.fillStyle="#f00";g.fillRect(x,40,20,20);' +
      'requestAnimationFrame(draw)}requestAnimationFrame(draw);</script>';
    let first: string | MultimodalToolResult;
    let second: string | MultimodalToolResult;
    try {
      first = await preview(html, { frames: [500, 1000], width: 300, height: 100 });
      second = await preview(html, { frames: [500, 1000], width: 300, height: 100 });
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    const firstPngs = imagePngs(first);
    const secondPngs = imagePngs(second);
    expect(firstPngs).toHaveLength(2);
    expect(firstPngs).toEqual(secondPngs);
    for (const [index, timeMs] of [500, 1000].entries()) {
      const left = redPixelLeft(firstPngs[index]!, 50);
      expect(left).toBeDefined();
      expect(Math.abs(left! - timeMs * 0.1)).toBeLessThanOrEqual(1.6);
    }
  }, 90_000);

  it('shows a time-driven animation after its delayed fetch completes', async (ctx) => {
    if (!(await httpbinReachable())) {
      ctx.skip('httpbin.org/delay/1 is offline or returned an error');
      return;
    }
    const html =
      '<style>html,body{margin:0}canvas{display:block}</style>' +
      '<canvas id="c" width="300" height="100"></canvas><script>' +
      'const g=document.getElementById("c").getContext("2d");' +
      'fetch("https://httpbin.org/delay/1").then(r=>r.json()).then(()=>{' +
      'console.log("asset-ready");function draw(){const x=(performance.now()*0.1)%300;' +
      'g.fillStyle="#fff";g.fillRect(0,0,300,100);g.fillStyle="#f00";' +
      'g.fillRect(x,40,20,20);requestAnimationFrame(draw)}requestAnimationFrame(draw)});</script>';
    let result: string | MultimodalToolResult;
    try {
      result = await preview(html, { frames: [1500], width: 300, height: 100 });
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(resultText(result)).toContain('log: asset-ready');
    expect(imagePngs(result)).toHaveLength(1);
    expect(redPixelLeft(imagePngs(result)[0]!, 50)).toBeDefined();
  }, 90_000);

  it('captures frame zero after releasing one key', async (ctx) => {
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<canvas id="c" width="300" height="100" tabindex="0"></canvas><script>' +
          'window.addEventListener("keydown",e=>{if(e.key==="ArrowRight")console.log("down")});' +
          'window.addEventListener("keyup",e=>{if(e.key==="ArrowRight")console.log("up")});</script>',
        {
          keys: [{ key: 'ArrowRight', hold_ms: 32 }],
          frames: [0],
          width: 300,
          height: 100,
        },
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(resultText(result)).toContain('log: down');
    expect(resultText(result)).toContain('log: up');
    expect(imagePngs(result)).toHaveLength(1);
  }, 90_000);
});
