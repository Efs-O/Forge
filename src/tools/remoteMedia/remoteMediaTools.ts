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
 * - **Inputs are read here and uploaded by name.** The desktop never sees a
 *   laptop path: it gets bare file names in `inputs[]`, and the same bare names
 *   in the arguments, so a desktop workspace path can never be invented from the
 *   laptop side (and vice versa, which is what criterion 8 tests).
 * - **The saved file is the laptop's.** Every destination goes through
 *   `beforeMutate`, so Keep/Undo covers a desktop render exactly as it covers a
 *   local one.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  REMOTE_MEDIA_PATH_ARGS,
  REMOTE_MEDIA_TEXT,
  type RemoteMediaCapabilities,
  type RemoteMediaJobRequest,
  type RemoteMediaTool,
} from '../../media/remoteMediaContract';
import { REMOTE_MEDIA_GROUP } from '../../config/remoteMediaSchema';
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

/** Where a `generate_image` with no `path` argument lands: the same folder the
 *  desktop's own tool uses for an omitted path. */
const DEFAULT_IMAGE_DIR = 'generated-images';

/** Re-read the desktop at most this often when it is not answering, so a asleep
 *  machine is not dialed once per model turn. */
const RETRY_AFTER_MS = 60_000;
/** Room for the job's own JSON (arguments, client, names) around the base64. */
const BODY_HEADER_BUDGET_BYTES = 8 * 1024;

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

/** One file argument the handler has to move across the wire. */
interface PreparedInput {
  arg: string;
  /** The bare name the desktop sees; the laptop path never crosses. */
  name: string;
  /** The laptop path, for the destination of an upscale. */
  sourcePath: string;
  bytes: number;
}

/** A path argument that is not a plain relative path inside the job's `out/`. */
function isPlainRelativePath(value: string): boolean {
  if (!value.trim()) return false;
  if (
    path.isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\')
  ) {
    return false;
  }
  return !value.split(/[\\/]/).includes('..');
}

/** The MB a byte count is worth, the way the refusal has to say it. */
function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** Where one rendered file lands on this laptop. */
function destinationFor(
  name: RemoteMediaTool,
  fileName: string,
  askedPath: string | undefined,
  inputPath: string | undefined,
): string {
  if (name === 'upscale_image') {
    // Beside the input, the desktop's own rule: `photos/cat.png` → `photos/cat_x4.png`.
    return path.join(path.dirname(inputPath ?? '.'), fileName);
  }
  if (askedPath) return path.join(path.dirname(askedPath), fileName);
  return path.join(DEFAULT_IMAGE_DIR, fileName);
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
  const sent: Record<string, unknown> = { ...args };
  const inputs: PreparedInput[] = [];
  let askedPath: string | undefined;
  let inputPath: string | undefined;

  for (const [arg, direction] of Object.entries(REMOTE_MEDIA_PATH_ARGS[name])) {
    const value = args[arg];
    if (value === undefined) continue;
    if (direction === 'output') {
      if (typeof value !== 'string' || !isPlainRelativePath(value)) {
        throw new Error(`${name}: ${REMOTE_MEDIA_TEXT.outputRefused(arg)}`);
      }
      askedPath = value;
      continue;
    }
    const values =
      direction === 'input-list'
        ? Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : []
        : typeof value === 'string'
          ? [value]
          : [];
    const uploaded: string[] = [];
    for (const item of values) {
      const prepared = await prepareInput(name, arg, item, root);
      inputPath = inputPath ?? prepared.sourcePath;
      uploaded.push(prepared.name);
      inputs.push(prepared);
    }
    if (values.length && !uploaded.length) {
      throw new Error(`${name}: ${REMOTE_MEDIA_TEXT.pathRefused(arg)}`);
    }
    sent[arg] = direction === 'input-list' ? uploaded : (uploaded[0] ?? value);
  }

  const budget = caps.max_body_bytes - BODY_HEADER_BUDGET_BYTES;
  const encodedBytes = inputs.reduce((total, input) => total + Math.ceil(input.bytes / 3) * 4, 0);
  if (encodedBytes > budget) {
    const names = inputs.map((input) => `"${input.sourcePath}" (${mb(input.bytes)} MB)`).join(', ');
    throw new Error(
      `${name}: the desktop accepts a request body up to ${mb(caps.max_body_bytes)} MB, and ` +
        `${inputs.length === 1 ? 'this input is' : `${inputs.length} inputs are`} ${mb(encodedBytes)} MB once encoded: ${names}. ` +
        'Nothing was sent: shrink the input, or send it to the desktop another way.',
    );
  }

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
  if (!files.length) {
    return status.result ?? `${name}: the desktop reported the job done and listed no files.`;
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
    saved.push(path.relative(root, absolute));
  }
  const text = status.result ?? `${name}: rendered on the desktop.`;
  return `${text}\nSaved on this laptop: ${saved.join(', ')}`;
}

/** The laptop file behind one input argument, and what it would cost to send. */
async function prepareInput(
  name: RemoteMediaTool,
  arg: string,
  value: string,
  root: string,
): Promise<PreparedInput> {
  const absolute = path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
  if (!isInside(root, absolute)) {
    throw new Error(
      `${name}: ${arg}="${value}" is outside this workspace, so it cannot be uploaded to the desktop.`,
    );
  }
  const info = await fs.stat(absolute).catch(() => undefined);
  if (!info?.isFile()) {
    throw new Error(`${name}: ${arg}="${value}" is not a file in this workspace.`);
  }
  return { arg, name: path.basename(absolute), sourcePath: absolute, bytes: info.size };
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.normalize(root), path.normalize(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
