/**
 * `generate_video` Ⅲ text/image to a short clip, on the configured local engine.
 *
 * Strict schema, no blob argument (docs/plans/MEDIA_SHIPPED_PLAN.md £3.4): the
 * motion text is bounded, and every other input is a named scalar. The tool is
 * `safe` for the approval gate the way `render_html_to_image` is Ⅲ it declares
 * no approval metadata, so rendering decided in the conversation is never
 * re-litigated with a card, and an unattended or job turn may call it.
 */
import * as path from 'path';
import type { ForgeConfig, MediaConfig, SdcppImageBackendConfig } from '../../config/types';
import { displayPath } from '../imageGeneration/generateImageToolFormat';
import { resolveRealWorkspacePath } from '../../util/WorkspacePaths';
import { resolveFfmpeg } from '../ffmpegLocate';
import type { ToolDefinition } from '../../llm/types';
import {
  adapterEngineName,
  defaultVideoEngineMessage,
  mediaSetupReport,
  resolveVideoEngine,
  setupLinesFor,
  adapterRunnerMessage,
  setupMessage,
} from './mediaEngineSetup';
import {
  COMFYUI_JOB_TIMEOUT_SECONDS,
  COMFYUI_STARTUP_TIMEOUT_SECONDS,
  MEDIA_JOB_SCHEMA_VERSION,
  VIDEO_PROMPT_LIMIT_CHARS,
  absolutePath,
  comfyUiBlock,
  videoBlock,
  writeJobFile,
  type MediaJobFile,
} from './mediaJobFile';
import { adapterInvocation, isFileQuiet, prepareRunFolders } from './mediaRun';
import { copyRunInputFile } from './mediaInputFiles';
import { enumArg, numberArg, pathArg, textArg } from './mediaArgs';
import { renderMediaStill, stillSizeName } from './mediaStill';
import { prepareTelegramPreview, workspaceRelativePath } from './mediaDelivery';
import { startMediaRender } from './mediaRenderRunner';
import {
  assertMediaEngineVram,
  renderDepsFrom,
  toolWorkspaceRoot,
  type MediaToolDeps,
} from './mediaToolDeps';
import type { RegisteredTool, ToolHandlerContext } from '../ToolRegistry';

const TOOL_NAME = 'generate_video';

/** The static, canonical definition (`scripts/tool-audit-catalog.mjs` extracts it). */
const DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description:
      'Render a short video clip with the configured local engine: LTX-2.5 image-to-video by ' +
      'default, MiniMax H3 only when asked by name. With no image_path, a still is made first ' +
      'from the configured image backend. The render starts in the background and this call ' +
      'returns the run id, the run folder and what it will do; the chat is woken with the run ' +
      'manifest when it ends. The engine takes the media GPU lease and may unload the chat model ' +
      'to free its cards; the next turn loads its model again.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          maxLength: VIDEO_PROMPT_LIMIT_CHARS,
          description:
            'The motion and scene text: what moves, how the camera behaves, the mood. Bounded; ' +
            'the engine gets it as it is.',
        },
        image_path: {
          type: 'string',
          description:
            'A workspace-relative or absolute still to animate. Absent means "make a still first" ' +
            'with the media.video.still_backend image entry.',
        },
        engine: {
          type: 'string',
          description:
            'A configured media.video.engines id. Omit it for the configured LTX-2.5 ' +
            'entry, the default for every request; a MiniMax H3 render needs its id ' +
            'named explicitly.',
        },
        seconds: {
          type: 'number',
          description: 'Clip length in seconds; default media.video.default_seconds.',
        },
        width: {
          type: 'integer',
          minimum: 64,
          description: 'Override media.video.default_size width.',
        },
        height: {
          type: 'integer',
          minimum: 64,
          description: 'Override media.video.default_size height.',
        },
        fps: {
          type: 'integer',
          minimum: 1,
          maximum: 60,
          description: 'Override media.video.default_fps.',
        },
        seed: {
          type: 'integer',
          minimum: 0,
          description:
            'Reproduce a clip. Absent means the adapter picks one and the manifest records it.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
};

/** The configured ids, offered as the enum the model was actually shown. */
function withEngineEnum(media: MediaConfig | undefined): ToolDefinition {
  const copy = structuredClone(DEFINITION);
  const engines = media?.video?.engines ?? [];
  if (engines.length) {
    const properties = copy.function.parameters.properties as Record<string, unknown>;
    (properties.engine as Record<string, unknown>).enum = engines.map((engine) => engine.id);
  }
  return copy;
}

