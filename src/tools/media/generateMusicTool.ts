/**
 * `generate_music` — style prompt plus a lyrics choice, on the configured local
 * music engine.
 *
 * The lyrics choice picks the engine and the TOOL routes it, not the model
 * (docs/plans/MEDIA_SHIPPED_PLAN.md §1, "The lyrics choice picks the engine"):
 * `user`/`agent`/`analysis` go to ACE-Step 1.5 because it can sing, `none` goes
 * to Stable Audio 3 post-trained because it cannot. Strict schema, no blob
 * argument: lyric text never rides inline — it is a workspace file the model
 * already wrote, which is also why `lyrics_path` is refused for `none`.
 */
import * as path from 'path';
import type { MediaConfig, MediaMusicEngineConfig } from '../../config/mediaSchema';
import { displayPath } from '../imageGeneration/generateImageToolFormat';
import { resolveRealWorkspacePath } from '../../util/WorkspacePaths';
import { resolveFfmpeg } from '../ffmpegLocate';
import {
  adapterEngineName,
  engineNotConfiguredMessage,
  mediaSetupReport,
  resolveMusicEngine,
  setupLinesFor,
  adapterRunnerMessage,
  setupMessage,
} from './mediaEngineSetup';
import {
  COMFYUI_JOB_TIMEOUT_SECONDS,
  COMFYUI_STARTUP_TIMEOUT_SECONDS,
  MEDIA_JOB_SCHEMA_VERSION,
  absolutePath,
  aceBlock,
  analyzerBlock,
  comfyUiBlock,
  musicBlock,
  writeJobFile,
  type MediaJobFile,
} from './mediaJobFile';
import {
  MUSIC_DEFINITION,
  MUSIC_PROMPT_ARGUMENT_LIMIT,
  MUSIC_TOOL_NAME,
  POWERSHELL,
  withMusicEngineEnum,
} from './generateMusicSchema';
import { adapterInvocation, isFileQuiet, prepareRunFolders, writeRunNotes } from './mediaRun';
import { copyRunInputFile, isSupportedMusicAudioPath } from './mediaInputFiles';
import { booleanArg, enumArg, numberArg, pathArg, textArg } from './mediaArgs';
import { refuseInvalidMusicRequest, refuseOverlongAceStyle } from './generateMusicGuards';
import {
  captionOriginReport,
  flamingoCaption,
  flamingoLyrics,
  replicateModeResult,
  replicateSourceNote,
  readAnalysis,
  resolveSuppliedLyrics,
  writeInstrumentalLyrics,
  writeLyricsFile,
  type MediaLyricsResolution,
} from './mediaLyrics';
import {
  startMediaRender,
  type MediaRenderRequest,
  type MediaRenderStart,
} from './mediaRenderRunner';
import type { BackgroundExecutionCompletion } from '../BackgroundExecutionManager';
import { prepareTelegramPreview, workspaceRelativePath } from './mediaDelivery';
import {
  assertMediaEngineVram,
  defaultProbeDuration,
  renderDepsFrom,
  toolWorkspaceRoot,
  type MediaToolDeps,
} from './mediaToolDeps';
import type { RegisteredTool, ToolHandlerContext } from '../ToolRegistry';

export function makeGenerateMusicTool(deps: MediaToolDeps): RegisteredTool {
  const media = (): MediaConfig | undefined => deps.getConfig().media;
  return {
    definition: MUSIC_DEFINITION,
    // Same approval shape as `generate_video`: a configured local program plus a
    // workspace write, and no card, because the conversation already decided.
    permission: 'headless',
    additionalPermissions: ['write'],
    mutation: { paths: () => [], showDiff: false },
    advertise: () => media()?.enabled === true,
    describe: () => withMusicEngineEnum(media()),
    handler: (args, context) => runGenerateMusic(deps, args, context),
  };
}

/** The engine a lyrics mode routes to, by the kind that can deliver it. */
function wantedKind(lyricsMode: string): MediaMusicEngineConfig['kind'] {
  return lyricsMode === 'none' ? 'comfyui_sa3' : 'ace_standalone';
}

function kindLabel(kind: MediaMusicEngineConfig['kind']): string {
  return kind === 'comfyui_sa3'
    ? 'stable_audio (Stable Audio 3 post-trained)'
    : 'ace_step (ACE-Step 1.5)';
}

