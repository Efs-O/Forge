/**
 * Phase 3 acceptance: "`generate_music` routes by `lyrics`: user and agent go
 * to ACE-Step, none goes to Stable Audio 3. `stable_audio` with lyrics is
 * refused and the refusal names the alternative. `lyrics_path` is required for
 * user/agent and refused for none. A unit test covers each row."
 * (docs/plans/MEDIA_SHIPPED_PLAN.md, Acceptance criteria).
 *
 * The engines are configured against real files in a temp folder so the shared
 * `checkMediaSetup` verdict is the real one; only the render process is faked,
 * so nothing here starts ComfyUI, a GPU job or a network call.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined },
  window: {
    createOutputChannel: () => ({
      appendLine: () => {},
      show: () => {},
      dispose: () => {},
    }),
  },
}));

import type { ForgeConfig, MediaConfig } from '../../src/config/types';
import { MediaConfigSchema } from '../../src/config/mediaSchema';
import { makeGenerateMusicTool } from '../../src/tools/media/generateMusicTool';
import type { MediaRenderDeps } from '../../src/tools/media/mediaRenderRunner';
import type { MediaToolDeps } from '../../src/tools/media/mediaToolDeps';
import type { RegisteredTool, ToolHandlerContext } from '../../src/tools/ToolRegistry';

const TOOLS = { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' };

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-music-'));
});
afterEach(async () => {
  // The render chain is detached, so it can still be writing into the run
  // folder as the test ends: retry the removal rather than racing it, which
  // is what the suite's temp-leak guard checks.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await fs.rm(root, { recursive: true, force: true });
});

/** A configured media block whose every required path really exists. */
async function configuredMedia(): Promise<MediaConfig> {
  const comfyRoot = path.join(root, 'comfyui');
  const aceRoot = path.join(root, 'ACE-Step-1.5');
  const acePython = path.join(aceRoot, '.venv', 'Scripts', 'python.exe');
  const analyzerLauncher = path.join(root, 'flamingo', 'Start-DLT.ps1');
  const analyzerPython = path.join(root, 'flamingo', '.venv', 'Scripts', 'python.exe');
  await fs.mkdir(path.join(root, 'ace-checkpoints'), { recursive: true });
  for (const file of [
    path.join(comfyRoot, 'main.py'),
    path.join(comfyRoot, '.venv', 'Scripts', 'python.exe'),
    path.join(comfyRoot, 'models', 'checkpoints', 'stable_audio_3_medium.safetensors'),
    path.join(comfyRoot, 'models', 'text_encoders', 't5gemma.safetensors'),
    acePython,
    analyzerLauncher,
    analyzerPython,
  ]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'fixture', 'utf8');
  }
  return MediaConfigSchema.parse({
    enabled: true,
    output_dir: 'media',
    comfyui: { root: comfyRoot, python: path.join(comfyRoot, '.venv', 'Scripts', 'python.exe') },
    music: {
      analyzer: { kind: 'flamingo_dlt', launcher: analyzerLauncher },
      engines: [
        {
          id: 'ace_step',
          kind: 'ace_standalone',
          root: aceRoot,
          checkpoints: path.join(root, 'ace-checkpoints'),
          cuda_devices: [2],
        },
        {
          id: 'stable_audio',
          kind: 'comfyui_sa3',
          checkpoint: path.join(comfyRoot, 'models', 'checkpoints', 'stable_audio_3_medium.safetensors'),
          text_encoder: path.join(comfyRoot, 'models', 'text_encoders', 't5gemma.safetensors'),
          cuda_devices: [2],
        },
      ],
    },
  });
}

interface Started {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
  notifyConversationId?: string;
}

