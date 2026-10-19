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
      // Image mode remains inert and must issue no request either.
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

  it('runs a shader check behind the socket walls without making local TCP or UDP connections', async (ctx) => {
    let tcp = 0;
    let udp = 0;
    const server = net.createServer((socket) => {
      tcp += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const udpSocket = dgram.createSocket('udp4');
    udpSocket.on('message', () => {
      udp += 1;
    });
    await new Promise<void>((resolve) => udpSocket.bind(0, '127.0.0.1', resolve));
    try {
      await fs.writeFile(
        path.join(root, 'shader.wgsl'),
        '@compute @workgroup_size(1) fn main() {}',
        'utf8',
      );
      let result: string;
      try {
        result = String(
          await tool.handler(
            { mode: 'shader_check', path: 'shader.wgsl' },
            { beforeMutate: () => undefined },
          ),
        );
      } catch (err) {
        return skipIfNoBrowser(ctx, err);
      }
      expect(result).toContain('shader 1: 0 compiler message(s)');
      expect(tcp).toBe(0);
      expect(udp).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      udpSocket.close();
    }
  }, 90_000);

  it('maps WGSL and GLSL compiler errors back to workspace source lines', async (ctx) => {
    await fs.writeFile(
      path.join(root, 'embedded.js'),
      'const shader = `\n@vertex fn main() -> @builtin(position) vec4f {\n  let ref = vec4f(0.0);\n  return ref;\n}`;\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(root, 'broken.frag'),
      '#version 300 es\nprecision highp float;\nout vec4 color;\nvoid main() {\n  color = vec4(1.0)\n  }\n',
      'utf8',
    );
    try {
      const wgsl = String(
        await tool.handler(
          { mode: 'shader_check', path: 'embedded.js' },
          { beforeMutate: () => undefined },
        ),
      );
      const glsl = String(
        await tool.handler(
          { mode: 'shader_check', path: 'broken.frag' },
          { beforeMutate: () => undefined },
        ),
      );
      expect(wgsl).toMatch(/embedded\.js:3:\d+:.*'ref'.*reserved keyword/i);
      expect(glsl).toContain('broken.frag:6:3:');
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
  }, 90_000);

  it('previews on the secure synthetic origin with WebGPU and refuses a relative asset', async (ctx) => {
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<img src="./texture.png" onerror="console.log(\'relative-refused\')">' +
          '<script>console.log("secure="+isSecureContext);' +
          'console.log("gpu="+typeof navigator.gpu);' +
          'navigator.gpu.requestAdapter().then(adapter => console.log("adapter="+Boolean(adapter)))' +
          '.catch(() => console.log("adapter=false"));</script>',
        { wait_ms: 3_000, width: 300, height: 200 },
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(String(result)).toContain('gpu=object');
    expect(String(result)).toContain('secure=true');
    expect(String(result)).toMatch(/adapter=(true|false)/);
    expect(String(result)).toContain('relative-refused');
    expect(String(result)).toContain('refused: preview serves only the page itself');
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
      ctx.skip(
        'localtest.me DNS is not reachable; DNS pinning is covered with an injected resolver in unit tests',
      );
      return;
    }
    if (!addresses.some((item) => item.address === '127.0.0.1' || item.address === '::1')) {
      ctx.skip(
        'localtest.me did not resolve to loopback here; DNS pinning is covered with an injected resolver in unit tests',
      );
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

  it('reports WGSL compilation errors raised by a page', async (ctx) => {
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<script>(async()=>{const a=await navigator.gpu.requestAdapter();' +
          'if(!a){console.log("no-adapter");return}const d=await a.requestDevice();' +
          'd.createShaderModule({code:"@compute @workgroup_size(1)\\nfn main() {\\n let x: f32 = \\\"bad\\\";\\n}"});' +
          '})();</script>',
        { wait_ms: 1_000, width: 300, height: 200 },
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    // A GPU-less runner (GitHub's ubuntu) gives the page no adapter at all.
    if (String(result).includes('log: no-adapter')) return ctx.skip('no WebGPU adapter');
    expect(String(result)).toMatch(/Page errors \(\d+\):[\s\S]*webgpu: \d+:\d+:/i);
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
    expect(multimodal.text).not.toContain('Requests that did not load');
    expect(multimodal.content.filter((part) => part.type === 'image_url')).toHaveLength(1);
    expect(deliveries).toBe(0);
    expect(await fs.readdir(root)).toEqual(['page.html']);
  }, 90_000);
  it('follows a public redirect: unpkg sends a version range to the exact version', async (ctx) => {
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<html><body><script src="https://unpkg.com/three@0.160/build/three.min.js"></script>' +
          '<script>console.log("three="+typeof THREE)</script></body></html>',
        { wait_ms: 1_000, width: 300, height: 200 },
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    if (String(result).includes('unpkg.com (fetch failed')) {
      ctx.skip('unpkg.com is not reachable from this host (offline?)');
      return;
    }
    expect(String(result)).toContain('three=object');
  }, 90_000);

  it('refuses a public redirect that points at loopback, before any connection', async (ctx) => {
    let tcp = 0;
    const server = net.createServer((socket) => {
      tcp += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const target = encodeURIComponent(`http://127.0.0.1:${port}/steal.js`);
    try {
      let result: string | MultimodalToolResult;
      try {
        result = await preview(
          `<script src="https://httpbin.org/redirect-to?url=${target}" ` +
            'onerror="console.log(\'redirect-refused\')" onload="console.log(\'redirect-loaded\')"></script>',
          { wait_ms: 1_000, width: 300, height: 200 },
        );
      } catch (err) {
        return skipIfNoBrowser(ctx, err);
      }
      if (/httpbin\.org \((?!redirect to)/.test(String(result))) {
        ctx.skip('httpbin.org is not reachable from this host (offline?)');
        return;
      }
      expect(String(result)).toContain('redirect-refused');
      expect(String(result)).not.toContain('redirect-loaded');
      expect(String(result)).toContain(`redirect to http://127.0.0.1:${port}/steal.js refused`);
      expect(tcp).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);

  // A game that steers while a key is held: window listeners, per-frame state.
  const GAME =
    '<canvas id="c" width="300" height="100"></canvas><script>' +
    'let x=10,right=false;const g=document.getElementById("c").getContext("2d");' +
    'LISTEN.addEventListener("keydown",e=>{if(e.key==="ArrowRight"){right=true;console.log("down")}});' +
    'LISTEN.addEventListener("keyup",e=>{if(e.key==="ArrowRight"){right=false;console.log("up x="+Math.round(x))}});' +
    '(function f(){if(right)x+=2;g.fillStyle="#fff";g.fillRect(0,0,300,100);' +
    'g.fillStyle="#f00";g.fillRect(x,40,20,20);requestAnimationFrame(f)})();' +
    '</script>';

  it('a held key reaches a game listening on window', async (ctx) => {
    let result: string | MultimodalToolResult;
    try {
      result = await preview(GAME.replace(/LISTEN/g, 'window'), {
        keys: [{ key: 'ArrowRight', hold_ms: 1_000 }],
        frames: [0],
        width: 300,
        height: 100,
      });
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(String(result)).toContain('log: down');
    const moved = Number(/up x=(\d+)/.exec(String(result))?.[1]);
    // x starts at 10 and moves 2 px a frame while the key is down. Three frames
    // prove it was held across frames; a loaded macOS runner drew only 8 in 1 s.
    expect(moved).toBeGreaterThan(14);
  }, 90_000);

  it('a held key reaches a game listening on its canvas', async (ctx) => {
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        GAME.replace('<canvas id="c"', '<canvas id="c" tabindex="0"').replace(
          /LISTEN/g,
          'document.getElementById("c")',
        ),
        { keys: [{ key: 'ArrowRight', hold_ms: 500 }], frames: [0], width: 300, height: 100 },
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    expect(String(result)).toContain('log: down');
  }, 90_000);

  it('frames capture an animation at different moments', async (ctx) => {
    let result: string | MultimodalToolResult;
    try {
      result = await preview(
        '<canvas id="c" width="300" height="100"></canvas><script>' +
          'const g=document.getElementById("c").getContext("2d");const t0=performance.now();' +
          '(function f(){const x=((performance.now()-t0)/5)%280;g.fillStyle="#fff";' +
          'g.fillRect(0,0,300,100);g.fillStyle="#f00";g.fillRect(x,40,20,20);requestAnimationFrame(f)})();' +
          '</script>',
        { frames: [100, 600, 1100], width: 300, height: 100 },
        true,
      );
    } catch (err) {
      return skipIfNoBrowser(ctx, err);
    }
    const multimodal = result as MultimodalToolResult;
    const images = multimodal.content.flatMap((part) =>
      part.type === 'image_url' ? [part.image_url.url] : [],
    );
    expect(images).toHaveLength(3);
    expect(new Set(images).size).toBe(3);
    expect(multimodal.text).toMatch(/- 100 ms\n- 600 ms\n- 1100 ms/);
  }, 90_000);
});
