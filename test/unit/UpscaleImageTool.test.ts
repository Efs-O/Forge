import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

import type { ForgeConfig } from '../../src/config/types';
import { CLAIM_SUFFIX } from '../../src/tools/renderHtmlToImageTool';
import type { GpuInfo } from '../../src/system/systemProbes';
import type { FfmpegTools } from '../../src/tools/ffmpegLocate';
import {
  makeUpscaleImageTool,
  upscaleOutputName,
} from '../../src/tools/imageGeneration/upscaleImageTool';
import type {
  UpscaleRun,
  UpscaleRunResult,
  UpscaleSpawnSpec,
} from '../../src/tools/imageGeneration/upscaleRunner';
import type { RunFfmpeg } from '../../src/tools/imageGeneration/sdcppReferenceInput';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';

/**
 * `upscale_image` — plan §4c. The four behaviours the plan names as acceptance
 * criteria are each tested here: an oversized input refused with its size, an
 * aborted upscale leaving no `_x4.png`, an existing `_x4.png` never overwritten,
 * and the tool being absent without the config block (that one lives in
 * RegisterAllTools.test.ts). Nothing here needs a GPU: the spawn and both probes
 * are injected.
 */

const TOOLS: FfmpegTools = { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' };

let root: string;
let snapshots: string[][];

function setWorkspace(folder: string): void {
  (
    vscode.workspace as unknown as {
      workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
    }
  ).workspaceFolders = [{ uri: { fsPath: folder } }];
}

function pngFile(name: string, width: number, height: number, bytes = 64): string {
  const filePath = path.join(root, name);
  const header = Buffer.alloc(24);
  // PNG signature, then IHDR at offset 12 with the size at 16/20 — exactly what
  // `pngDimensions` reads.
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  // Real enough for the header reader; the pixels are irrelevant to this tool.
  fsSync.writeFileSync(filePath, Buffer.concat([header, Buffer.alloc(bytes)]));
  return filePath;
}

function context(conversationId = 'conv-1'): ToolHandlerContext {
  return {
    beforeMutate: (paths: string[]) => snapshots.push(paths),
    conversationId,
  };
}

function gpu(freeMb: number): GpuInfo[] {
  return [
    {
      index: 0,
      name: 'NVIDIA GeForce RTX 3060',
      memoryUsedMb: 12_288 - freeMb,
      memoryTotalMb: 12_288,
      utilizationPercent: null,
      temperatureC: null,
    },
  ];
}

interface ToolOptions {
  upscale?: Record<string, unknown> | null;
  run?: UpscaleRun;
  freeVramMb?: number;
  probeFails?: boolean;
  deliverFile?: (event: { imagePath: string }) => Promise<unknown>;
  ffprobe?: RunFfmpeg;
}

function configWith(upscale: Record<string, unknown> | undefined): ForgeConfig {
  return {
    active_model: 'primary',
    llama_server: {},
    models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
    ...(upscale
      ? {
          image_generation: {
            backends: [{ name: 'grok', provider: 'xai' as const, model: 'img', confirm_each: true }],
            output_dir: 'generated-images',
            upscale,
          } as unknown as ForgeConfig['image_generation'],
        }
      : {}),
  } as ForgeConfig;
}

const DEFAULT_UPSCALE = {
  binary: '/models/sd-cli.exe',
  model: '/models/ESRGAN/4x_foolhardy_Remacri.pth',
  cuda_device: 0,
  timeout_ms: 300_000,
  min_free_vram_mb: 1_500,
  max_input_edge_px: 2_048,
};

function build(options: ToolOptions = {}) {
  const upscale =
    options.upscale === null ? undefined : { ...DEFAULT_UPSCALE, ...(options.upscale ?? {}) };
  const deliverFile =
    options.deliverFile ??
    (vi.fn(async () => ({ kind: 'queued' as const, chats: 1 })) as unknown as (
      event: { imagePath: string },
    ) => Promise<unknown>);
  const run: UpscaleRun =
    options.run ??
    (vi.fn(async () => okRun()) as unknown as UpscaleRun);
  const tool = makeUpscaleImageTool({
    getConfig: () => configWith(upscale),
    notifications: { deliverFile } as never,
    run,
    probe: async () => {
      if (options.probeFails) throw new Error('nvidia-smi not found');
      return gpu(options.freeVramMb ?? 8_000);
    },
    probeImage:
      options.ffprobe ??
      (vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify({ streams: [{ width: 900, height: 1_600 }] }),
        stderr: '',
      })) as unknown as RunFfmpeg),
    ffmpegTools: TOOLS,
    workspaceRoot: root,
  });
  return { tool, deliverFile, run };
}