function toolFor(
  media: MediaConfig,
  workspaceRoot: string,
  starts: Started[],
  onStart?: (id: string) => void,
  gpuProbe?: NonNullable<MediaToolDeps['gpuProbe']>,
): { tool: RegisteredTool; release: () => void } {
  const gates: Array<() => void> = [];
  const background = {
    start: (spec: StartOptions) => {
      starts.push({
        command: spec.command,
        args: spec.args,
        ...(spec.env ? { env: spec.env } : {}),
        ...(spec.notifyConversationId
          ? { notifyConversationId: spec.notifyConversationId }
          : {}),
      });
      gates.push(() => undefined);
      return {
        id: `exec-${starts.length}`,
        status: 'running',
        pid: 900 + starts.length,
        startedAt: Date.now(),
      };
    },
    waitFinished: (id: string) =>
      new Promise((resolve) => {
        gates[gates.length - 1] = () => resolve(undefined);
      }),
  };
  void onStart;
  const deps: MediaToolDeps = {
    getConfig: () => ({
      active_model: 'primary',
      llama_server: { binary: 'llama-server' },
      models: [{ name: 'primary', gguf_path: '/p.gguf' }],
      media,
    }) as ForgeConfig,
    adaptersDir: path.join(root, 'resources', 'media'),
    workspaceRoot,
    lifecycle: {
      loadedModels: () => [{ name: 'strata', gpus: [0, 1] }],
      isBusy: () => false,
      unloadModel: async () => ({ unloaded: true }),
    },
    leasePath: path.join(root, 'lease.json'),
    leasePid: 10,
    leaseProcessStartTime: 1000,
    lookupProcessStartTime: async () => 1000,
    background,
    gpuProbe:
      gpuProbe ??
      (async () =>
        [0, 1, 2].map((index) => ({
          index,
          name: `test-gpu-${index}`,
          memoryUsedMb: 0,
          memoryTotalMb: 16_000,
          utilizationPercent: 0,
          temperatureC: 30,
        }))),
    ffmpegTools: TOOLS,
    log: () => {},
  };
  void (null as unknown as MediaRenderDeps);
  return {
    tool: makeGenerateMusicTool(deps),
    release: () => {
      gates.shift()?.();
    },
  };
}

type StartOptions = Parameters<BackgroundExecutionStartLike['start']>[0];

interface BackgroundExecutionStartLike {
  start: (spec: {
    command: string;
    args: readonly string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    notifyConversationId?: string;
    exitSummary?: () => Promise<string>;
    timeoutMs?: number;
  }) => { id: string; status: string; pid: number | undefined; startedAt: number };
  waitFinished: (id: string, signal?: AbortSignal) => Promise<unknown>;
}

const CONTEXT: ToolHandlerContext = { conversationId: 'conversation-1' };

async function jobOf(starts: Started[], index: number): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(starts[index].args[1], 'utf8')) as Record<string, unknown>;
}

