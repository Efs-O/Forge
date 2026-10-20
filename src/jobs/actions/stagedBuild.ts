import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSync } from '../../util/atomicWrite';

/**
 * The staged metadata for a `llamacpp_update` action (B5). When the action
 * stages a build (downloads, verifies, extracts, smoke-tests it) it writes this
 * file so the switch (stages 7-8) can find the new binary, the binary to
 * restore on post-check failure, and when the staging happened (for the 24 h
 * approval expiry). It lives under the jobs root, in its own `staged/` dir, so
 * it is per-machine state, not a job definition, and a job delete does not
 * sweep it by accident.
 *
 * `switch_pending` is the single flag that drives the switch: the scheduler's
 * idle-tick pass performs the switch for any staged build with this set (and
 * not expired). `prepare` mode sets it only when the owner approves
 * (`/job <n> approve`); `apply` mode sets it immediately after staging.
 */
export interface StagedBuild {
  job_id: string;
  /** The build tag, e.g. `b10991`. */
  tag: string;
  /** Full path to the newly extracted `llama-server.exe`. */
  new_binary: string;
  /** The `llama_server.binary` to restore if the post-check fails. */
  old_binary: string | undefined;
  /** The verified assets (name + digest), for the run log. */
  assets: { name: string; digest: string }[];
  /** Epoch ms the build was staged. */
  staged_at: number;
  /** True when the switch is requested and waiting for an idle tick. */
  switch_pending: boolean;
  mode: 'prepare' | 'apply';
}

/** How long a staged build stays switchable. A `prepare` approval older than
 *  this is discarded; an `apply` switch that could not happen this long is too. */
export const STAGE_TTL_MS = 24 * 60 * 60_000;

/** The `%LOCALAPPDATA%` root the builds and staging live under. Injected in
 *  tests so the action never touches the real machine directories. */
export function forgeLocalRoot(localAppData?: string): string {
  const base =
    localAppData ?? process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Forge');
}

/** The staging dir the downloaded zips land in. */
export function stagingDir(root: string): string {
  return path.join(root, 'staging');
}

/** The build dir a tag extracts into: `llama.cpp-<tag>\`. */
export function buildDirForTag(root: string, tag: string): string {
  return path.join(root, `llama.cpp-${tag}`);
}

/** Full path to a staged build's `llama-server.exe`. */
export function newBinaryPath(root: string, tag: string): string {
  return path.join(buildDirForTag(root, tag), 'llama-server.exe');
}

/** A build folder this pipeline extracts: `llama.cpp-b<N>`. */
const BUILD_DIR_NAME = /^llama\.cpp-b\d+$/u;

/** What `pruneOldBuilds` did, for the caller's user-facing summary. */
export interface PruneResult {
  removed: string[];
  /** Folders that could not be removed, with the reason (a running server holds its exe). */
  failed: string[];
}

/**
 * Delete every `llama.cpp-b<N>` build folder under `root` except the ones
 * holding a binary in `keep`: the build just switched to, the one it
 * replaced (the restore target, which may still be loaded by a running
 * server), and any build a model pins with its own `llama_server_binary`
 * (`modelPinnedBinaries`). Each release is ~700 MB, so without this they pile up.
 *
 * Kept builds are matched by folder name, so a relative or differently cased
 * binary path still protects its build. Only folders named like this
 * pipeline's own are touched — a binary configured anywhere else is never
 * deleted. A folder that cannot be removed is reported, not thrown: by the
 * time this runs the switch has already succeeded.
 */
export function pruneOldBuilds(root: string, keep: readonly (string | undefined)[]): PruneResult {
  const kept = new Set(
    keep
      .filter((binary): binary is string => binary !== undefined && binary !== '')
      .map((binary) => path.basename(path.dirname(binary)).toLowerCase()),
  );
  const result: PruneResult = { removed: [], failed: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !BUILD_DIR_NAME.test(entry.name)) continue;
    if (kept.has(entry.name.toLowerCase())) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      result.removed.push(entry.name);
    } catch (err) {
      result.failed.push(`${entry.name} (${(err as Error).message})`);
    }
  }
  return result;
}

/** The binaries models pin with their own `llama_server_binary`, which a prune must keep. */
export function modelPinnedBinaries(
  models: readonly { llama_server_binary?: string | undefined }[],
): string[] {
  return models.flatMap((m) => (m.llama_server_binary ? [m.llama_server_binary] : []));
}

/** Sentences for a user-facing summary, or '' when nothing was pruned. */
export function describePrune(result: PruneResult): string {
  const parts: string[] = [];
  if (result.removed.length) parts.push(`Removed old builds: ${result.removed.join(', ')}.`);
  if (result.failed.length) parts.push(`Could not remove: ${result.failed.join('; ')}.`);
  return parts.join(' ');
}

/** The staged-metadata file for a job. */
function stagedFile(jobsRoot: string, jobId: string): string {
  return path.join(jobsRoot, 'staged', `${jobId}.json`);
}

/** Read a job's staged build, or undefined when none (or it is malformed). */
export function readStaged(jobsRoot: string, jobId: string): StagedBuild | undefined {
  const full = stagedFile(jobsRoot, jobId);
  let raw: string;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw) as StagedBuild;
  } catch {
    // A corrupt staged file is recoverable: the next stage overwrites it.
    return undefined;
  }
}

/** Write a job's staged build atomically. */
export function writeStaged(jobsRoot: string, staged: StagedBuild): void {
  const full = stagedFile(jobsRoot, staged.job_id);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  writeFileAtomicSync(full, JSON.stringify(staged, null, 2));
}

/** Clear a job's staged build (after a successful switch or an expiry). */
export function clearStaged(jobsRoot: string, jobId: string): void {
  try {
    fs.unlinkSync(stagedFile(jobsRoot, jobId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** True when a staged build is older than the TTL (its approval has expired). */
export function isStale(staged: StagedBuild, now: number): boolean {
  return now - staged.staged_at > STAGE_TTL_MS;
}
