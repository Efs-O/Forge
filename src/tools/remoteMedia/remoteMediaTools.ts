/**
 * The laptop's `generate_image` and `upscale_image`, aimed at the desktop
 * (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md phase 2).
 *
 * These are not copies of the desktop tools. The desktop builds each job from
 * its own factory and hands the laptop the resulting **definition** in
 * capabilities `tools[]`, so the argument schema this laptop shows its model has
 * exactly one owner: the desktop tool that runs the job. A desktop upgrade that
 * adds an argument reaches the laptop's model with no laptop edit and no second
 * schema to keep in sync.
 *
 * What lives here, and why it has to be here:
 *
 * - **The capabilities cache is memory-only.** A stale cache would advertise a
 *   tool the desktop stopped serving, and the cost of getting it wrong is a GPU
 *   render the owner did not ask for. It is filled on activation and re-read
 *   whenever the config's relay changes; `enabled: false` clears it.
 * - **Inputs are read on this laptop and uploaded by name**
 *   (`remoteMediaInputs.ts`). The desktop never sees a laptop path: it gets bare
 *   file names in `inputs[]`, and the same bare names in the arguments, so a
 *   desktop workspace path can never be invented from the laptop side (and vice
 *   versa, which is what criterion 8 tests). The names are made unique per job,
 *   and an output that would overwrite one of its own references is refused
 *   before the job is sent: those two are collisions only this laptop can see.
 * - **The saved file is the laptop's.** Every destination goes through
 *   `beforeMutate`, so Keep/Undo covers a desktop render exactly as it covers a
 *   local one.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  type RemoteMediaCapabilities,
  type RemoteMediaJobRequest,
  type RemoteMediaTool,
} from '../../media/remoteMediaContract';
import { REMOTE_MEDIA_GROUP } from '../../config/remoteMediaSchema';
import { namesToLaptopPaths } from '../../media/remoteMediaResultText';
import { destinationFor, isInside, prepareJobInputs } from './remoteMediaInputs';
import type { ForgeConfig } from '../../config/types';
import { defaultWorkspaceRoot } from '../../util/WorkspacePaths';
import { getLogger } from '../../util/logger';
import type { RegisteredTool, ToolHandlerContext } from '../ToolRegistry';
import {
  CAPABILITIES_TIMEOUT_MS,
  RemoteMediaRefusedError,
  RemoteMediaUnreachableError,
  cancelJob,
  downloadFile,
  fetchCapabilities,
  pollJob,
  submitJob,
  type RemoteMediaInput,
} from './remoteMediaClient';

const log = getLogger();

/** Re-read the desktop at most this often when it is not answering, so a asleep
 *  machine is not dialed once per model turn. */
const RETRY_AFTER_MS = 60_000;

export interface RemoteMediaToolDeps {
  getConfig: () => ForgeConfig;
  /** Test seam: the fetch behind every desktop read. */
  fetchImpl?: typeof fetch;
  /** Test seam: the workspace the saved files land in. */
  workspaceRoot?: () => string | undefined;
  /** Test seam: the poll cadence, so a test watches several states in no time. */
  poll?: { fastMs?: number; slowMs?: number; windowMs?: number };
  /** Test seam for the clock the cadence and the retry window read. */
  now?: () => number;
}

export interface RemoteMediaToolBundle {
  /** The two remote variants, ready to register. Their `advertise` predicate is
   *  what keeps them out of the model's list until the desktop answers. */
  tools: RegisteredTool[];
  /** Ask the desktop what it serves. Safe to call from activation and from a
   *  config reload; it never rejects. */
  refresh: () => Promise<void>;
  /** The live cache, for tests and for the check command. */
  capabilities: () => RemoteMediaCapabilities | undefined;
}

/** The relay this laptop asks: the origin of the desktop-relay group's endpoint,
 *  which is the one address the config already dials for cloud models. */
export function remoteMediaOrigin(config: ForgeConfig): string | undefined {
  const endpoint = config.groups?.[REMOTE_MEDIA_GROUP]?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) return undefined;
  try {
    return new URL(endpoint).origin;
  } catch {
    return undefined;
  }
}

/** True when the remote variants should be registered at all: the switch is on
 *  and this machine renders no images of its own. */
export function remoteMediaActiveFor(config: ForgeConfig): boolean {
  return config.remote_media?.enabled === true && config.image_generation === undefined;
}

const PHASE2_TOOLS: readonly RemoteMediaTool[] = ['generate_image', 'upscale_image'];

/** One tool name's definition out of a capabilities answer. */
function definitionFor(
  caps: RemoteMediaCapabilities | undefined,
  name: RemoteMediaTool,
): RemoteMediaCapabilities['tools'][number] | undefined {
  return caps?.tools.find((entry) => entry.function.name === name);
}

