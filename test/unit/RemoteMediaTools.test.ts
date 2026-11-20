/**
 * The laptop's desktop-backed image tools (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md
 * phase 2, acceptance criteria 7 and 8).
 *
 * The desktop is faked with a real loopback `http` server, because what has to
 * be proven is the wire and the file: the arguments that cross, the names they
 * cross as, and where the bytes end up on the laptop. `beforeMutate` is asserted
 * from the call, not from the saved file — a render Keep/Undo cannot roll back is
 * the defect the plan's ledger row for "laptop saved files" is about.
 */
import * as fs from 'fs/promises';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_MEDIA_TEXT } from '../../src/media/remoteMediaContract';
import { desktopPathsToNames } from '../../src/media/remoteMediaResultText';
import type { RegisteredTool } from '../../src/tools/ToolRegistry';
import type { ForgeConfig } from '../../src/config/types';
import {
  makeRemoteMediaTools,
  remoteMediaActiveFor,
  remoteMediaOrigin,
} from '../../src/tools/remoteMedia/remoteMediaTools';
import { listenLoopback } from '../support/listenLoopback';

/** The two definitions a desktop hands over, verbatim. */
const GENERATE_DEFINITION = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: 'Generate an image on this desktop.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' }, path: { type: 'string' } },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
};
const UPSCALE_DEFINITION = {
  type: 'function',
  function: {
    name: 'upscale_image',
    description: 'Upscale a picture on this desktop.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

/** What a desktop with media on answers with: the two tool definitions the
 *  laptop must advertise verbatim, the backends with their cost tags, and the
 *  body ceiling the laptop refuses against. */
function capabilities(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tools: [GENERATE_DEFINITION, UPSCALE_DEFINITION],
    image: {
      default: 'qwen-image-turbo',
      backends: [
        {
          name: 'qwen-image-turbo',
          paid: false,
          confirm_each: false,
          cost: 'local · free · sdcpp · qwen-image-turbo',
          reference_images: true,
        },
        {
          name: 'grok-imagine',
          paid: true,
          confirm_each: true,
          cost: 'cloud · billed per image · openai · grok-imagine',
          reference_images: false,
        },
      ],
    },
    upscale: true,
    refused: [],
    max_body_bytes: 32 * 1024 * 1024,
    ...overrides,
  };
}

interface FakeDesktop {
  origin: string;
  /** Every request, as `<method> <path>`, in the order it arrived. */
  requests: string[];
  /** The parsed body of each `POST /v1/media/jobs`. */
  jobs: Array<Record<string, unknown>>;
  cancels: string[];
  close(): Promise<void>;
}

interface DesktopOptions {
  /** The capabilities body; `undefined` answers the 404 an off relay answers. */
  capabilities?: unknown;
  /** The states a job moves through; the last one repeats until polled away. */
  states?: Array<{ state: string; progress?: string; error?: string; result?: string; files?: unknown }>;
  fileBytes?: Uint8Array;
}

async function startFakeDesktop(options: DesktopOptions = {}): Promise<FakeDesktop> {
  const requests: string[] = [];
  const jobs: Array<Record<string, unknown>> = [];
  const cancels: string[] = [];
  const fileBytes = options.fileBytes ?? Buffer.from('png-bytes');
  const states = options.states ?? [{ state: 'running', progress: 'rendering' }, { state: 'done' }];
  let polls = 0;
  const server = http.createServer((req, res) => {
    const route = `${req.method} ${(req.url ?? '/').split('?')[0]}`;
    requests.push(route);
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (route === 'GET /v1/media/capabilities') {
      if (options.capabilities === undefined) return json(404, { error: REMOTE_MEDIA_TEXT.off });
      return json(200, options.capabilities);
    }
    if (route === 'POST /v1/media/jobs') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        jobs.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        polls = 0;
        json(202, { id: 'cafe0001' });
      });
      return;
    }
    if (route === 'GET /v1/media/job') {
      const at = states[Math.min(polls, states.length - 1)]!;
      polls += 1;
      return json(200, { id: 'cafe0001', ...at });
    }
    if (route === 'GET /v1/media/file') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from(fileBytes));
      return;
    }
    if (route === 'POST /v1/media/cancel') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: string };
        if (body.id) cancels.push(body.id);
        json(200, { state: 'failed' });
      });
      return;
    }
    return json(404, { error: `no route for ${route}` });
  });
  const port = await listenLoopback(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    jobs,
    cancels,
    close: () =>
      new Promise<void>((resolve) => {
        // Undici keeps the connection it used alive, and `close()` waits for it:
        // without this the fake desktop's teardown is what a test appears to spend
        // three seconds on.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** A laptop config: the relay group Connect writes, the media switch on, and no
 *  `image_generation` block of its own — the state the remote variants exist in. */
function laptopConfig(origin: string): ForgeConfig {
  return {
    models: [],
    active_model: null,
    llama_server: {},
    groups: { 'desktop-relay': { provider: 'openai-compatible', endpoint: `${origin}/v1` } },
    remote_media: { enabled: true },
  } as unknown as ForgeConfig;
}

const EMPTY_CONTEXT = { beforeMutate: () => {} };

describe('the desktop media tools', () => {
  let desktop: FakeDesktop | undefined;

  afterEach(async () => {
    await desktop?.close();
    desktop = undefined;
  });

  /** A workspace folder of this test's own, with the files a model would name. */
  async function workspace(files: Record<string, string | Uint8Array>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-remote-media-'));
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
    }
    return root;
  }

  function toolsFor(origin: string, root: string) {
    const config = laptopConfig(origin);
    const bundle = makeRemoteMediaTools({
      getConfig: () => config,
      workspaceRoot: () => root,
      // The real cadence is 2 s; a test watches a job move through states without
      // paying it. The clock seam is the same one the cadence reads.
      poll: { fastMs: 1, slowMs: 1, windowMs: 0 },
    });
    return { bundle, tools: bundle.tools, config };
  }

  const toolNamed = (tools: RegisteredTool[], name: string): RegisteredTool =>
    tools.find((tool) => tool.definition.function.name === name)!;

  it('advertises nothing until the desktop answers, and both tools after', async () => {
    desktop = await startFakeDesktop({ capabilities: capabilities() });
    const root = await workspace({});
    const { bundle, tools } = toolsFor(desktop.origin, root);
    expect(tools.map((tool) => tool.advertise?.())).toEqual([false, false]);
    await bundle.refresh();
    expect(tools.map((tool) => tool.advertise?.())).toEqual([true, true]);
    // The definition the model is shown is the desktop's own, not a laptop copy.
    const generate = toolNamed(tools, 'generate_image');
    expect(generate.describe?.().function.description).toBe('Generate an image on this desktop.');
    expect(generate.describe?.().function.parameters).toEqual(
      GENERATE_DEFINITION.function.parameters,
    );
    await fs.rm(root, { recursive: true, force: true });
  });

  it('saves a generated image under generated-images/ through beforeMutate', async () => {
    desktop = await startFakeDesktop({
      capabilities: capabilities(),
      states: [{ state: 'done', result: 'Generated image saved to generated-images/cat.png', files: [{ name: 'cat.png', bytes: 9, kind: 'image' }] }],
    });
    const root = await workspace({});
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    const beforeMutate = vi.fn();
    const text = await toolNamed(tools, 'generate_image').handler(
      { prompt: 'a cat' },
      { ...EMPTY_CONTEXT, beforeMutate },
    );
    const saved = path.join(root, 'generated-images', 'cat.png');
    expect(beforeMutate).toHaveBeenCalledWith([saved]);
    expect(await fs.readFile(saved)).toEqual(Buffer.from('png-bytes'));
    expect(String(text)).toContain('Generated image saved to generated-images/cat.png');
    // Forward slashes: the result text is model-facing prose, and the path in it
    // has to be one this laptop's own tools accept on any operating system.
    expect(String(text)).toContain('Saved on this laptop: generated-images/cat.png');
    // The desktop was asked once for the job, once for its status, once for the file.
    expect(desktop.requests).toEqual([
      'GET /v1/media/capabilities',
      'POST /v1/media/jobs',
      'GET /v1/media/job',
      'GET /v1/media/file',
    ]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps the path the model asked for, and sends no laptop path at all', async () => {
    desktop = await startFakeDesktop({
      capabilities: capabilities(),
      states: [{ state: 'done', files: [{ name: 'cat.png', bytes: 9, kind: 'image' }] }],
    });
    const root = await workspace({});
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    await toolNamed(tools, 'generate_image').handler(
      { prompt: 'a cat', path: 'renders/cat.png' },
      EMPTY_CONTEXT,
    );
    expect(await fs.readFile(path.join(root, 'renders', 'cat.png'))).toBeTruthy();
    const job = desktop.jobs[0]!;
    expect(job.args).toEqual({ prompt: 'a cat', path: 'renders/cat.png' });
    expect(JSON.stringify(job)).not.toContain(root);
    expect(job.client).toBe('forge-laptop');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a desktop path in the result never reaches the model: the whole round trip', async () => {
    // Both halves at once. The desktop rewrites the paths in its own result text
    // to bare names on the way out (`remoteMediaJobs.ts` does this to the real
    // tool's text); the laptop rewrites those names back to its own paths on the
    // way in. The fake desktop answers with what the real one would send, so the
    // string asserted here is the string a laptop model would read.
    const jobDir =
      'C:/Users/desk/AppData/Roaming/Code/User/globalStorage/efsoo.forge-llm/remote-media/cafe0001';
    const desktopText = desktopPathsToNames(
      `Generated image saved to ${jobDir}/out/pics/cat.png (image/png, 9 bytes) ` +
        'with backend qwen-image-turbo. The reference ' +
        `"${jobDir}\\inputs\\fox.png" is the copy this laptop uploaded. ` +
        'To inspect it, call view_image on that path.',
      jobDir,
    );
    desktop = await startFakeDesktop({
      capabilities: capabilities(),
      states: [
        {
          state: 'done',
          result: desktopText,
          files: [{ name: 'cat.png', bytes: 9, kind: 'image' }],
        },
      ],
    });
    const root = await workspace({ 'pics/fox.png': 'the picture' });
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    const text = String(
      await toolNamed(tools, 'generate_image').handler(
        { prompt: 'a cat', path: 'pics/cat.png', reference_paths: ['pics/fox.png'] },
        EMPTY_CONTEXT,
      ),
    );
    expect(text).toBe(
      'Generated image saved to pics/cat.png (image/png, 9 bytes) with backend qwen-image-turbo. ' +
        'The reference "pics/fox.png" is the copy this laptop uploaded. ' +
        'To inspect it, call view_image on that path.\n' +
        'Saved on this laptop: pics/cat.png',
    );
    // Nothing of the desktop's folder survives: not the path, not the user name,
    // not the job id the file is still fetched by.
    expect(text).not.toContain('cafe0001');
    expect(text).not.toContain('AppData');
    expect(text).not.toContain('remote-media');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uploads an upscale input by bare name and saves the result beside it', async () => {
    desktop = await startFakeDesktop({
      capabilities: capabilities(),
      states: [{ state: 'done', files: [{ name: 'cat_x4.png', bytes: 9, kind: 'image' }] }],
    });
    const root = await workspace({ 'photos/cat.png': 'the picture' });
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    await toolNamed(tools, 'upscale_image').handler({ path: 'photos/cat.png' }, EMPTY_CONTEXT);
    const job = desktop.jobs[0]!;
    // The laptop path never crosses: the argument carries the uploaded name.
    expect(job.args).toEqual({ path: 'cat.png' });
    expect(job.inputs).toEqual([
      { arg: 'path', name: 'cat.png', base64: Buffer.from('the picture').toString('base64') },
    ]);
    expect(await fs.readFile(path.join(root, 'photos', 'cat_x4.png'))).toBeTruthy();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('asks the desktop to stop when the caller aborts', async () => {
    desktop = await startFakeDesktop({
      capabilities: capabilities(),
      states: [{ state: 'running', progress: 'rendering' }],
    });
    const root = await workspace({});
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    const controller = new AbortController();
    // The fake never finishes, so the test cancels it: the abort lands during the
    // wait between polls, which is what makes the handler ask for a cancel.
    setTimeout(() => controller.abort(), 20);
    const text = await toolNamed(tools, 'generate_image').handler(
      { prompt: 'a cat' },
      { ...EMPTY_CONTEXT, abortSignal: controller.signal },
    );
    expect(String(text)).toMatch(/cancelled/);
    expect(desktop.cancels).toEqual(['cafe0001']);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a desktop that does not answer says so in the contract text, whole', async () => {
    desktop = await startFakeDesktop({ capabilities: capabilities() });
    const root = await workspace({});
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    const origin = desktop.origin;
    await desktop.close();
    desktop = undefined;
    // The cache is still the one this run filled; the job POST is what fails.
    const text = await toolNamed(tools, 'generate_image').handler({ prompt: 'a cat' }, EMPTY_CONTEXT);
    expect(text).toBe(REMOTE_MEDIA_TEXT.unreachable(origin));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a paid backend is dangerous with the desktop’s cost text; a free one is not', async () => {
    desktop = await startFakeDesktop({ capabilities: capabilities() });
    const root = await workspace({});
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    const generate = toolNamed(tools, 'generate_image');
    // The default backend is the free one: no card of its own.
    expect(generate.approval?.({ prompt: 'a cat' })).toBeUndefined();
    const paid = generate.approval?.({ prompt: 'a cat', backend: 'grok-imagine' });
    expect(paid?.dangerous).toBe(true);
    expect(paid?.detail).toContain('grok-imagine');
    expect(paid?.detail).toContain('cloud · billed per image · openai · grok-imagine');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses an input too big for the desktop’s body limit before asking', async () => {
    desktop = await startFakeDesktop({
      capabilities: capabilities({ max_body_bytes: 1024 * 1024 }),
    });
    const root = await workspace({ 'big.png': 'x'.repeat(2 * 1024 * 1024) });
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    await expect(
      toolNamed(tools, 'upscale_image').handler({ path: 'big.png' }, EMPTY_CONTEXT),
    ).rejects.toThrow(/up to 1\.0 MB/);
    expect(desktop.requests).toEqual(['GET /v1/media/capabilities']);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses an output path that would leave the desktop job folder', async () => {
    desktop = await startFakeDesktop({ capabilities: capabilities() });
    const root = await workspace({});
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    await expect(
      toolNamed(tools, 'generate_image').handler(
        { prompt: 'a cat', path: '../../policy.yaml' },
        EMPTY_CONTEXT,
      ),
    ).rejects.toThrow(REMOTE_MEDIA_TEXT.outputRefused('path'));
    expect(desktop.requests).toEqual(['GET /v1/media/capabilities']);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses an output that would overwrite the reference it reads', async () => {
    desktop = await startFakeDesktop({ capabilities: capabilities() });
    const root = await workspace({ 'cat.png': 'the picture' });
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    // The desktop cannot see this collision: over the wire the reference is the
    // bare name `cat.png` in `inputs[]` and the output is a path in the laptop's
    // workspace, so nothing on the desktop knows they are one file. Locally the
    // desktop's own tool refuses it (A22); here the laptop has to.
    await expect(
      toolNamed(tools, 'generate_image').handler(
        { prompt: 'a cat, bigger', path: 'cat.png', reference_paths: ['cat.png'] },
        EMPTY_CONTEXT,
      ),
    ).rejects.toThrow(
      'generate_image: path "cat.png" is one of the reference images; choose another output name.',
    );
    // Nothing was sent: no render was paid for to be thrown away...
    expect(desktop.requests).toEqual(['GET /v1/media/capabilities']);
    // ...and the owner's file is the file they wrote.
    expect(await fs.readFile(path.join(root, 'cat.png'))).toEqual(Buffer.from('the picture'));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('allows the same reference when the output is elsewhere', async () => {
    desktop = await startFakeDesktop({ capabilities: capabilities() });
    const root = await workspace({ 'cat.png': 'the picture' });
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    // The ordinary edit: this must not be refused, or every desktop render from a
    // laptop would need a name the owner has to check against every reference.
    await toolNamed(tools, 'generate_image').handler(
      { prompt: 'a cat, bigger', path: 'out/cat.png', reference_paths: ['cat.png'] },
      EMPTY_CONTEXT,
    );
    expect(desktop.requests).toContain('POST /v1/media/jobs');
    const job = desktop.jobs[0]!;
    expect(job.args).toEqual({
      prompt: 'a cat, bigger',
      path: 'out/cat.png',
      reference_paths: ['cat.png'],
    });
    expect(await fs.readFile(path.join(root, 'cat.png'))).toEqual(Buffer.from('the picture'));
    await fs.rm(root, { recursive: true, force: true });
  });

  it('gives two inputs of the same base name one name each', async () => {
    desktop = await startFakeDesktop({ capabilities: capabilities() });
    const root = await workspace({ 'a/x.png': 'first', 'b/x.png': 'second' });
    const { bundle, tools } = toolsFor(desktop.origin, root);
    await bundle.refresh();
    await toolNamed(tools, 'generate_image').handler(
      { prompt: 'a cat', reference_paths: ['a/x.png', 'b/x.png'] },
      EMPTY_CONTEXT,
    );
    const job = desktop.jobs[0]!;
    // The desktop keys the inputs it receives by name, so two `x.png` would be one
    // file and the model would lose a reference without anyone saying so.
    expect((job.inputs as Array<{ name: string }>).map((input) => input.name)).toEqual([
      'x.png',
      'x-2.png',
    ]);
    // The arguments name the same two files, or the desktop would ask for a name
    // that was never uploaded.
    expect(job.args).toEqual({
      prompt: 'a cat',
      reference_paths: ['x.png', 'x-2.png'],
    });
    // Both files really crossed, not one of them twice.
    expect((job.inputs as Array<{ base64: string }>).map((input) => input.base64)).toEqual([
      Buffer.from('first').toString('base64'),
      Buffer.from('second').toString('base64'),
    ]);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('takes the two tool names only when the laptop renders nothing itself', () => {
    const base = laptopConfig('http://127.0.0.1:1/v1') as Record<string, unknown>;
    expect(remoteMediaActiveFor(base as unknown as ForgeConfig)).toBe(true);
    expect(
      remoteMediaActiveFor({ ...base, image_generation: { backends: [] } } as unknown as ForgeConfig),
    ).toBe(false);
    expect(
      remoteMediaActiveFor({ ...base, remote_media: { enabled: false } } as unknown as ForgeConfig),
    ).toBe(false);
    // The origin is the group's endpoint's origin: the path is not part of it.
    expect(remoteMediaOrigin(base as unknown as ForgeConfig)).toBe('http://127.0.0.1:1');
    expect(remoteMediaOrigin({ ...base, groups: {} } as unknown as ForgeConfig)).toBeUndefined();
  });
});
