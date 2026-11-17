/**
 * The laptop side of a remote media job's paths
 * (docs/plans/LAPTOP_REMOTE_MEDIA_PLAN.md phase 2, criteria 7 and 8).
 *
 * Everything here is the boundary between this machine's files and a desktop
 * that cannot see them: which arguments are files, what they are called on the
 * wire, what a rendered file may overwrite here, and where it lands. It lives
 * apart from the tool registration because it is the half that can destroy the
 * owner's work — a reference image replaced by the render that read it — and a
 * refusal the laptop raises costs nothing, while the same one on the desktop
 * costs a finished render.
 *
 * Two rules the desktop cannot enforce for us:
 *
 * - **One name is one file.** The desktop keys the inputs it receives by name,
 *   so `a/x.png` and `b/x.png` would both arrive as `x.png`, collapse into one
 *   file, and cost the model a reference it asked for without saying so. Names
 *   are made unique per job instead: `x.png`, `x-2.png`, `x-3.png`.
 * - **An edit never overwrites its source.** The desktop's own tool refuses an
 *   output that is one of its references (A22 in `generateImageTool.ts`), but it
 *   cannot see that collision over the relay: there the reference is a bare name
 *   in `inputs[]` and the output is a path in the laptop's workspace, and only
 *   this laptop knows they are the same file.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  REMOTE_MEDIA_PATH_ARGS,
  REMOTE_MEDIA_TEXT,
  type RemoteMediaTool,
} from '../../media/remoteMediaContract';
import { outputCollidesWithReference } from '../imageGeneration/generateImageToolLocal';

/** Where a `generate_image` with no `path` argument lands: the same folder the
 *  desktop's own tool uses for an omitted path. */
export const DEFAULT_IMAGE_DIR = 'generated-images';

/** Room for the job's own JSON (arguments, client, names) around the base64. */
const BODY_HEADER_BUDGET_BYTES = 8 * 1024;

/** One file argument the handler has to move across the wire. */
export interface PreparedInput {
  arg: string;
  /** The bare name the desktop sees; the laptop path never crosses. */
  name: string;
  /** The laptop path, for the destination of an upscale and for the refusals. */
  sourcePath: string;
  bytes: number;
}

/** What the laptop may send, once every file argument has been read and named. */
export interface PreparedJob {
  /** The arguments, with each input path replaced by the name it travels as. */
  sent: Record<string, unknown>;
  inputs: PreparedInput[];
  /** The output path the model asked for, when it asked for one. */
  askedPath?: string;
  /** The first input's laptop path: where an upscaled result belongs. */
  inputPath?: string;
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

/** A bare upload name no other input in this job has taken: `x.png`, then
 *  `x-2.png`, then `x-3.png`, extension kept. */
function uniqueUploadName(used: Set<string>, wanted: string): string {
  const extension = path.extname(wanted);
  const stem = wanted.slice(0, wanted.length - extension.length);
  let candidate = wanted;
  // Compared case-insensitively: the desktop that receives them is Windows, where
  // two names differing only in case are the same file.
  for (let index = 2; used.has(candidate.toLowerCase()); index += 1) {
    candidate = `${stem}-${index}${extension}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/** The laptop file behind one input argument, and what it would cost to send. */
async function prepareInput(
  name: RemoteMediaTool,
  arg: string,
  value: string,
  root: string,
  usedUploadNames: Set<string>,
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
  return {
    arg,
    name: uniqueUploadName(usedUploadNames, path.basename(absolute)),
    sourcePath: absolute,
    bytes: info.size,
  };
}

/**
 * Read every file argument out of this workspace and get it ready to send, or
 * refuse. Everything here happens before the request is made: a refusal the
 * desktop raises instead costs the owner a render they paid for and threw away.
 */
export async function prepareJobInputs(
  name: RemoteMediaTool,
  args: Record<string, unknown>,
  root: string,
  maxBodyBytes: number,
): Promise<PreparedJob> {
  const sent: Record<string, unknown> = { ...args };
  const inputs: PreparedInput[] = [];
  const usedUploadNames = new Set<string>();
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
      const prepared = await prepareInput(name, arg, item, root, usedUploadNames);
      inputPath = inputPath ?? prepared.sourcePath;
      uploaded.push(prepared.name);
      inputs.push(prepared);
    }
    if (values.length && !uploaded.length) {
      throw new Error(`${name}: ${REMOTE_MEDIA_TEXT.pathRefused(arg)}`);
    }
    sent[arg] = direction === 'input-list' ? uploaded : (uploaded[0] ?? value);
  }

  // The desktop's A22 rule, enforced here because the desktop cannot see it: an
  // edit must never write over the picture it reads. The probe is the asked path
  // itself — `destinationFor` writes into its folder, and the desktop has not
  // named the file yet — so this is the closest thing to the real destination
  // that exists before the request. Compared the way the local tool compares, on
  // the extension-stripped path, because the extension is the desktop's choice.
  if (askedPath && inputs.length) {
    const collides = outputCollidesWithReference(
      path.resolve(root, askedPath),
      inputs.map((input) => input.sourcePath),
    );
    if (collides) {
      throw new Error(
        `${name}: path "${askedPath}" is one of the reference images; choose another output name.`,
      );
    }
  }

  const budget = maxBodyBytes - BODY_HEADER_BUDGET_BYTES;
  const encodedBytes = inputs.reduce((total, input) => total + Math.ceil(input.bytes / 3) * 4, 0);
  if (encodedBytes > budget) {
    const names = inputs.map((input) => `"${input.sourcePath}" (${mb(input.bytes)} MB)`).join(', ');
    throw new Error(
      `${name}: the desktop accepts a request body up to ${mb(maxBodyBytes)} MB, and ` +
        `${inputs.length === 1 ? 'this input is' : `${inputs.length} inputs are`} ${mb(encodedBytes)} MB once encoded: ${names}. ` +
        'Nothing was sent: shrink the input, or send it to the desktop another way.',
    );
  }

  return {
    sent,
    inputs,
    ...(askedPath ? { askedPath } : {}),
    ...(inputPath ? { inputPath } : {}),
  };
}

/** Where one rendered file lands on this laptop. */
export function destinationFor(
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

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.normalize(root), path.normalize(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
