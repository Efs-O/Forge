import * as dgram from 'dgram';
import { lookup as dnsLookup } from 'dns/promises';
import * as fs from 'fs/promises';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import { makeRenderHtmlToImageTool } from '../../src/tools/renderHtmlToImageTool';
import type { UserNotificationService } from '../../src/sidebar/UserNotificationService';
import type { MultimodalToolResult, RegisteredTool } from '../../src/tools/ToolRegistry';

/**
 * Preview mode against real headless Chrome (RENDER_PREVIEW_PLAN.md). With the
 * page's scripts ON, the security claim is stronger than image mode's, so it
 * is measured at the socket: a local TCP listener counts connections and a UDP
 * socket counts datagrams. `context.route` sees neither WebSocket nor WebRTC
 * STUN traffic, so only a real socket proves those walls hold.
 */

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

/** Whether the allowlisted CDN is reachable from this host at all. */
async function cdnReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.request(
      'https://cdn.jsdelivr.net/npm/three@0.160.1/package.json',
      { method: 'HEAD', timeout: 8_000 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) < 400);
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

describe('render_html_to_image preview against real Chrome', () => {
  let root: string;
  let tool: RegisteredTool;
  let deliveries: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-preview-live-'));
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
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
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
            "const tryIt=(f)=>{try{f()}catch(e){}};" +
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
      // Image mode remains inert and must issue no request either.
      await fs.writeFile(path.join(root, 'image.html'),
        `<img src="http://127.0.0.1:${port}/image"><script>fetch('http://127.0.0.1:${port}/fetch')</script>`,
        'utf8');
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

  it('loads scripts from a CDN and a public non-CDN host', async (ctx) => {
    if (!(await cdnReachable())) {
      ctx.skip('cdn.jsdelivr.net is not reachable from this host (offline?)');
      return;
    }
    let nonCdnAddress: string;
    try {
      nonCdnAddress = (await dnsLookup('example.com')).address;
    } catch {
      ctx.skip('public DNS is not reachable from this host (offline?)');
      return;
    }
    if (nonCdnAddress.startsWith('127.') || nonCdnAddress.startsWith('10.')) {
      ctx.skip('example.com does not resolve to a public address on this host');
      return;
    }
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<html><body><script src="https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.min.js"></script>' +
          '<script src="https://example.com/" onload="console.log(\'non-cdn-loaded\')"></script>' +
          '<script>console.log("cdn="+typeof THREE)</script>' +
          '</body></html>',
        { wait_ms: 2_000, width: 400, height: 300 },
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(String(result)).toContain('non-cdn-loaded');
    expect(String(result)).toContain('cdn=object');
  }, 90_000);

  it('refuses a public hostname that resolves to loopback', async (ctx) => {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await dnsLookup('localtest.me', { all: true });
    } catch {
      ctx.skip('localtest.me DNS is not reachable; DNS pinning is covered with an injected resolver in unit tests');
      return;
    }
    if (!addresses.some((item) => item.address === '127.0.0.1' || item.address === '::1')) {
      ctx.skip('localtest.me did not resolve to loopback here; DNS pinning is covered with an injected resolver in unit tests');
      return;
    }
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<script>fetch("http://localtest.me:8799/").catch(()=>console.log("refused"))</script>',
        { wait_ms: 500, width: 300, height: 200 },
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(String(result)).toContain('refused');
    expect(String(result)).toContain('localtest.me');
  }, 90_000);

  it('reads nothing from the local disk', async (ctx) => {
    const secret = path.join(root, 'secret.txt');
    await fs.writeFile(secret, 'TOP-SECRET-CONTENT', 'utf8');
    const url = `file:///${secret.replace(/\\/g, '/')}`;
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<html><body><script>' +
          `fetch(${JSON.stringify(url)}).then((r)=>r.text())` +
          ".then((t)=>console.error('LEAKED '+t),()=>console.error('file fetch refused'));" +
          `const x=new XMLHttpRequest();try{x.open('GET',${JSON.stringify(url)},false);x.send();` +
          "console.error('LEAKED '+x.responseText)}catch(e){console.error('file xhr refused')}" +
          '</script></body></html>',
        { wait_ms: 1_000, width: 300, height: 200 },
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(String(result)).toContain('file fetch refused');
    expect(String(result)).not.toContain('TOP-SECRET-CONTENT');
    expect(String(result)).not.toContain('LEAKED');
  }, 90_000);

  it('returns the error a page throws at boot', async (ctx) => {
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<html><body><script>throw new Error("boot failed: scene missing")</script></body></html>',
        { wait_ms: 0, width: 300, height: 200 },
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(String(result)).toContain('Page errors (1):');
    expect(String(result)).toContain('boot failed: scene missing');
    expect(String(result)).toContain('the active model has no vision input');
  }, 90_000);

  it('draws a three.js WebGL scene loaded from cdn.jsdelivr.net', async (ctx) => {
    if (!(await cdnReachable())) {
      ctx.skip('cdn.jsdelivr.net is not reachable from this host (offline?)');
      return;
    }
    // The page reports its own centre pixel through console.error, which the
    // preview returns verbatim: a red cube on a blue clear colour reads red at
    // the centre only if WebGL really drew the scene.
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<html><body style="margin:0"><script type="module">' +
          "import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js';" +
          'const r=new THREE.WebGLRenderer({preserveDrawingBuffer:true});' +
          'r.setSize(320,240);r.setClearColor(0x0000ff);document.body.appendChild(r.domElement);' +
          'const s=new THREE.Scene();const c=new THREE.PerspectiveCamera(50,320/240,0.1,10);c.position.z=3;' +
          's.add(new THREE.Mesh(new THREE.BoxGeometry(1.5,1.5,1.5),new THREE.MeshBasicMaterial({color:0xff0000})));' +
          'r.render(s,c);const g=r.getContext();const p=new Uint8Array(4);' +
          'g.readPixels(160,120,1,1,g.RGBA,g.UNSIGNED_BYTE,p);' +
          "console.error('centre='+p[0]+','+p[1]+','+p[2]);" +
          '</script></body></html>',
        { wait_ms: 2_000, width: 320, height: 240 },
        true,
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    const multimodal = result as MultimodalToolResult;
    expect(multimodal.text).toContain('centre=255,0,0');
    expect(multimodal.text).not.toContain('Blocked requests');
    expect(multimodal.content.filter((part) => part.type === 'image_url')).toHaveLength(1);
    expect(deliveries).toBe(0);
    expect(await fs.readdir(root)).toEqual(['page.html']);
  }, 90_000);
});
