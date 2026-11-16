/**
 * Engine selection and the one setup message both media tools report.
 *
 * `src/media/mediaSetupCheck.ts` is the single place the missing-key sentences
 * come from (docs/plans/MEDIA_SHIPPED_PLAN.md §5: "It is the one place the
 * setup messages come from. The tools and the AI setup both call it"), so this
 * module never re-derives a path check: it runs the shared report once, then
 * selects the lines about the engine it resolved and the runtime that engine
 * needs. A refusal that named only "engine not configured" would leave the
 * model guessing which key to fill.
 */
import type {
  MediaConfig,
  MediaMusicEngineConfig,
  MediaVideoEngineConfig,
} from '../../config/mediaSchema';
import {
  checkMediaSetup,
  type MediaSetupCheckOptions,
  type MediaSetupReport,
} from '../../media/mediaSetupCheck';

/** The adapter `media_job.py` dispatches on (`_ENGINE_KIND`), never the config id. */
export function adapterEngineName(engine: MediaVideoEngineConfig | MediaMusicEngineConfig): string {
  switch (engine.kind) {
    case 'ltx25':
      return 'ltx25';
    case 'comfyui_workflow':
      return 'h3';
    case 'ace_standalone':
      return 'ace_step';
    case 'comfyui_sa3':
      return 'stable_audio';
    default:
      return 'flamingo_dlt';
  }
}

/** Whether this engine renders through a ComfyUI it owns, so the comfyui lines apply. */
function usesComfyUi(engine: MediaVideoEngineConfig | MediaMusicEngineConfig): boolean {
  return (
    engine.kind === 'ltx25' || engine.kind === 'comfyui_workflow' || engine.kind === 'comfyui_sa3'
  );
}

export interface MediaVideoSelection {
  id: string;
  index: number;
  engine: MediaVideoEngineConfig;
}

export interface MediaMusicSelection {
  id: string;
  index: number;
  engine: MediaMusicEngineConfig;
}

/**
 * The configured video engine. An explicit `engine` id must name a configured
 * entry; with no `engine` argument the default is the entry whose kind is
 * `ltx25`, by owner decision: LTX-2.5 is the default for every request, and a
 * MiniMax H3 render is only ever asked for by id, because it needs its
 * configured 16 GB card and unloads the chat model. Config order is therefore
 * NOT the default: an H3 entry listed first is still passed over.
 */
export function resolveVideoEngine(
  media: MediaConfig,
  requestedId?: string,
): MediaVideoSelection | undefined {
  if (requestedId) {
    const found = pick(media.video.engines, requestedId);
    return found ? { ...found, engine: media.video.engines[found.index] } : undefined;
  }
  const index = media.video.engines.findIndex((engine) => engine.kind === 'ltx25');
  if (index < 0) return undefined;
  return { id: media.video.engines[index].id, index, engine: media.video.engines[index] };
}

/**
 * Why a default (no `engine`) video request is refused when no LTX-2.5 entry
 * exists: the plan rule that a missing engine names the config key to fill and
 * says what the alternative would need, so the model fixes the config or names
 * the H3 entry instead of guessing.
 */
export function defaultVideoEngineMessage(media: MediaConfig, toolName: string): string {
  const configured = media.video.engines.length
    ? media.video.engines.map((engine) => `${engine.id} (kind ${engine.kind})`).join(', ')
    : 'none';
  const h3Ids = media.video.engines
    .filter((engine) => engine.kind === 'comfyui_workflow')
    .map((engine) => `engine: "${engine.id}"`);
  return [
    `${toolName}: no LTX-2.5 video engine (kind: ltx25) is configured under ` +
      `media.video.engines, and it is the default for every request. Configured: ${configured}.`,
    'Add an LTX-2.5 entry (id, kind: ltx25, models, cuda_devices), then call ' +
      `${toolName} again` +
      (h3Ids.length
        ? `; to render on the H3 entry instead, pass ${h3Ids.join(' or ')} explicitly.`
        : '.'),
  ].join(' ');
}

/** The configured music engine, same rule over the music list. */
export function resolveMusicEngine(
  media: MediaConfig,
  requestedId?: string,
): MediaMusicSelection | undefined {
  const found = pick(media.music.engines, requestedId);
  return found ? { ...found, engine: media.music.engines[found.index] } : undefined;
}

