/**
 * The plan's replicate rule (docs/plans/MEDIA_SHIPPED_PLAN.md §1, "Replicate
 * from an MP3"): with `replicate: true` the caption and, for `lyrics: analysis`,
 * the lyric text come from THIS run's analysis files. ACE preserves the caption
 * apart from its reported limit; SA3 removes vocal sentences and reports them.
 * Nothing may be paraphrased, and the lyric extraction fails closed: Music
 * Flamingo's own analysis says it does not transcribe lyrics, so a run that
 * produced no lyric text ends the chain instead of inventing some.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: undefined },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

import type { MediaConfig } from '../../src/config/mediaSchema';
import { MediaConfigSchema } from '../../src/config/mediaSchema';
import { mediaOutcomeNotice } from '../../src/tools/media/mediaManifest';
import { makeGenerateMusicTool } from '../../src/tools/media/generateMusicTool';
import {
  flamingoCaption,
  resolveSuppliedLyrics,
  writeLyricsFile,
} from '../../src/tools/media/mediaLyrics';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-media-replicate-'));
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

async function writeFileFixture(candidate: string, contents: string): Promise<string> {
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  await fs.writeFile(candidate, contents, 'utf8');
  return candidate;
}

async function configuredMedia(): Promise<MediaConfig> {
  const comfyPython = await writeFileFixture(
    path.join(root, 'comfyui', '.venv', 'Scripts', 'python.exe'),
    'fixture',
  );
  await writeFileFixture(path.join(root, 'comfyui', 'main.py'), 'fixture');
  const stableCheckpoint = await writeFileFixture(
    path.join(root, 'comfyui', 'models', 'checkpoints', 'stable_audio_3_medium.safetensors'),
    'fixture',
  );
  const stableEncoder = await writeFileFixture(
    path.join(root, 'comfyui', 'models', 'text_encoders', 't5gemma.safetensors'),
    'fixture',
  );
  const acePython = await writeFileFixture(
    path.join(root, 'ACE-Step-1.5', '.venv', 'Scripts', 'python.exe'),
    'fixture',
  );
  void acePython;
  await fs.mkdir(path.join(root, 'ace-checkpoints'), { recursive: true });
  const launcher = await writeFileFixture(path.join(root, 'flamingo', 'Start-DLT.ps1'), 'fixture');
  await writeFileFixture(path.join(root, 'flamingo', '.venv', 'Scripts', 'python.exe'), 'fixture');
  return MediaConfigSchema.parse({
    enabled: true,
    comfyui: { root: path.join(root, 'comfyui'), python: comfyPython },
    music: {
      analyzer: { kind: 'flamingo_dlt', launcher },
      engines: [
        {
          id: 'ace_step',
          kind: 'ace_standalone',
          root: path.join(root, 'ACE-Step-1.5'),
          checkpoints: path.join(root, 'ace-checkpoints'),
          cuda_devices: [2],
        },
        {
          id: 'stable_audio',
          kind: 'comfyui_sa3',
          checkpoint: stableCheckpoint,
          text_encoder: stableEncoder,
          cuda_devices: [2],
        },
      ],
    },
  });
}

interface StartedStage {
  jobFile: string;
  command: string;
}

function toolFor(
  media: MediaConfig,
  started: StartedStage[],
  logs: string[],
): { handler: RegisteredTool['handler']; finish: (index: number) => void } {
  const gates: Array<() => void> = [];
  const background = {
    start: (spec: { command: string; args: readonly string[] }) => {
      started.push({ jobFile: spec.args[1], command: spec.command });
      gates.push(() => undefined);
      return {
        id: `exec-${started.length}`,
        status: 'running',
        pid: 700 + started.length,
        startedAt: Date.now(),
      };
    },
    waitFinished: () =>
      new Promise<unknown>((resolve) => {
        gates[gates.length - 1] = () => resolve(undefined);
      }),
  };
  const tool = makeGenerateMusicTool({
    getConfig: () => ({
      active_model: 'primary',
      llama_server: { binary: 'llama-server' },
      models: [{ name: 'primary', gguf_path: '/p.gguf' }],
      media,
    }),
    adaptersDir: path.join(root, 'resources', 'media'),
    workspaceRoot: root,
    lifecycle: {
      loadedModels: () => [],
      isBusy: () => false,
      unloadModel: async () => ({ unloaded: true }),
    },
    leasePath: path.join(root, 'lease.json'),
    leasePid: 10,
    leaseProcessStartTime: 1000,
    lookupProcessStartTime: async () => 1000,
    background,
    gpuProbe: async () =>
      [0, 1, 2].map((index) => ({
        index,
        name: `test-gpu-${index}`,
        memoryUsedMb: 0,
        memoryTotalMb: 16_000,
        utilizationPercent: 0,
        temperatureC: 30,
      })),
    ffmpegTools: { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' },
    // The source duration is a metadata read; a unit test answers it directly.
    probeDuration: async () => 30,
    log: (line) => logs.push(line),
  });
  return {
    handler: tool.handler,
    finish: (index) => {
      gates[index]?.();
    },
  };
}

const ANALYSIS_TEXT =
  'A slow, aching ballad in a minor key: fingerpicked acoustic guitar over a ' +
  'warm synth pad, brushed snare on the fourth beat, a breathy vocal double on ' +
  'the chorus line, tempo 74 bpm, key F# minor, structure verse-chorus-verse-outro, ' +
  'the last chorus delaying the downbeat by an eighth.';

async function jobAt(started: StartedStage[], index: number): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(started[index].jobFile, 'utf8')) as Record<string, unknown>;
}

async function runDirOf(started: StartedStage[], index: number): Promise<string> {
  return path.dirname(started[index].jobFile);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The render stage starts after the analysis stage ends; poll, never guess. */