export function makeRemoteMediaTools(deps: RemoteMediaToolDeps): RemoteMediaToolBundle {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let cache: RemoteMediaCapabilities | undefined;
  /** The config shape this cache was fetched for, and when it was last asked. */
  let askedFor: string | undefined;
  let askedAt = 0;
  let inFlight: Promise<void> | undefined;

  /** `enabled` plus the relay origin: the two config facts a cache belongs to. */
  const signature = (): string => {
    const config = deps.getConfig();
    return `${config.remote_media?.enabled === true}|${remoteMediaOrigin(config) ?? ''}`;
  };

  const refresh = async (): Promise<void> => {
    const config = deps.getConfig();
    const origin = config.remote_media?.enabled === true ? remoteMediaOrigin(config) : undefined;
    askedFor = signature();
    askedAt = now();
    if (!origin) {
      cache = undefined;
      return;
    }
    try {
      const caps = await fetchCapabilities(fetchImpl, origin, {
        timeoutMs: CAPABILITIES_TIMEOUT_MS,
      });
      cache = caps;
      log.info(
        `[RemoteMedia] ${origin} serves ${caps.tools.map((t) => t.function.name).join(', ')}` +
          `${caps.refused.length ? `; refuses ${caps.refused.map((r) => `${r.name} (${r.reason})`).join(', ')}` : ''}`,
      );
    } catch (error) {
      cache = undefined;
      log.info(`[RemoteMedia] ${origin} capabilities: ${String(error)}`);
    }
  };

  /** The cache is behind the config (a reload, or a desktop the owner just
   *  switched tailnets on): re-read it in the background, throttled so an asleep
   *  desktop is not dialed once per model turn. */
  const refreshIfStale = (): void => {
    if (inFlight) return;
    const want = signature();
    if (askedFor === want && now() - askedAt < RETRY_AFTER_MS) return;
    inFlight = refresh().finally(() => {
      inFlight = undefined;
    });
  };

  const advertised = (name: RemoteMediaTool): boolean => {
    refreshIfStale();
    // The switch is read live, so `enabled: false` in a reloaded config hides the
    // tool on the same turn the cache is cleared, rather than a turn later.
    if (deps.getConfig().remote_media?.enabled !== true) return false;
    return definitionFor(cache, name) !== undefined;
  };

  const toolFor = (name: RemoteMediaTool): RegisteredTool => {
    // The canonical literal stays a literal for `tool-audit-catalog.mjs`; the
    // schema the model actually sees is the desktop's, from `describe()` below.
    const definition = {
      type: 'function' as const,
      function: {
        name,
        description:
          'Runs on the desktop connected by groups.desktop-relay; its real argument schema comes from the desktop.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    };
    return {
      definition,
      permission: 'fetch',
      additionalPermissions: ['write'],
      // The output name is only known once the desktop says what it rendered, so
      // the handler snapshots through `beforeMutate`, exactly as the desktop tool's does.
      mutation: { paths: () => [], showDiff: false },
      advertise: () => advertised(name),
      describe: () => definitionFor(cache, name) ?? definition,
      ...(name === 'generate_image'
        ? { approval: (args: Record<string, unknown>) => approvalForGenerate(cache, args) }
        : {}),
      handler: (args: Record<string, unknown>, context?: ToolHandlerContext) =>
        runRemoteMediaJob(deps, fetchImpl, name, cache, args, context),
    };
  };

  return {
    tools: PHASE2_TOOLS.map(toolFor),
    refresh: async () => {
      await refresh();
    },
    capabilities: () => cache,
  };
}

/** The laptop's approval card, built from what the desktop says about the
 *  backend: the same `confirm_each` rule and the same cost text the desktop's own
 *  tool would show, so "Allow for this chat" means the same thing on both ends. */
function approvalForGenerate(
  caps: RemoteMediaCapabilities | undefined,
  args: Record<string, unknown>,
): { dangerous: boolean; detail: string } | undefined {
  const image = caps?.image;
  if (!image) return undefined;
  const requested = typeof args['backend'] === 'string' ? args['backend'].trim() : '';
  const name = requested || image.default || '';
  if (!name) return undefined;
  const backend = image.backends.find((entry) => entry.name === name);
  if (!backend || (!backend.paid && !backend.confirm_each)) return undefined;
  const prompt = typeof args['prompt'] === 'string' ? args['prompt'] : '';
  return {
    dangerous: true,
    detail:
      `${backend.name} (${backend.cost ?? 'the desktop gave no cost tag'}) — rendered on the desktop` +
      `${prompt ? `\n\n${prompt.slice(0, 600)}` : ''}`,
  };
}

/**
 * Where one of this job's files is on this laptop, spelled the way prose reads:
 * relative to the workspace, with forward slashes. A `\` in a model-facing
 * string reads like an escape, and the path the model passes back has to be one
 * the laptop's own tools accept.
 */
function laptopPath(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

async function runRemoteMediaJob(
  deps: RemoteMediaToolDeps,
  fetchImpl: typeof fetch,
  name: RemoteMediaTool,
  caps: RemoteMediaCapabilities | undefined,
  args: Record<string, unknown>,
  context: ToolHandlerContext | undefined,
): Promise<string> {
  const config = deps.getConfig();
  const origin = remoteMediaOrigin(config);
  if (!origin) {
    throw new Error(
      `${name}: no desktop relay to ask. Set groups.${REMOTE_MEDIA_GROUP}.endpoint in config.yaml, or run "Forge: Connect to my desktop".`,
    );
  }
  if (!caps) {
    throw new Error(
      `${name}: the desktop has not answered its media capabilities yet. Run "Forge: Check connection to my desktop".`,
    );
  }
  const root = deps.workspaceRoot?.() ?? defaultWorkspaceRoot();
  if (!root) {
    throw new Error(`${name}: no workspace folder open, so there is nowhere to save the result.`);
  }
  // Everything the laptop reads from its own workspace, before the desktop is
  // asked: the names it sends them under, and the refusals that cost a request
  // nothing (`remoteMediaInputs.ts`).
  const { sent, inputs, askedPath, inputPath } = await prepareJobInputs(
    name,
    args,
    root,
    caps.max_body_bytes,
  );

  const request: RemoteMediaJobRequest = {
    tool: name,
    args: sent,
    client: 'forge-laptop',
    ...(inputs.length
      ? {
          inputs: await Promise.all(
            inputs.map(async (input): Promise<RemoteMediaInput> => {
              const bytes = await fs.readFile(input.sourcePath);
              return { arg: input.arg, name: input.name, base64: bytes.toString('base64') };
            }),
          ),
        }
      : {}),
  };

  const signal = context?.abortSignal;
  let id: string;
  try {
    id = await submitJob(fetchImpl, origin, request, { ...(signal ? { signal } : {}) });
  } catch (error) {
    return surface(error);
  }
  let status: Awaited<ReturnType<typeof pollJob>>;
  try {
    status = await pollJob({
      fetchImpl,
      origin,
      id,
      ...(signal ? { signal } : {}),
      ...(deps.poll ? { poll: deps.poll } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      onProgress: (progress) => log.info(`[RemoteMedia] ${name} ${id}: ${progress}`),
    });
  } catch (error) {
    if (signal?.aborted) {
      await cancelJob(fetchImpl, origin, id);
      return `${name}: cancelled. The desktop was asked to stop.`;
    }
    return surface(error);
  }
  if (status.state === 'failed') {
    return status.error ?? `${name}: the desktop stopped without saying why.`;
  }

  const files = status.files ?? [];
  // The names the desktop uses for this job's files, mapped to where they are
  // here. The desktop's own text says `cat.png`; the model on this laptop can
  // only open a file it can find. Inputs go in first and the rendered files
  // over them, so a name that is both points at what the job just wrote.
  const laptopNames: Record<string, string> = {};
  for (const input of inputs) laptopNames[input.name] = laptopPath(root, input.sourcePath);
  if (!files.length) {
    return namesToLaptopPaths(
      status.result ?? `${name}: the desktop reported the job done and listed no files.`,
      laptopNames,
    );
  }
  const saved: string[] = [];
  for (const file of files) {
    const relative = destinationFor(name, file.name, askedPath, inputPath);
    const absolute = path.resolve(root, relative);
    if (!isInside(root, absolute)) {
      throw new Error(
        `${name}: the desktop named "${file.name}", which would leave this workspace. Nothing was written.`,
      );
    }
    context?.beforeMutate([absolute]);
    try {
      await downloadFile(fetchImpl, origin, id, file.name, absolute, {
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) {
        await cancelJob(fetchImpl, origin, id);
        return `${name}: cancelled while saving ${file.name}.`;
      }
      return surface(error);
    }
    const here = laptopPath(root, absolute);
    saved.push(here);
    laptopNames[file.name] = here;
  }
  const text = namesToLaptopPaths(
    status.result ?? `${name}: rendered on the desktop.`,
    laptopNames,
  );
  return `${text}\nSaved on this laptop: ${saved.join(', ')}`;
}

/** What the model gets back for a desktop that refused or did not answer: the
 *  desktop's own words, whole. A throw would add Forge's error wrapper to a
 *  message the owner has to read as written. */
function surface(error: unknown): string {
  if (error instanceof RemoteMediaUnreachableError || error instanceof RemoteMediaRefusedError) {
    return error.message;
  }
  throw error;
}