describe('generate_music: the lyrics choice routes the engine', () => {
  it('sends user lyrics to ACE-Step with the file it names', async () => {
    const media = await configuredMedia();
    const lyricsPath = path.join(root, 'lyrics.txt');
    await fs.writeFile(lyricsPath, 'One two three, four five six.', 'utf8');
    const starts: Started[] = [];
    const { tool } = toolFor(media, root, starts);
    const text = (await tool.handler(
      { lyrics: 'user', lyrics_path: lyricsPath, style: 'Indie folk with piano.' },
      CONTEXT,
    )) as string;
    expect(text).toContain('render started');
    const job = await jobOf(starts, 0);
    expect(job.engine).toBe('ace_step');
    expect(job.prompt).toBe('Indie folk with piano.');
    const sung = (job.inputs as Record<string, string>).lyrics_path;
    expect(sung).toContain('lyrics.txt');
    expect(await fs.readFile(sung, 'utf8')).toContain('One two three, four five six.');
  });

  it('sends agent lyrics to ACE-Step too, reading the approved file unchanged', async () => {
    const media = await configuredMedia();
    const lyricsPath = path.join(root, 'agent-lyrics.txt');
    await fs.writeFile(lyricsPath, 'Written by the agent, approved by the user.', 'utf8');
    const starts: Started[] = [];
    const { tool } = toolFor(media, root, starts);
    await tool.handler(
      { lyrics: 'agent', lyrics_path: lyricsPath, style: 'Synth pop, midtempo.' },
      CONTEXT,
    );
    const job = await jobOf(starts, 0);
    expect(job.engine).toBe('ace_step');
    const sung = (job.inputs as Record<string, string>).lyrics_path;
    expect(await fs.readFile(sung, 'utf8')).toContain('Written by the agent');
  });

  it('routes an instrumental to Stable Audio 3 post-trained, with no lyrics file', async () => {
    const media = await configuredMedia();
    const starts: Started[] = [];
    const { tool } = toolFor(media, root, starts);
    const text = (await tool.handler({ lyrics: 'none', style: 'Orchestral swell.' }, CONTEXT)) as string;
    const job = await jobOf(starts, 0);
    expect(job.engine).toBe('stable_audio');
    expect(job.inputs).toBeUndefined();
    expect(text).toContain('none: instrumental');
  });

  it('allows SA3 prompts beyond ACE’s caption ceiling and refuses them for ACE', async () => {
    const media = await configuredMedia();
    const starts: Started[] = [];
    const { tool } = toolFor(media, root, starts);
    const longStyle = 'S'.repeat(513);
    const lyricsPath = path.join(root, 'long-style-lyrics.txt');
    await fs.writeFile(lyricsPath, 'A short lyric.', 'utf8');
    await expect(
      tool.handler(
        { lyrics: 'agent', lyrics_path: lyricsPath, style: longStyle },
        CONTEXT,
      ),
    ).rejects.toThrow(/ACE-Step's 512-character caption limit/);
    expect(starts).toHaveLength(0);

    await tool.handler({ lyrics: 'none', style: longStyle, analyze: false }, CONTEXT);
    const job = await jobOf(starts, 0);
    expect(job.engine).toBe('stable_audio');
    expect(job.prompt).toBe(longStyle);
  });

  it('refuses a music render below the configured VRAM minimum before taking a lease', async () => {
    const media = await configuredMedia();
    const starts: Started[] = [];
    const { tool } = toolFor(media, root, starts, undefined, async () => [
      {
        index: 2,
        name: 'RTX test',
        memoryUsedMb: 6_000,
        memoryTotalMb: 16_000,
        utilizationPercent: 0,
        temperatureC: 30,
      },
    ]);
    await expect(
      tool.handler({ lyrics: 'none', style: 'Quiet piano.', analyze: false }, CONTEXT),
    ).rejects.toThrow(/only 10[.,]000 MB free.*11[.,]000 MB is required/);
    expect(starts).toHaveLength(0);
    await expect(fs.readFile(path.join(root, 'lease.json'), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('refuses stable_audio with lyrics and names the alternative', async () => {
    const media = await configuredMedia();
    const lyricsPath = path.join(root, 'lyrics.txt');
    await fs.writeFile(lyricsPath, 'Words.', 'utf8');
    const starts: Started[] = [];
    const { tool } = toolFor(media, root, starts);
    await expect(
      tool.handler(
        { lyrics: 'user', lyrics_path: lyricsPath, style: 'Folk.', engine: 'stable_audio' },
        CONTEXT,
      ),
    ).rejects.toThrow(/cannot sing.*ace_step.*lyrics: none/);
    expect(starts).toHaveLength(0);
  });

  it('allows ace_step with lyrics none, writing the instrumental marker itself', async () => {
    const media = await configuredMedia();
    const starts: Started[] = [];
    const { tool } = toolFor(media, root, starts);
    await tool.handler({ lyrics: 'none', style: 'Film score.', engine: 'ace_step' }, CONTEXT);
    const job = await jobOf(starts, 0);
    expect(job.engine).toBe('ace_step');
    const lyricsFile = (job.inputs as Record<string, string>).lyrics_path;
    expect(lyricsFile).toContain(path.join('input', 'lyrics.txt'));
    expect(await fs.readFile(lyricsFile, 'utf8')).toContain('[Instrumental]');
  });

  it('requires lyrics_path for a sung mode and refuses it for none', async () => {
    const media = await configuredMedia();
    const { tool } = toolFor(media, root, []);
    await expect(tool.handler({ lyrics: 'user', style: 'Folk.' }, CONTEXT)).rejects.toThrow(
      /lyrics_path is required when lyrics is "user"/,
    );
    await expect(
      tool.handler({ lyrics: 'none', style: 'Folk.', lyrics_path: path.join(root, 'x.txt') }, CONTEXT),
    ).rejects.toThrow(/lyrics_path is refused when lyrics is "none"/);
  });

  it('refuses a style sent with replicate: true and a replicate with no MP3', async () => {
    const media = await configuredMedia();
    const { tool } = toolFor(media, root, []);
    await expect(
      tool.handler({ lyrics: 'none', style: 'Folk.', replicate: true }, CONTEXT),
    ).rejects.toThrow(/style must be omitted/);
    await expect(
      tool.handler({ lyrics: 'none', replicate: true }, CONTEXT),
    ).rejects.toThrow(/needs source_audio_path/);
  });

  it('refuses replicate and analysis lyrics without a real analysis of an MP3', async () => {
    const media = await configuredMedia();
    const starts: Started[] = [];
    const { tool } = toolFor(media, root, starts);
    const lyricsPath = path.join(root, 'lyrics.txt');
    await fs.writeFile(lyricsPath, 'Words.', 'utf8');
    const source = path.join(root, 'source.mp3');
    await fs.writeFile(source, 'fake mp3 bytes', 'utf8');
    // replicate with the MP3 present but analyze switched off: a refusal, not
    // a style-less render.
    await expect(
      tool.handler(
        { lyrics: 'none', replicate: true, source_audio_path: source, analyze: false },
        CONTEXT,
      ),
    ).rejects.toThrow(/replicate: true with analyze: false has nothing to copy/);
    // lyrics: analysis with no MP3 at all.
    await expect(
      tool.handler({ lyrics: 'analysis', lyrics_path: lyricsPath, style: 'Folk.' }, CONTEXT),
    ).rejects.toThrow(/lyrics: "analysis" copies lyric text out of this run/);
    // lyrics: analysis with the MP3 but analyze switched off.
    await expect(
      tool.handler(
        {
          lyrics: 'analysis',
          lyrics_path: lyricsPath,
          style: 'Folk.',
          source_audio_path: source,
          analyze: false,
        },
        CONTEXT,
      ),
    ).rejects.toThrow(/lyrics: "analysis" copies lyric text out of this run/);
    expect(starts).toHaveLength(0);
  });

  it('answers a missing engine field with the setup message naming the key and path', async () => {
    const media = await configuredMedia();
    const broken = MediaConfigSchema.parse({
      ...media,
      music: {
        ...media.music,
        engines: [
          {
            id: 'ace_step',
            kind: 'ace_standalone',
            root: path.join(root, 'missing-ace'),
            checkpoints: path.join(root, 'missing-checkpoints'),
            cuda_devices: [2],
          },
          media.music.engines[1],
        ],
      },
    });
    const starts: Started[] = [];
    const { tool } = toolFor(broken, root, starts);
    const lyricsPath = path.join(root, 'lyrics.txt');
    await fs.writeFile(lyricsPath, 'Words.', 'utf8');
    await expect(
      tool.handler({ lyrics: 'user', lyrics_path: lyricsPath, style: 'Folk.' }, CONTEXT),
    ).rejects.toThrow(
      /music engine "ace_step" is not usable yet[\s\S]*media\.music\.engines\[0\]\.checkpoints/,
    );
    expect(starts).toHaveLength(0);
  });

  it('caps a Stable Audio duration at the engine max_seconds and says so', async () => {
    const media = await configuredMedia();
    const starts: Started[] = [];
    const { tool } = toolFor(media, root, starts);
    const text = (await tool.handler(
      { lyrics: 'none', style: 'Ambient bed.', seconds: 600 },
      CONTEXT,
    )) as string;
    expect(text).toContain("capped at the engine's max_seconds of 380s");
    const job = await jobOf(starts, 0);
    expect(job.seconds).toBe(380);
  });
});