function okRun(output = ''): UpscaleRunResult {
  return { ok: true, exitCode: 0, stderr: output, processGone: true, pid: 4242 };
}

beforeEach(async () => {
  // realpath so the workspace root the test builds and the real path the tool
  // resolves are the same string — on Windows, temp dirs come back as an 8.3
  // short name whose realpath differs.
  const made = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-upscale-'));
  root = await fs.realpath(made);
  setWorkspace(root);
  snapshots = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  setWorkspace('');
});

/** A run that writes a partial file, then obeys the abort it was handed. */
function abortingRun(writesPartial: boolean): { run: UpscaleRun; specs: UpscaleSpawnSpec[] } {
  const specs: UpscaleSpawnSpec[] = [];
  const run: UpscaleRun = (spec) =>
    new Promise<UpscaleRunResult>((resolve) => {
      specs.push(spec);
      const output = spec.args[spec.args.length - 1]!;
      spec.signal?.addEventListener('abort', () => {
        void (async () => {
          if (writesPartial) await fs.writeFile(output, 'half');
          resolve({
            ok: false,
            kind: 'cancelled',
            exitCode: null,
            stderr: '',
            pid: 4242,
            processGone: true,
          });
        })();
      });
    });
  return { run, specs };
}

/** A fake child that produces a PNG-shaped 4x output, standing in for sd-cli. */
function writingRun(result: () => UpscaleRunResult): UpscaleRun {
  return async (spawn) => {
    await fs.writeFile(spawn.args[spawn.args.length - 1]!, pngBytes(3_200, 2_400));
    return result();
  };
}