function pick(
  engines: readonly { id: string }[],
  requestedId?: string,
): { id: string; index: number } | undefined {
  if (requestedId) {
    const index = engines.findIndex((engine) => engine.id === requestedId);
    return index < 0 ? undefined : { id: requestedId, index };
  }
  const first = engines[0];
  return first ? { id: first.id, index: 0 } : undefined;
}

/**
 * Run the shared report. `stillBackendNames` is what lets the report say that a
 * `still_backend` naming no configured sd-server model is wrong, rather than
 * silently skipping the text-to-video path.
 */
export function mediaSetupReport(
  media: MediaConfig,
  workspaceRoot: string,
  options: MediaSetupCheckOptions = {},
): MediaSetupReport {
  return checkMediaSetup(media, workspaceRoot, options);
}

/**
 * The lines that decide this engine's readiness: its own per-key results, the
 * runtime it needs (ComfyUI for the ComfyUI engines, ffmpeg/ffprobe for every
 * media job), and its `configured` verdict when there is one. An engine's
 * irrelevant lines are dropped so a Stable Audio refusal cannot tell the model
 * to fix a ComfyUI checkout it never uses.
 */
export function setupLinesFor(
  report: MediaSetupReport,
  kind: 'video' | 'music',
  selection: { id: string; index: number },
  engine: MediaVideoEngineConfig | MediaMusicEngineConfig,
): string[] {
  const prefix = `media.${kind}.engines[${selection.index}]`;
  return report.entries.filter((line) => {
    if (line === `${kind} ${selection.id}: configured`) return true;
    if (line.includes(prefix)) return true;
    if (line.startsWith('media.ffmpeg')) return true;
    // The adapter runner is `media.comfyui.python` for every engine, so its line
    // always applies; the ComfyUI root only for the engines that start one.
    if (line.startsWith('media.comfyui.python')) return true;
    return usesComfyUi(engine) && line.startsWith('media.comfyui');
  });
}

/**
 * The refusal the tool returns: the engine's name, the keys and paths that
 * failed, and what to do next. Never a bare failure — the plan's rule is that
 * a missing engine answers with the config key and the path it checked.
 */
export function setupMessage(
  report: MediaSetupReport,
  kind: 'video' | 'music',
  selection: { id: string; index: number },
  engine: MediaVideoEngineConfig | MediaMusicEngineConfig,
  toolName: string,
): string {
  const lines = setupLinesFor(report, kind, selection, engine);
  return [
    `${toolName}: ${kind} engine "${selection.id}" is not usable yet.`,
    ...lines,
    'Fill those keys in the media: block of config.yaml (or fix the paths above), ' +
      `then call ${toolName} again. Run "Forge: Check Media Setup" for the full report.`,
  ].join('\n');
}

/**
 * Why a routed engine that is not configured is refused with the alternative
 * named: the plan's rule that the setup message says "what the other choice
 * would use", so the model can change the lyrics mode instead of the config.
 */
export function engineNotConfiguredMessage(
  toolName: string,
  routedId: string,
  alternatives: readonly string[],
): string {
  return [
    `${toolName}: no "${routedId}" engine is configured in media: for this route.`,
    ...(alternatives.length
      ? [`Configured alternatives: ${alternatives.join(', ')}.`]
      : ['No engine of that kind is configured at all; add one to media: first.']),
  ].join(' ');
}

/**
 * The adapter runner is `media.comfyui.python` for every engine, including the
 * ones that never start a ComfyUI of their own (ACE-Step spawns its own runtime,
 * but `media_job.py` still needs a Python 3 to run under). `checkMediaSetup`
 * only emits that key's line under a ComfyUI engine, so the tools state it
 * themselves rather than letting the child die with an unexplained spawn error.
 */
export function adapterRunnerMessage(media: MediaConfig, toolName: string): string | undefined {
  return media.comfyui.python.trim()
    ? undefined
    : `${toolName}: media.comfyui.python is empty, and it is the interpreter every ` +
        'shipped adapter runs under. Set it to a Python 3 (the ComfyUI venv works), then ' +
        'call the tool again.';
}
