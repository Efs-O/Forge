import * as dgram from 'dgram';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import { makeRenderHtmlToImageTool } from '../../src/tools/renderHtmlToImageTool';
import type { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import type { MultimodalToolResult, RegisteredTool } from '../../src/tools/ToolRegistry';
import { listenLoopback } from '../support/listenLoopback';

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

describe('render_html_to_image preview network walls against real Chrome', () => {
  let root: string;
  let tool: RegisteredTool;
  let deliveries: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-preview-network-live-'));
    (
      vscode.workspace as unknown as {
        workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
      }
    ).workspaceFolders = [{ uri: { fsPath: root } }];
    deliveries = 0;
    const notifications = {
      deliverFile: async () => {
        deliveries += 1;
        return { kind: 'queued' as const, chats: 1 };
      },
      remainingFileDeliveries: () => 5,
    } as unknown as UserNotificationService;
    const getConfig = (): ForgeConfig =>
      ({
        active_model: 'primary',
        llama_server: {},
        models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
        browser: { channel: CHANNEL, headless: true },
        fetch: { allowed_hosts: ['cdn.jsdelivr.net', 'example.com', 'unpkg.com', 'httpbin.org'] },
      }) as ForgeConfig;
    tool = makeRenderHtmlToImageTool({ getConfig, notifications });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function preview(
    html: string,
    extra: Record<string, unknown> = {},
    isVisionModel = false,
  ): Promise<string | MultimodalToolResult> {
    await fs.writeFile(path.join(root, 'page.html'), html, 'utf8');
    return tool.handler(
      { mode: 'preview', path: 'page.html', ...extra },
      { beforeMutate: () => undefined, isVisionModel },
    );
  }

  it('reaches no local socket: zero TCP connections, zero UDP datagrams', async (ctx) => {
    let tcp = 0;
    let udp = 0;
    const server = net.createServer((socket) => {
      tcp += 1;
      socket.destroy();
    });
    const port = await listenLoopback(server);
    const udpSocket = dgram.createSocket('udp4');
    udpSocket.on('message', () => {
      udp += 1;
    });
    await new Promise<void>((resolve) => udpSocket.bind(0, '127.0.0.1', resolve));
    const udpPort = udpSocket.address().port;
    try {
      let result: string | MultimodalToolResult;
      try {
        result = await preview(
          '<html><body><script>' +
            `const t='127.0.0.1:${port}', l='localhost:${port}';` +
            'const tryIt=(f)=>{try{f()}catch(e){}};' +
            "tryIt(()=>fetch('http://'+t+'/f',{mode:'no-cors'}).catch(()=>{}));" +
            "tryIt(()=>fetch('http://'+t+'/post',{method:'POST',body:'x'}).catch(()=>{}));" +
            "tryIt(()=>fetch('http://'+l+'/f',{mode:'no-cors'}).catch(()=>{}));" +
            `tryIt(()=>{const s=document.createElement('script');s.src='http://'+t+'/script';document.head.appendChild(s)});` +
            "tryIt(()=>{new Image().src='http://'+t+'/img'});" +
            "tryIt(()=>new WebSocket('ws://'+t+'/ws'));" +
            "tryIt(()=>new WebSocket('ws://'+l+'/ws'));" +
            "tryIt(()=>new EventSource('http://'+t+'/es'));" +
            "tryIt(()=>navigator.sendBeacon('http://'+t+'/b','x'));" +
            `tryIt(()=>{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udpPort}'}]});` +
            'pc.createDataChannel("x");pc.createOffer().then((o)=>pc.setLocalDescription(o))});' +
            '</script></body></html>',
          { wait_ms: 3_000, width: 400, height: 300 },
        );
      } catch (err) {
        return skipIfNoBrowser(ctx, err);
      }
      expect(String(result)).toContain('Preview of page.html');
      expect(tcp).toBe(0);
      expect(udp).toBe(0);
      expect(deliveries).toBe(0);
      await fs.writeFile(
        path.join(root, 'image.html'),
        `<img src="http://127.0.0.1:${port}/image"><script>fetch('http://127.0.0.1:${port}/fetch')</script>`,
        'utf8',
      );
      await tool.handler(
        { mode: 'image', path: 'image.html' },
        { beforeMutate: () => undefined, isVisionModel: false },
      );
      expect(tcp).toBe(0);
      expect(udp).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      udpSocket.close();
    }
  }, 90_000);
});
