/**
 * The run folder and the adapter invocation every media job shares.
 *
 * Runs land in `<media.output_dir>/<kind>/<run-id>/` inside the workspace
 * (docs/plans/MEDIA_SHIPPED_PLAN.md §3), and Forge never deletes one: its
 * outputs are the user's. The job file and the manifest are the run's own
 * forensics, so a later phase that wants to replay a render needs nothing but
 * the folder.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { writeFileAtomic } from '../../util/atomicWrite';
import { randomBytes } from 'crypto';
import { displayPath } from '../imageGeneration/generateImageToolFormat';

/** The adapter's own run-id rule (`media_job._RUN_ID`). */
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export interface MediaRunFolders {
  runId: string;
  runDir: string;
  inputDir: string;
  outputDir: string;
}

export function newRunId(now = Date.now()): string {
  return `m${now.toString(36)}-${randomBytes(3).toString('hex')}`;
}

/**
 * Create the run folder and the sub-folders the adapters insist on: ComfyUI's
 * `temp_dir` and `user_dir` must be inside the run (`media_comfy.start_owned_comfyui`
 * refuses otherwise), and `logs` is where the adapter's own evidence lands.
 */
export async function prepareRunFolders(
  media: { output_dir: string },
  kind: 'video' | 'music',
  workspaceRoot: string,
  runId = newRunId(),
): Promise<MediaRunFolders> {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`media: run id "${runId}" is not one the adapter will accept.`);
  }
  // path.resolve honours an absolute output_dir and resolves a relative one
  // against the workspace, the same rule mediaJobFile.absolutePath applies to every
  // other configured path.
  const runDir = path.resolve(workspaceRoot, media.output_dir, kind, runId);
  const folders: MediaRunFolders = {
    runId,
    runDir,
    inputDir: path.join(runDir, 'input'),
    outputDir: path.join(runDir, 'output'),
  };
  await fs.mkdir(path.join(runDir, 'temp'), { recursive: true });
  await fs.mkdir(folders.inputDir, { recursive: true });
  await fs.mkdir(folders.outputDir, { recursive: true });
  await fs.mkdir(path.join(runDir, 'user'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'logs'), { recursive: true });
  return folders;
}

/**
 * How the shipped adapter is started: one Python, one job file, no shell.
 * `media.comfyui.python` is the only configured interpreter, and
 * `media_job.require_cuda_environment` refuses the job unless the device mask
 * was set before Python started, so the mask travels in the child's env.
 */
export function adapterInvocation(
  adaptersDir: string,
  python: string,
  jobFile: string,
  runDir: string,
  cudaDevices: readonly number[],
  extraEnv: NodeJS.ProcessEnv = {},
): {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
} {
  return {
    command: python,
    args: [path.join(adaptersDir, 'media_job.py'), jobFile],
    cwd: runDir,
    env: {
      CUDA_VISIBLE_DEVICES: cudaDevices.join(','),
      CUDA_DEVICE_ORDER: 'PCI_BUS_ID',
      ...extraEnv,
    },
  };
}

/** The workspace-relative path a user of the tool can act on. */
export function runDisplayPath(runDir: string, workspaceRoot: string): string {
  return displayPath(runDir) || runDir.replace(`${workspaceRoot}${path.sep}`, '');
}

/**
 * Notes the tool itself produced for a run — an engine-limit trim, a lyric
 * source, or a sentence removed for SA3. The final job also carries these in
 * `tool_reports`; the exit notice keeps the text available if the adapter did
 * not write a manifest.
 */
export async function writeRunNotes(runDir: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  await writeFileAtomic(path.join(runDir, 'render-notes.txt'), `${lines.join('\n')}\n`);
}

/** A quiet file check: a path that cannot be stat'd is simply not a file. */
export async function isFileQuiet(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}