async function runGenerateMusic(
  deps: MediaToolDeps,
  args: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
): Promise<string> {
  const config = deps.getConfig();
  const media = config.media;
  if (!media?.enabled) {
    throw new Error(
      'generate_music: media generation is off (media.enabled). Add a media: block to config.yaml ' +
        'with media.enabled: true and a music engine, then call it again.',
    );
  }
  const workspaceRoot = toolWorkspaceRoot(deps);
  const lyricsMode = enumArg(
    args,
    'lyrics',
    MUSIC_TOOL_NAME,
    ['user', 'agent', 'analysis', 'none'],
    {
      required: true,
    },
  ) as 'user' | 'agent' | 'analysis' | 'none';
  const style = textArg(args, 'style', MUSIC_TOOL_NAME, MUSIC_PROMPT_ARGUMENT_LIMIT);
  const lyricsPathArg = pathArg(args, 'lyrics_path', MUSIC_TOOL_NAME);
  const sourceAudioArg = pathArg(args, 'source_audio_path', MUSIC_TOOL_NAME);
  const analyzeArg = booleanArg(args, 'analyze', MUSIC_TOOL_NAME);
  const replicate = booleanArg(args, 'replicate', MUSIC_TOOL_NAME) === true;
  const requestedEngine = media.music.engines.length
    ? enumArg(
        args,
        'engine',
        MUSIC_TOOL_NAME,
        media.music.engines.map((engine) => engine.id),
      )
    : textArg(args, 'engine', MUSIC_TOOL_NAME, 120);
  const seconds = numberArg(args, 'seconds', MUSIC_TOOL_NAME, { min: 1, max: 3_600 });
  const seed = numberArg(args, 'seed', MUSIC_TOOL_NAME, { integer: true, min: 0 });

  const analyze = analyzeArg ?? sourceAudioArg !== undefined;
  refuseInvalidMusicRequest({
    lyricsMode,
    ...(style !== undefined ? { style } : {}),
    ...(lyricsPathArg !== undefined ? { lyricsPath: lyricsPathArg } : {}),
    ...(sourceAudioArg !== undefined ? { sourceAudio: sourceAudioArg } : {}),
    analyze,
    replicate,
  });

  const selection = requestedEngine
    ? resolveMusicEngine(media, requestedEngine)
    : engineForKind(media, wantedKind(lyricsMode));
  if (!selection) {
    throw new Error(
      requestedEngine
        ? `generate_music: "${requestedEngine}" is not a configured media.music.engines id ` +
            `(configured: ${media.music.engines.map((engine) => engine.id).join(', ') || 'none'}). ` +
            'Omit engine to let the lyrics choice route it.'
        : engineNotConfiguredMessage(
            MUSIC_TOOL_NAME,
            kindLabel(wantedKind(lyricsMode)),
            media.music.engines.map((engine) => engine.id),
          ),
    );
  }
  if (selection.engine.kind === 'comfyui_sa3' && lyricsMode !== 'none') {
    throw new Error(
      `generate_music: engine "${selection.id}" is Stable Audio 3, which cannot sing, so it is ` +
        `refused for lyrics: ${lyricsMode}. Use an ace_step engine id for words, or lyrics: none ` +
        'for an instrumental on this one.',
    );
  }
  if (selection.engine.kind === 'ace_standalone') refuseOverlongAceStyle(style);
  const runnerMissing = adapterRunnerMessage(media, MUSIC_TOOL_NAME);
  if (runnerMissing) throw new Error(runnerMissing);
  const ffmpegTools = deps.ffmpegTools ?? resolveFfmpeg(media.ffmpeg);
  const report = mediaSetupReport(media, workspaceRoot, {
    resolveFfmpeg: () => ffmpegTools,
    stillBackendNames: (config.image_generation?.backends ?? [])
      .filter((backend) => backend.provider === 'sdcpp')
      .map((backend) => backend.name),
  });
  if (
    !setupLinesFor(report, 'music', selection, selection.engine).some(
      (line) => line === `music ${selection.id}: configured`,
    )
  ) {
    throw new Error(setupMessage(report, 'music', selection, selection.engine, MUSIC_TOOL_NAME));
  }
  if (analyze && !report.entries.includes('music analyzer: configured')) {
    throw new Error(
      `${MUSIC_TOOL_NAME}: source-audio analysis is unavailable. ` +
        report.entries.filter((line) => line.startsWith('media.music.analyzer')).join(' ') +
        ' Set media.music.analyzer.launcher (and its .venv runtime), or pass analyze: false with a style prompt.',
    );
  }

  let sourceAudio: string | undefined;
  if (sourceAudioArg) {
    sourceAudio = await resolveRealWorkspacePath(sourceAudioArg, workspaceRoot);
    if (!(await isFileQuiet(sourceAudio))) {
      throw new Error(
        `generate_music: source_audio_path "${sourceAudioArg}" is not a file inside the workspace.`,
      );
    }
    if (!isSupportedMusicAudioPath(sourceAudio)) {
      throw new Error(
        `generate_music: source_audio_path must be MP3, OGG/Opus, M4A, WAV, FLAC, AAC or WebM audio, not ` +
          `"${path.basename(sourceAudio)}".`,
      );
    }
  }
  const lyricsPathResolved = lyricsPathArg
    ? await resolveRealWorkspacePath(lyricsPathArg, workspaceRoot, { allowMissing: true })
    : undefined;

  const folders = await prepareRunFolders(media, 'music', workspaceRoot);
  if (sourceAudio)
    sourceAudio = await copyRunInputFile(sourceAudio, folders.inputDir, 'source-audio');
  let secondsValue = seconds;
  const secondsNotes: string[] = [];
  if (secondsValue === undefined) {
    if (sourceAudio) {
      const probed = await (deps.probeDuration ?? defaultProbeDuration)(sourceAudio, ffmpegTools);
      secondsValue = probed !== undefined && probed > 0 ? probed : media.music.default_seconds;
      secondsNotes.push(
        probed !== undefined && probed > 0
          ? `length taken from the source (${Math.round(probed)} s)`
          : `length from media.music.default_seconds: ffprobe gave no duration for the source`,
      );
    } else {
      secondsValue = media.music.default_seconds;
    }
  }
  if (selection.engine.kind === 'comfyui_sa3' && secondsValue > selection.engine.max_seconds) {
    secondsNotes.push(
      `length capped at the engine's max_seconds of ${selection.engine.max_seconds}s ` +
        `(asked for ${secondsValue}s)`,
    );
    secondsValue = selection.engine.max_seconds;
  }
  secondsValue = secondsValue ?? media.music.default_seconds;
  const secondsChosen = secondsValue;

  const selectionId = selection.id;
  const selectionEngine = selection.engine;
  const engineId = selectionId;
  const engine = selectionEngine;
  const adapterEngine = adapterEngineName(engine);
  const comfy = comfyUiBlock(media.comfyui, folders.runDir, workspaceRoot);
  const timeoutMs = (COMFYUI_STARTUP_TIMEOUT_SECONDS + COMFYUI_JOB_TIMEOUT_SECONDS) * 1_000;
  const deliveryConversationId = context?.conversationId;
  const deliverMediaFile = deps.deliverMediaFile;
  const onFinished =
    deliveryConversationId && deliverMediaFile
      ? async (completion: BackgroundExecutionCompletion) => {
          if (completion.status !== 'completed') return;
          const trackPath = path.join(folders.runDir, 'output', 'track.mp3');
          const workspacePath = workspaceRelativePath(trackPath, workspaceRoot);
          if (!workspacePath) throw new Error('the completed track is outside the workspace');
          const preview = await prepareTelegramPreview(trackPath, 'audio', ffmpegTools.ffmpeg);
          const previewPath = preview ? workspaceRelativePath(preview, workspaceRoot) : undefined;
          if (preview && !previewPath)
            throw new Error('the audio preview is outside the workspace');
          await deliverMediaFile({
            conversationId: deliveryConversationId,
            kind: 'audio',
            workspacePath,
            ...(previewPath ? { previewPath } : {}),
            text: 'Forge: music render completed.',
          });
        }
      : undefined;

  const stageTwoJob = (
    caption: string,
    lyrics: MediaLyricsResolution | undefined,
    estimates: { bpm?: number; keyscale?: string; timesignature?: string },
    toolReports: readonly string[] = [],
  ): MediaJobFile => {
    const base: MediaJobFile = {
      schema_version: MEDIA_JOB_SCHEMA_VERSION,
      run_id: folders.runId,
      run_dir: folders.runDir,
      kind: 'music',
      engine: adapterEngine,
      prompt: caption,
      seconds: secondsChosen,
      ...(seed !== undefined ? { seed } : {}),
      cuda_devices: engine.cuda_devices,
      ffmpeg: ffmpegTools.ffmpeg,
      ffprobe: ffmpegTools.ffprobe,
      ...(toolReports.length ? { tool_reports: [...toolReports] } : {}),
      // Stable Audio 3 has no lyrics input at all; a sung engine always does.
      ...(lyrics ? { inputs: { lyrics_path: lyrics.path } } : {}),
    };
    if (engine.kind === 'ace_standalone') {
      base.ace = aceBlock(engine, workspaceRoot, estimates);
    } else {
      base.comfyui = comfy;
      base.models = {
        checkpoint: absolutePath(engine.checkpoint, workspaceRoot),
        text_encoder: absolutePath(engine.text_encoder, workspaceRoot),
      };
      base.music = musicBlock(engine.max_seconds);
    }
    return base;
  };

  const stageRequest = (jobFile: string, stageLabel: string): MediaRenderRequest => {
    const invocation = adapterInvocation(
      deps.adaptersDir,
      media.comfyui.python,
      jobFile,
      folders.runDir,
      engine.cuda_devices,
      { ...(context?.conversationId ? { FORGE_CONVERSATION_ID: context.conversationId } : {}) },
    );
    return {
      runId: folders.runId,
      runDir: folders.runDir,
      kind: 'music',
      engineId: stageLabel,
      cudaDevices: engine.cuda_devices,
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      jobFile,
      env: invocation.env,
      timeoutMs,
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
      ...(onFinished ? { onFinished } : {}),
    };
  };

  await assertMediaEngineVram(deps, engine, {
    label: `generate_music: engine "${engineId}"`,
    configKey: `media.music.engines[${selection.index}]`,
    modelPath: engine.kind === 'ace_standalone' ? engine.checkpoints : engine.checkpoint,
    nothingRan: 'no music was generated',
    alternativeMessage: 'another configured music engine or a GPU with enough free VRAM',
  });

  let started: MediaRenderStart;
  if (analyze) {
    const analysisJob: MediaJobFile = {
      schema_version: MEDIA_JOB_SCHEMA_VERSION,
      run_id: folders.runId,
      run_dir: folders.runDir,
      kind: 'music',
      engine: 'flamingo_dlt',
      seconds: secondsChosen,
      ...(seed !== undefined ? { seed } : {}),
      cuda_devices: engine.cuda_devices,
      ffmpeg: ffmpegTools.ffmpeg,
      ffprobe: ffmpegTools.ffprobe,
      inputs: { source_audio_path: sourceAudio as string },
      analyzer: analyzerBlock(media.music.analyzer, POWERSHELL, workspaceRoot),
    };
    const analysisJobFile = await writeJobFile(folders.runDir, analysisJob, 'job.analyze.json');
    started = await startMediaRender(
      {
        ...stageRequest(analysisJobFile, `${engineId}+analyze`),
        // The render stage is prepared only once the analysis exists: its caption
        // and, in analysis mode, its lyric text are read from this run's own
        // files, never retyped by the model.
        next: () => prepareRenderStage(),
      },
      renderDepsFrom(deps, context),
    );
  } else {
    const caption = style as string;
    const lyrics =
      lyricsMode === 'none'
        ? engine.kind === 'ace_standalone'
          ? await writeInstrumentalLyrics(folders.runDir)
          : undefined
        : await resolveSuppliedLyrics(lyricsPathResolved as string, lyricsMode);
    const reports = lyrics
      ? [...lyrics.reports, `Lyrics: ${lyrics.source}`]
      : ['Lyrics: none: instrumental'];
    const jobFile = await writeJobFile(folders.runDir, stageTwoJob(caption, lyrics, {}, reports));
    await writeRunNotes(folders.runDir, reports);
    started = await startMediaRender(
      stageRequest(jobFile, engineId),
      renderDepsFrom(deps, context),
    );
  }

  return [
    `generate_music: ${analyze ? 'analysis stage started; the render stage starts when it ends' : 'render started'} in the background.`,
    `Run id ${folders.runId}, folder ${displayPath(folders.runDir)}.`,
    `Engine ${engineId} (${adapterEngine}) on GPU ${engine.cuda_devices.join(', ')}: ` +
      `${secondsValue} s${seed !== undefined ? `, seed ${seed}` : ''}${
        secondsNotes.length ? ` (${secondsNotes.join('; ')})` : ''
      }.`,
    `Lyrics: ${
      lyricsMode === 'none'
        ? 'none: instrumental'
        : `${lyricsMode}, from "${displayPath(lyricsPathResolved as string)}"`
    }.`,
    ...(sourceAudio
      ? [
          `Source ${displayPath(sourceAudio)}: ${
            analyze
              ? 'Music Flamingo DLT analyses it first; the render caption comes from that analysis' +
                (replicate ? replicateSourceNote(selectionEngine.kind) : ' as your style prompt')
              : 'kept with the run; no analysis stage was asked for'
          }.`,
        ]
      : []),
    ...(replicate ? [replicateModeResult(selectionEngine.kind)] : []),
    ...(lyricsMode === 'analysis'
      ? [
          'lyrics: analysis uses Flamingo\u2019s partial, unverified hearing. lyrics: user is how the ' +
            'real words get in.',
        ]
      : []),
    `Models unloaded to free those cards: ${started.unloaded.length ? started.unloaded.join(', ') : 'none: no loaded model overlaps them'}.`,
    `Execution ${started.executionId}${started.pid ? ` (pid ${started.pid})` : ''}. ` +
      'This chat is woken when the render ends, with the run manifest summary; the track lands at ' +
      `${displayPath(path.join(folders.runDir, 'output', 'track.mp3'))}.`,
  ].join('\n');

  /** Prepare the final stage from this run's analysis while the lease is held; missing evidence fails closed. */
  async function prepareRenderStage(): Promise<MediaRenderRequest | undefined> {
    const analysis = await readAnalysis(folders.runDir, MUSIC_TOOL_NAME);
    const caption = replicate
      ? flamingoCaption(analysis, selectionEngine.kind)
      : { text: style as string, reports: [] as string[] };
    const reports = [...caption.reports];
    let lyrics: MediaLyricsResolution | undefined;
    if (lyricsMode === 'analysis') {
      const extracted = flamingoLyrics(analysis, folders.runDir);
      const trimReport = await writeLyricsFile(lyricsPathResolved as string, extracted.text);
      if (trimReport) reports.push(trimReport);
      lyrics = {
        path: lyricsPathResolved as string,
        text: extracted.text,
        source: extracted.source,
        reports: [],
      };
    } else if (lyricsMode === 'none') {
      lyrics =
        selectionEngine.kind === 'ace_standalone'
          ? await writeInstrumentalLyrics(folders.runDir)
          : undefined;
    } else {
      lyrics = await resolveSuppliedLyrics(lyricsPathResolved as string, lyricsMode);
    }
    if (!lyrics && !(lyricsMode === 'none' && selectionEngine.kind === 'comfyui_sa3')) {
      throw new Error(
        `generate_music: engine "${selectionId}" takes no lyrics file, and lyrics: none needs one ` +
          'for this route. Nothing was rendered.',
      );
    }
    if (lyrics) reports.push(...lyrics.reports);
    const estimates: { bpm?: number; keyscale?: string; timesignature?: string } = {};
    if (typeof analysis.fields['tempo_bpm'] === 'number') {
      estimates.bpm = analysis.fields['tempo_bpm'] as number;
    }
    if (typeof analysis.fields['key'] === 'string') {
      estimates.keyscale = analysis.fields['key'] as string;
    }
    if (typeof analysis.fields['structure'] === 'string') {
      estimates.timesignature = analysis.fields['structure'] as string;
    }
    if (Object.values(estimates).some((value) => value !== undefined)) {
      reports.push(
        'BPM, key and time signature from Music Flamingo are estimates, passed to ACE\u2019s own fields.',
      );
    }
    reports.push(`Lyrics: ${lyrics?.source ?? 'none: Stable Audio instrumental'}`);
    reports.push(`Caption: ${captionOriginReport(replicate, selectionEngine.kind)}`);
    await writeRunNotes(folders.runDir, reports);
    const jobFile = await writeJobFile(
      folders.runDir,
      stageTwoJob(caption.text, lyrics, estimates, reports),
    );
    return stageRequest(jobFile, selectionId);
  }
}

/** The first configured engine of the kind a lyrics mode needs. */
function engineForKind(
  media: MediaConfig,
  kind: MediaMusicEngineConfig['kind'],
): { id: string; index: number; engine: MediaMusicEngineConfig } | undefined {
  const index = media.music.engines.findIndex((engine) => engine.kind === kind);
  if (index < 0) return undefined;
  return { id: media.music.engines[index].id, index, engine: media.music.engines[index] };
}