export function makeGenerateVideoTool(deps: MediaToolDeps): RegisteredTool {
  const media = (): MediaConfig | undefined => deps.getConfig().media;
  return {
    definition: DEFINITION,
    // Spawning a configured local program is what `shell` already grants; the
    // run folder is a write. No `approval` metadata, so no card: rendering was
    // decided in the conversation (the plan's Part 3 rule).
    permission: 'headless',
    additionalPermissions: ['write'],
    mutation: { paths: () => [], showDiff: false },
    // Registered only while `media.enabled` is true, and self-suppressing so a
    // config reload that turns it off hides the tool without a window reload.
    advertise: () => media()?.enabled === true,
    describe: () => withEngineEnum(media()),
    handler: (args, context) => runGenerateVideo(deps, args, context),
  };
}

/** The configured local sd-server backends, narrowed once for both uses. */
function sdcppBackends(config: ForgeConfig): SdcppImageBackendConfig[] {
  return (config.image_generation?.backends ?? []).filter(
    (backend): backend is SdcppImageBackendConfig => backend.provider === 'sdcpp',
  );
}

function sdcppBackendNames(config: ForgeConfig): string[] {
  return sdcppBackends(config).map((backend) => backend.name);
}

async function runGenerateVideo(
  deps: MediaToolDeps,
  args: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
): Promise<string> {
  const config = deps.getConfig();
  const media = config.media;
  if (!media?.enabled) {
    throw new Error(
      'generate_video: media generation is off (media.enabled). Add a media: block to ' +
        'config.yaml with media.enabled: true and a video engine, then call it again.',
    );
  }
  const workspaceRoot = toolWorkspaceRoot(deps);
  const prompt = textArg(args, 'prompt', TOOL_NAME, VIDEO_PROMPT_LIMIT_CHARS, {
    required: true,
  }) as string;
  const imagePath = pathArg(args, 'image_path', TOOL_NAME);
  // With no engine configured there is no enum to check: the plain read keeps
  // the refusal the useful one ("no video engine is configured").
  const requestedEngine = media.video.engines.length
    ? enumArg(
        args,
        'engine',
        TOOL_NAME,
        media.video.engines.map((e) => e.id),
      )
    : textArg(args, 'engine', TOOL_NAME, 120);
  const seconds = numberArg(args, 'seconds', TOOL_NAME, { min: 0.5, max: 600 });
  const width = numberArg(args, 'width', TOOL_NAME, { integer: true, min: 64, max: 4_096 });
  const height = numberArg(args, 'height', TOOL_NAME, { integer: true, min: 64, max: 4_096 });
  const fps = numberArg(args, 'fps', TOOL_NAME, { integer: true, min: 1, max: 60 });
  const seed = numberArg(args, 'seed', TOOL_NAME, { integer: true, min: 0 });

  const selection = resolveVideoEngine(media, requestedEngine);
  if (!selection) {
    throw new Error(
      requestedEngine
        ? `generate_video: "${requestedEngine}" is not a configured media.video.engines id ` +
            `(configured: ${media.video.engines.map((e) => e.id).join(', ') || 'none'}). ` +
            'Pass a configured engine id, or omit engine to use the LTX-2.5 default.'
        : defaultVideoEngineMessage(media, TOOL_NAME),
    );
  }
  const runnerMissing = adapterRunnerMessage(media, TOOL_NAME);
  if (runnerMissing) throw new Error(runnerMissing);
  const ffmpegTools = deps.ffmpegTools ?? resolveFfmpeg(media.ffmpeg);
  const report = mediaSetupReport(media, workspaceRoot, {
    resolveFfmpeg: () => ffmpegTools,
    stillBackendNames: sdcppBackendNames(config),
  });
  if (
    !setupLinesFor(report, 'video', selection, selection.engine).some(
      (line) => line === `video ${selection.id}: configured`,
    )
  ) {
    throw new Error(setupMessage(report, 'video', selection, selection.engine, TOOL_NAME));
  }

  const engine = selection.engine;
  const size = {
    width: width ?? media.video.default_size[0],
    height: height ?? media.video.default_size[1],
  };
  const fpsValue = fps ?? media.video.default_fps;
  const secondsValue = seconds ?? media.video.default_seconds;
  if (adapterEngineName(engine) === 'ltx25') {
    // LTX-2.5 works on a 64-pixel grid in both dimensions, so a size off it fails
    // deep inside the graph, after the cards were leased, the chat model was
    // unloaded and a still was rendered. Refuse here, where no lease has been
    // taken and nothing has been spawned.
    const offGrid = [size.width, size.height].filter((value) => value % 64 !== 0);
    if (offGrid.length) {
      throw new Error(
        `generate_video: ${offGrid.join(' and ')} is not a multiple of 64, and every LTX-2.5 ` +
          `dimension must be: try ${offGrid
            .map((value) => Math.round(value / 64) * 64)
            .join(' and ')}, or omit width/height for media.video.default_size ` +
          `(${media.video.default_size.join('x')}). No GPU lease was taken and nothing ` +
          'was started.',
      );
    }
    // The adapter computes frames = round(seconds x fps) + 1 and refuses anything
    // but 8k+1, so the tool refuses before a GPU starts.
    const frames = Math.round(secondsValue * fpsValue) + 1;
    if (frames < 9 || (frames - 1) % 8) {
      throw new Error(
        `generate_video: ${secondsValue} s at ${fpsValue} fps is ${frames} frames, which LTX-2.5 ` +
          'cannot render: duration x fps must land on 8k+1 frames. Ask for a duration that does ' +
          `at this fps (for ${fpsValue} fps, a multiple of ${8 / fpsValue} s), or change fps.`,
      );
    }
  }

  const folders = await prepareRunFolders(media, 'video', workspaceRoot);
  let stillSource: string;
  let stillNote: string;
  if (imagePath) {
    const resolved = await resolveRealWorkspacePath(imagePath, workspaceRoot);
    if (!(await isFileQuiet(resolved))) {
      throw new Error(
        `generate_video: image_path "${imagePath}" is not a file inside the workspace. ` +
          'Pass a workspace-relative path to the still, or omit it to make one.',
      );
    }
    stillSource = await copyRunInputFile(resolved, folders.inputDir, 'source-still');
    stillNote = `from the user's image "${displayPath(resolved)}"`;
  } else {
    const backendName = media.video.still_backend.trim();
    const backend = sdcppBackends(config).find((candidate) => candidate.name === backendName);
    const server = deps.sdServers?.().get(backendName);
    if (!backend || !server) {
      throw new Error(
        `generate_video: text-to-video needs media.video.still_backend to name a configured ` +
          `sdcpp image entry whose sd-server is running in this window. ` +
          `"${backendName || '(empty)'}" is ${
            !backendName
              ? 'not set'
              : !backend
                ? `not a configured sdcpp backend (configured: ${sdcppBackendNames(config).join(', ') || 'none'})`
                : 'a backend whose server this window cannot own'
          }. Set still_backend, or pass image_path to animate a still you already have.`,
      );
    }
    const still = await (deps.renderStill ?? renderMediaStill)(
      {
        prompt,
        sizeName: stillSizeName(size),
        seed: seed ?? Math.floor(Math.random() * 2 ** 31),
        outDir: folders.inputDir,
      },
      {
        backend,
        server,
        alternatives: sdcppBackendNames(config).filter((name) => name !== backendName),
        ...(context?.abortSignal ? { signal: context.abortSignal } : {}),
      },
    );
    stillSource = still.path;
    stillNote =
      `made by image_generation.backends.${backendName} at ${still.width}x${still.height} ` +
      `(seed ${still.seed})`;
  }
  const comfy = comfyUiBlock(media.comfyui, folders.runDir, workspaceRoot);
  const inputs: Record<string, string> = { image_path: stillSource };
  const job: MediaJobFile = {
    schema_version: MEDIA_JOB_SCHEMA_VERSION,
    run_id: folders.runId,
    run_dir: folders.runDir,
    kind: 'video',
    engine: adapterEngineName(engine),
    prompt,
    seconds: secondsValue,
    ...(seed !== undefined ? { seed } : {}),
    cuda_devices: engine.cuda_devices,
    ffmpeg: ffmpegTools.ffmpeg,
    ffprobe: ffmpegTools.ffprobe,
    comfyui: comfy,
    inputs,
    video: videoBlock(size, fpsValue),
  };
  if (engine.kind === 'ltx25') {
    job.models = Object.fromEntries(
      Object.entries(engine.models)
        .filter(([, value]) => typeof value === 'string' && value.trim())
        .map(([name, value]) => [name, absolutePath(value as string, workspaceRoot)]),
    );
  }
  if (engine.kind === 'comfyui_workflow') {
    // H3 takes its explicit UNET and an upstream saved blueprint. Preserve the
    // staged user's still while adding the workflow the adapter needs.
    job.models = { diffusion: absolutePath(engine.models.diffusion, workspaceRoot) };
    job.inputs = {
      ...job.inputs,
      workflow_path: absolutePath(engine.workflow, workspaceRoot),
    };
    // The flag is always passed, including a reserve of 0: ComfyUI picks its
    // own default reserve when it is absent, and that default is not the
    // engine's answer. `reserve_vram_gb: 0` must reach ComfyUI as an explicit
    // `--reserve-vram 0`, so the config decides in both directions.
    comfy.startup_args = [...comfy.startup_args, '--reserve-vram', String(engine.reserve_vram_gb)];
  }
  const jobFile = await writeJobFile(folders.runDir, job);
  const invocation = adapterInvocation(
    deps.adaptersDir,
    media.comfyui.python,
    jobFile,
    folders.runDir,
    engine.cuda_devices,
    { ...(context?.conversationId ? { FORGE_CONVERSATION_ID: context.conversationId } : {}) },
  );
  const deliveryConversationId = context?.conversationId;
  const deliverMediaFile = deps.deliverMediaFile;
  await assertMediaEngineVram(deps, engine, {
    label: `generate_video: engine "${selection.id}"`,
    configKey: `media.video.engines[${selection.index}]`,
    modelPath: engine.models.diffusion,
    nothingRan: 'no video was generated',
    alternativeMessage: 'another configured video engine or a GPU with enough free VRAM',
  });
  const started = await startMediaRender(
    {
      runId: folders.runId,
      runDir: folders.runDir,
      kind: 'video',
      engineId: selection.id,
      cudaDevices: engine.cuda_devices,
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      jobFile,
      env: invocation.env,
      timeoutMs: (COMFYUI_STARTUP_TIMEOUT_SECONDS + COMFYUI_JOB_TIMEOUT_SECONDS) * 1_000,
      ...(context?.conversationId ? { conversationId: context.conversationId } : {}),
      ...(context?.abortSignal ? { abortSignal: context.abortSignal } : {}),
      ...(deliveryConversationId && deliverMediaFile
        ? {
            onFinished: async (completion) => {
              if (completion.status !== 'completed') return;
              const clipPath = path.join(folders.runDir, 'output', 'clip.mp4');
              const workspacePath = workspaceRelativePath(clipPath, workspaceRoot);
              if (!workspacePath) throw new Error('the completed clip is outside the workspace');
              const preview = await prepareTelegramPreview(clipPath, 'video', ffmpegTools.ffmpeg);
              const previewPath = preview
                ? workspaceRelativePath(preview, workspaceRoot)
                : undefined;
              if (preview && !previewPath)
                throw new Error('the video preview is outside the workspace');
              await deliverMediaFile({
                conversationId: deliveryConversationId,
                kind: 'video',
                workspacePath,
                ...(previewPath ? { previewPath } : {}),
                text: 'Forge: video render completed.',
              });
            },
          }
        : {}),
    },
    renderDepsFrom(deps, context),
  );

  const unloaded = started.unloaded.length
    ? started.unloaded.join(', ')
    : 'none: no loaded model overlaps those cards';
  return [
    `generate_video: render started in the background.`,
    `Run id ${folders.runId}, folder ${displayPath(folders.runDir)} (job file ${displayPath(jobFile)}).`,
    `Engine ${selection.id} on GPU ${engine.cuda_devices.join(', ')}: ${secondsValue} s at ` +
      `${size.width}x${size.height}, ${fpsValue} fps${seed !== undefined ? `, seed ${seed}` : ''}.`,
    `Still ${stillNote}; clip output ${displayPath(path.join(folders.runDir, 'output', 'clip.mp4'))} when it finishes.`,
    `Models unloaded to free those cards: ${unloaded}.`,
    ...(engine.kind === 'comfyui_workflow'
      ? [
          'Note: an H3 render needs its configured 16 GB card reserved, so it unloads the chat model; ' +
            'the next turn loads it again.',
        ]
      : []),
    `Execution ${started.executionId}${started.pid ? ` (pid ${started.pid})` : ''}. ` +
      'This chat is woken when it ends, with the run manifest summary; check the clip with view_video.',
  ].join('\n');
}