/** A PNG header with the given IHDR size — what a real sd-cli output starts with. */
function pngBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe('upscale_image', () => {
  it('refuses an input whose long edge is over the cap, naming its size', async () => {
    const input = pngFile('big.png', 2_400, 1_500);
    const spawn = vi.fn(async () => okRun());
    const { tool } = build({ run: spawn as unknown as UpscaleRun });
    await expect(tool.handler({ path: 'big.png' }, context())).rejects.toThrow(
      /2400x1500 — long edge 2[,.]400 px.*max_input_edge_px of 2[,.]048 px/s,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('measures a non-PNG input with ffprobe and refuses on that size too', async () => {
    const jpeg = path.join(root, 'photo.jpg');
    await fs.writeFile(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const ffprobe = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({ streams: [{ width: 3_024, height: 4_032 }] }),
      stderr: '',
    }));
    const spawn = vi.fn(async () => okRun());
    const { tool } = build({
      run: spawn as unknown as UpscaleRun,
      ffprobe: ffprobe as unknown as RunFfmpeg,
    });
    await expect(tool.handler({ path: 'photo.jpg' }, context())).rejects.toThrow(
      /3024x4032 — long edge 4[,.]032 px.*ffprobe/,
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(ffprobe).toHaveBeenCalled();
  });

  it('refuses when the card cannot give the configured free VRAM, and spawns nothing', async () => {
    const input = pngFile('ok.png', 800, 600);
    const spawn = vi.fn(async () => okRun());
    const { tool } = build({ run: spawn as unknown as UpscaleRun, freeVramMb: 900 });
    await expect(tool.handler({ path: 'ok.png' }, context())).rejects.toThrow(
      /upscale_image: only 900 MB free on GPU 0.*1[,.]500 MB is required to load "4x_foolhardy_Remacri\.pth"/s,
    );
    expect(spawn).not.toHaveBeenCalled();
    // The refused name is released, so the next call gets the base name back.
    expect(await fs.readdir(root)).toEqual(['ok.png']);
  });

  it('refuses when the VRAM probe itself fails — the gate is fail-closed', async () => {
    pngFile('ok.png', 800, 600);
    const spawn = vi.fn(async () => okRun());
    const { tool } = build({ run: spawn as unknown as UpscaleRun, probeFails: true });
    await expect(tool.handler({ path: 'ok.png' }, context())).rejects.toThrow(
      /could not check free VRAM on CUDA device 0.*no image was upscaled/s,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('deletes the partial output and reports the kill when the turn aborts', async () => {
    pngFile('ok.png', 800, 600);
    const abort = new AbortController();
    const { run, specs } = abortingRun(true);
    const { tool } = build({ run });
    const ctx: ToolHandlerContext = { ...context(), abortSignal: abort.signal };
    const call = tool.handler({ path: 'ok.png' }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    await expect(call).rejects.toThrow(/cancelled and the sd-cli process Forge started was killed/s);
    expect(specs[0]?.signal).toBe(abort.signal);
    expect(await fs.readdir(root)).toEqual(['ok.png']);
  });

  it('kills on the timeout path too, leaving no partial file and no claim sidecar', async () => {
    pngFile('ok.png', 800, 600);
    // The injected seam reports the kind the real upscaleRunner produces when
    // its own timeout_ms fires: kill, then exit with what the child said.
    const hanging: UpscaleRun = (spec) =>
      new Promise<UpscaleRunResult>((resolve) => {
        const output = spec.args[spec.args.length - 1]!;
        setTimeout(() => {
          void fs.writeFile(output, 'half').then(() =>
            resolve({
              ok: false,
              kind: 'timeout',
              exitCode: null,
              stderr: 'still on tile 3',
              pid: 99,
              processGone: true,
            }),
          );
        }, spec.timeoutMs);
      });
    const { tool } = build({ run: hanging, upscale: { timeout_ms: 200 } });
    await expect(tool.handler({ path: 'ok.png' }, context())).rejects.toThrow(
      /did not finish within image_generation\.upscale\.timeout_ms of 200 ms.*still on tile 3.*No upscaled file was left/s,
    );
    expect(await fs.readdir(root)).toEqual(['ok.png']);
  });

  it('never overwrites an existing _x4.png — the next call takes -2', async () => {
    pngFile('shot.png', 800, 600);
    const first = path.join(root, 'shot_x4.png');
    await fs.writeFile(first, 'already here');
    const specs: UpscaleSpawnSpec[] = [];
    const { tool } = build({
      run: async (spec) => {
        specs.push(spec);
        await fs.writeFile(spec.args[spec.args.length - 1]!, 'new');
        return okRun();
      },
    });
    const result = await tool.handler({ path: 'shot.png' }, context());
    expect(String(result)).toContain('shot_x4-2.png');
    expect(specs[0]?.args).toContain(path.join(root, 'shot_x4-2.png'));
    expect(await fs.readFile(first, 'utf8')).toBe('already here');
  });

  it('surfaces the child’s stderr tail on a failure exit, with no file left', async () => {
    pngFile('ok.png', 800, 600);
    const { tool } = build({
      run: async (spec) => {
        await fs.writeFile(spec.args[spec.args.length - 1]!, 'half');
        return {
          ok: false,
          kind: 'exit',
          exitCode: 1,
          stderr: 'ERROR: could not open model file',
          pid: 7,
          processGone: true,
        };
      },
    });
    await expect(tool.handler({ path: 'ok.png' }, context())).rejects.toThrow(
      /sd-cli exited with code 1.*could not open model file.*No upscaled file was left/s,
    );
    expect(await fs.readdir(root)).toEqual(['ok.png']);
  });

  it('passes the plan’s exact argv, pinned to the configured CUDA device, once', async () => {
    pngFile('ok.png', 800, 600);
    const specs: UpscaleSpawnSpec[] = [];
    const { tool } = build({
      run: async (spec) => {
        specs.push(spec);
        await fs.writeFile(spec.args[spec.args.length - 1]!, 'x');
        return okRun();
      },
    });
    await tool.handler({ path: 'ok.png' }, context());
    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.binary).toBe('/models/sd-cli.exe');
    expect(spec.args).toEqual([
      '-M',
      'upscale',
      '--upscale-model',
      '/models/ESRGAN/4x_foolhardy_Remacri.pth',
      '-i',
      path.join(root, 'ok.png'),
      '-o',
      path.join(root, 'ok_x4.png'),
    ]);
    expect(spec.cudaDevice).toBe(0);
    expect(spec.timeoutMs).toBe(300_000);
  });

  it('snapshots the output before writing and delivers it like generate_image', async () => {
    pngFile('ok.png', 800, 600);
    const deliverFile = vi.fn(async () => ({ kind: 'queued', chats: 2 }));
    const { tool } = build({
      deliverFile,
      run: writingRun(() => okRun()),
    });
    const result = String(await tool.handler({ path: 'ok.png' }, context('chat-9')));
    expect(snapshots).toEqual([[path.join(root, 'ok_x4.png')]]);
    expect(result).toContain('Generated image saved to ok_x4.png');
    expect(result).toContain('3200x2400, from 800x600');
    expect(result).toContain('Queued for 2 remote chat(s)');
    expect(deliverFile).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'chat-9' }),
    );
    expect(await fs.readdir(root)).toEqual(['ok.png', 'ok_x4.png']);
  });

  it('refuses a path outside the workspace and says how to proceed', async () => {
    const outside = path.join(os.tmpdir(), 'forge-upscale-outside.png');
    await fs.writeFile(outside, 'x');
    const spawn = vi.fn(async () => okRun());
    const { tool } = build({ run: spawn as unknown as UpscaleRun });
    await expect(tool.handler({ path: outside }, context())).rejects.toThrow(
      /is not a file inside the workspace.*Copy the picture into the workspace/s,
    );
    expect(spawn).not.toHaveBeenCalled();
    await fs.rm(outside, { force: true });
  });

  it('refuses outright when the config block is gone, even if it was registered', async () => {
    pngFile('ok.png', 800, 600);
    const { tool } = build({ upscale: null });
    await expect(tool.handler({ path: 'ok.png' }, context())).rejects.toThrow(
      /no image_generation\.upscale block in config\.yaml/,
    );
    expect(tool.advertise?.()).toBe(false);
  });

  it('saves but does not send an output over the 50 MB ceiling', async () => {
    pngFile('ok.png', 800, 600);
    const deliverFile = vi.fn(async () => ({ kind: 'queued', chats: 1 }));
    const { tool } = build({
      deliverFile,
      run: async (spec) => {
        await fs.writeFile(spec.args[spec.args.length - 1]!, Buffer.alloc(51 * 1024 * 1024));
        return okRun();
      },
    });
    const result = String(await tool.handler({ path: 'ok.png' }, context()));
    expect(result).toContain('Saved but NOT sent');
    expect(deliverFile).not.toHaveBeenCalled();
  });

  it('reports an exit-0 run that wrote nothing, and sends nothing', async () => {
    pngFile('ok.png', 800, 600);
    const deliverFile = vi.fn(async () => ({ kind: 'queued', chats: 1 }));
    const { tool } = build({ deliverFile, run: async () => okRun() });
    await expect(tool.handler({ path: 'ok.png' }, context())).rejects.toThrow(
      /sd-cli exited 0 but left no file at "ok_x4\.png"/s,
    );
    expect(deliverFile).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual(['ok.png']);
  });

  it('reports the output size the file really has, not 4x the input', async () => {
    // The ×4 model is what is configured today; the result must still state the
    // truth if a different-scale model is ever pointed at the same block.
    pngFile('ok.png', 800, 600);
    const { tool } = build({
      run: async (spawn) => {
        await fs.writeFile(spawn.args[spawn.args.length - 1]!, pngBytes(1_600, 1_200));
        return okRun();
      },
    });
    const result = String(await tool.handler({ path: 'ok.png' }, context()));
    expect(result).toContain('1600x1200, from 800x600');
    expect(result).not.toContain('3200x2400');
  });

  it('refuses a directory rather than failing on the header read', async () => {
    await fs.mkdir(path.join(root, 'folder.png'));
    const spawn = vi.fn(async () => okRun());
    const { tool } = build({ run: spawn as unknown as UpscaleRun });
    await expect(tool.handler({ path: 'folder.png' }, context())).rejects.toThrow(
      /is a directory, not one picture file/,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('names the real _x4 sibling for a nested input with a dot in the folder', () => {
    expect(upscaleOutputName(path.join('a.b', 'c', 'shot.jpeg'))).toBe(
      path.join('a.b', 'c', 'shot_x4.png'),
    );
    expect(upscaleOutputName('no-extension')).toBe(path.join('', 'no-extension_x4.png'));
  });

  it('leaves no claim sidecar behind after any outcome', async () => {
    pngFile('ok.png', 800, 600);
    const { tool } = build({ run: async () => okRun() });
    await expect(tool.handler({ path: 'ok.png' }, context())).rejects.toThrow(/exited 0/);
    const entries = await fs.readdir(root);
    expect(entries.filter((entry) => entry.endsWith(CLAIM_SUFFIX))).toEqual([]);
  });
});