async function waitStages(started: StartedStage[], count: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (started.length >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

describe('generate_music: replicate copies the analysis, it does not paraphrase', () => {
  it('starts the analysis stage first and the render stage from its files', async () => {
    const media = await configuredMedia();
    const started: StartedStage[] = [];
    const logs: string[] = [];
    const { handler, finish } = toolFor(media, started, logs);
    const source = await writeFileFixture(path.join(root, 'source.mp3'), 'fake mp3 bytes');
    const sung = await writeFileFixture(
      path.join(root, 'words.txt'),
      'A chorus written by the agent.',
    );
    void sung;
    const text = (await handler(
      { lyrics: 'agent', lyrics_path: sung, replicate: true, source_audio_path: source },
      { conversationId: 'conversation-1' },
    )) as string;
    expect(text).toContain('analysis stage started');
    const analysisJob = await jobAt(started, 0);
    expect(analysisJob.engine).toBe('flamingo_dlt');
    const copiedSource = (analysisJob.inputs as Record<string, string>).source_audio_path as string;
    expect(path.basename(copiedSource)).toBe('source-audio.mp3');
    expect(await fs.readFile(copiedSource, 'utf8')).toBe('fake mp3 bytes');
    expect(path.basename(started[0].jobFile)).toBe('job.analyze.json');

    const runDir = await runDirOf(started, 0);
    await writeFileFixture(
      path.join(runDir, 'output', 'analysis.json'),
      JSON.stringify({
        schema_version: 1,
        engine: 'flamingo_dlt',
        raw_text: ANALYSIS_TEXT,
        raw_records: [],
        fields: { tempo_bpm: 74, key: 'F# minor' },
        warnings: ['BPM and key values from Music Flamingo are estimates.'],
      }),
    );
    await writeFileFixture(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({
        run_id: path.basename(runDir),
        engine: 'flamingo_dlt',
        status: 'completed',
      }),
    );
    finish(0);
    expect(await waitStages(started, 2)).toBe(true);
    const renderJob = await jobAt(started, 1);
    expect(renderJob.engine).toBe('ace_step');
    // Byte for byte: the caption is the analysis text itself, not a summary.
    expect(renderJob.prompt).toBe(ANALYSIS_TEXT);
    expect(path.basename(started[1].jobFile)).toBe('job.json');
    const notes = await fs.readFile(path.join(runDir, 'render-notes.txt'), 'utf8');
    expect(notes).toContain('Flamingo description, copied verbatim');
    expect(notes).toContain('estimates');
  });

  it('trims a too-long description to the engine limit and reports the cut', async () => {
    const media = await configuredMedia();
    const started: StartedStage[] = [];
    const long = `${'A'.repeat(500)}${'B'.repeat(120)}`;
    const { handler, finish } = toolFor(media, started, []);
    const source = await writeFileFixture(path.join(root, 'long.mp3'), 'fake mp3 bytes');
    const words = await writeFileFixture(path.join(root, 'words2.txt'), 'Second set of words.');
    await handler(
      { lyrics: 'agent', lyrics_path: words, replicate: true, source_audio_path: source },
      { conversationId: 'conversation-1' },
    );
    const runDir = await runDirOf(started, 0);
    await writeFileFixture(
      path.join(runDir, 'output', 'analysis.json'),
      JSON.stringify({
        engine: 'flamingo_dlt',
        raw_text: long,
        raw_records: [],
        fields: {},
        warnings: [],
      }),
    );
    await writeFileFixture(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({ run_id: path.basename(runDir), status: 'completed' }),
    );
    finish(0);
    expect(await waitStages(started, 2)).toBe(true);
    const renderJob = await jobAt(started, 1);
    expect((renderJob.prompt as string).length).toBe(512);
    const notes = await fs.readFile(path.join(runDir, 'render-notes.txt'), 'utf8');
    expect(notes).toContain("over the engine's 512");
    expect(notes).toContain('BBBB');
  });

  it('copies an OGG voice source into the run input folder for analysis', async () => {
    const media = await configuredMedia();
    const started: StartedStage[] = [];
    const { handler } = toolFor(media, started, []);
    const source = await writeFileFixture(path.join(root, 'voice.ogg'), 'fake ogg bytes');
    await handler(
      {
        lyrics: 'agent',
        lyrics_path: await writeFileFixture(path.join(root, 'voice-lyrics.txt'), 'Words.'),
        replicate: true,
        source_audio_path: source,
      },
      { conversationId: 'conversation-1' },
    );
    const analysisJob = await jobAt(started, 0);
    const copiedSource = (analysisJob.inputs as Record<string, string>).source_audio_path as string;
    expect(copiedSource).toContain(path.join('input', 'source-audio.ogg'));
    expect(await fs.readFile(copiedSource, 'utf8')).toBe('fake ogg bytes');
  });

  it('writes Flamingo\u2019s lyric text verbatim when the analysis has any', async () => {
    const media = await configuredMedia();
    const started: StartedStage[] = [];
    const { handler, finish } = toolFor(media, started, []);
    const source = await writeFileFixture(path.join(root, 'song.mp3'), 'fake mp3 bytes');
    const lyricsPath = path.join(root, 'chosen-lyrics.txt');
    await handler(
      { lyrics: 'analysis', lyrics_path: lyricsPath, replicate: true, source_audio_path: source },
      { conversationId: 'conversation-1' },
    );
    const runDir = await runDirOf(started, 0);
    await writeFileFixture(
      path.join(runDir, 'output', 'analysis.json'),
      JSON.stringify({
        engine: 'flamingo_dlt',
        raw_text: `A minor-key ballad. Lyrics: ${'first line\nsecond line'}`,
        raw_records: [],
        fields: { lyrics: 'first line\nsecond line' },
        warnings: [],
      }),
    );
    await writeFileFixture(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({ run_id: path.basename(runDir), status: 'completed' }),
    );
    finish(0);
    expect(await waitStages(started, 2)).toBe(true);
    const renderJob = await jobAt(started, 1);
    const sung = (renderJob.inputs as Record<string, string>).lyrics_path;
    expect(await fs.readFile(sung, 'utf8')).toContain('first line\nsecond line');
    const notes = await fs.readFile(path.join(runDir, 'render-notes.txt'), 'utf8');
    expect(notes).toContain('unverified');
  });

  it('fails closed when the analysis returned no lyric text, rendering nothing', async () => {
    const media = await configuredMedia();
    const started: StartedStage[] = [];
    const logs: string[] = [];
    const { handler, finish } = toolFor(media, started, logs);
    const source = await writeFileFixture(path.join(root, 'instrumental.mp3'), 'fake mp3 bytes');
    await handler(
      {
        lyrics: 'analysis',
        lyrics_path: path.join(root, 'lyrics.txt'),
        style: 'A cover of the source.',
        source_audio_path: source,
      },
      { conversationId: 'conversation-1' },
    );
    const runDir = await runDirOf(started, 0);
    await writeFileFixture(
      path.join(runDir, 'output', 'analysis.json'),
      JSON.stringify({
        engine: 'flamingo_dlt',
        raw_text: 'A string swell over rain.',
        fields: {},
        warnings: [],
      }),
    );
    await writeFileFixture(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({ run_id: path.basename(runDir), status: 'completed' }),
    );
    finish(0);
    await wait(50);
    expect(started).toHaveLength(1);
    expect(logs.join(' ')).toContain('was not started');
    expect(logs.join(' ')).toContain('returned no lyric text');
    await expect(fs.readFile(path.join(root, 'lease.json'), 'utf8')).rejects.toThrow(/ENOENT/);
  });

  it('keeps the whitespace of Flamingo text and of its lyric text unchanged', async () => {
    const media = await configuredMedia();
    const started: StartedStage[] = [];
    const { handler, finish } = toolFor(media, started, []);
    const source = await writeFileFixture(path.join(root, 'keep.mp3'), 'fake mp3 bytes');
    await handler(
      {
        lyrics: 'analysis',
        lyrics_path: path.join(root, 'lyrics.txt'),
        replicate: true,
        source_audio_path: source,
      },
      { conversationId: 'conversation-1' },
    );
    const runDir = await runDirOf(started, 0);
    // Leading spaces, a blank line and a trailing newline: all of it is the
    // analysis text, so all of it must survive into what the engine is given.
    const rawText =
      '  A minor-key ballad, breathy vocal on the chorus.\n\nLyrics: first line\nsecond line\n\n';
    await writeFileFixture(
      path.join(runDir, 'output', 'analysis.json'),
      JSON.stringify({
        engine: 'flamingo_dlt',
        raw_text: rawText,
        raw_records: [],
        fields: {},
        warnings: [],
      }),
    );
    await writeFileFixture(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({ run_id: path.basename(runDir), status: 'completed' }),
    );
    finish(0);
    expect(await waitStages(started, 2)).toBe(true);
    const renderJob = await jobAt(started, 1);
    expect(renderJob.prompt).toBe(rawText);
    const sung = (renderJob.inputs as Record<string, string>).lyrics_path;
    expect(await fs.readFile(sung, 'utf8')).toBe('first line\nsecond line');
  });
  it('removes only vocal sentences for SA3 and reports them in the manifest notice', async () => {
    const media = await configuredMedia();
    const started: StartedStage[] = [];
    const { handler, finish } = toolFor(media, started, []);
    const source = await writeFileFixture(path.join(root, 'instrumental.mp3'), 'fake mp3 bytes');
    await handler(
      { lyrics: 'none', replicate: true, source_audio_path: source },
      { conversationId: 'conversation-1' },
    );
    const runDir = await runDirOf(started, 0);
    const rawText =
      '  A soft piano motif carries the first verse.\n' +
      'A breathy singer sings “stay close to me.”\n' +
      'The low strings lift into a warm crescendo.';
    await writeFileFixture(
      path.join(runDir, 'output', 'analysis.json'),
      JSON.stringify({ engine: 'flamingo_dlt', raw_text: rawText, fields: {}, warnings: [] }),
    );
    await writeFileFixture(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({ run_id: path.basename(runDir), status: 'completed' }),
    );
    finish(0);
    expect(await waitStages(started, 2)).toBe(true);
    const renderJob = await jobAt(started, 1);
    const expectedKept =
      '  A soft piano motif carries the first verse.\n' +
      'The low strings lift into a warm crescendo.';
    expect(renderJob.engine).toBe('stable_audio');
    expect(renderJob.prompt).toBe(`${expectedKept} instrumental music throughout`);
    const reports = renderJob.tool_reports as string[];
    expect(reports).toContain(
      'Stable Audio 3 has no hard prompt length limit; the caption was not trimmed.',
    );
    expect(reports.some((report) => report.includes('A breathy singer sings “stay close to me.”'))).toBe(
      true,
    );
    await writeFileFixture(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({
        run_id: path.basename(runDir),
        engine: 'stable_audio',
        status: 'completed',
        tool_reports: reports,
      }),
    );
    const notice = await mediaOutcomeNotice(runDir);
    expect(notice.lines.filter((line) => line.includes('A breathy singer sings'))).toHaveLength(1);
  });
});

describe('mediaLyrics: the text is copied, not rewritten', () => {
  it('uses ACE’s 512-character ceiling and leaves SA3 captions untrimmed', () => {
    const rawText = 'x'.repeat(520);
    const analysis = { rawText, fields: {}, warnings: [] };
    const ace = flamingoCaption(analysis, 'ace_standalone');
    expect(ace.text).toBe('x'.repeat(512));
    expect(ace.reports[0]).toContain("over the engine's 512");

    const sa3 = flamingoCaption(analysis, 'comfyui_sa3');
    expect(sa3.text).toBe(`${rawText} instrumental music throughout`);
    expect(sa3.reports).toContain(
      'Stable Audio 3 has no hard prompt length limit; the caption was not trimmed.',
    );
  });

  it('keeps leading spaces and a trailing newline of supplied lyrics', async () => {
    const file = await writeFileFixture(
      path.join(root, 'words-ws.txt'),
      '  One two three, four five six.\n\n',
    );
    const resolved = await resolveSuppliedLyrics(file, 'user');
    expect(resolved.text).toBe('  One two three, four five six.\n\n');
  });

  it('refuses lyrics that are only whitespace', async () => {
    const file = await writeFileFixture(path.join(root, 'blank.txt'), '  \n');
    await expect(resolveSuppliedLyrics(file, 'user')).rejects.toThrow(/is empty/);
  });

  it('cuts an over-limit lyric text and says how much was cut', async () => {
    const target = path.join(root, 'cut-lyrics.txt');
    const report = await writeLyricsFile(target, `${'A'.repeat(4_096)}BBBB`);
    expect(await fs.readFile(target, 'utf8')).toBe('A'.repeat(4_096));
    expect(report).toContain("was 4100 characters, over the engine's 4096");
    expect(report).toContain('the last 4 were cut');
  });
});
