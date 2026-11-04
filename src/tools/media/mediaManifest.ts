/**
 * What a finished media run says about itself.
 *
 * The adapter writes `manifest.json` atomically LAST, after validation and after
 * its own ComfyUI has stopped, so its presence is the run's completion proof
 * (docs/plans/MEDIA_SHIPPED_PLAN.md, ledger row "`manifest.json`"). The background
 * exit notice carries that summary; a run that died without one says so and
 * falls back to the tail of the adapter's own log, which is the only evidence
 * left. Never a guess: an absent manifest is reported as absent.
 *
 * A multi-stage run has two manifests, so `archiveAnalysisManifest` renames the
 * earlier stage's aside before the next stage starts: `manifest.json` must mean
 * the FINAL stage's own when the notice is computed, or a run whose render died
 * would report the analysis stage's "completed".
 */
import * as fs from 'fs/promises';
import * as path from 'path';

const LOG_TAIL_CHARS = 1_200;
const MANIFEST_NAME = 'manifest.json';
/**
 * What an earlier stage's manifest is renamed to, so the run folder keeps the
 * analysis record while `manifest.json` stays the final stage's own (the plan's
 * ledger row for `manifest.json`, docs/plans/MEDIA_SHIPPED_PLAN.md).
 */
const ANALYSIS_MANIFEST_NAME = 'analysis-manifest.json';

export interface MediaManifest {
  run_id?: string;
  kind?: string;
  engine?: string;
  status?: string;
  outputs?: { path?: string; duration_seconds?: number; silence?: { result?: string } }[];
  artifacts?: string[];
  warnings?: string[];
  tool_reports?: string[];
}

export interface MediaOutcomeNotice {
  /** Only true when a complete manifest says the run completed. */
  completed: boolean;
  /** The lines the notice carries. */
  lines: string[];
}

async function readManifest(runDir: string): Promise<MediaManifest | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(runDir, MANIFEST_NAME), 'utf8');
  } catch {
    // Absent, unreadable, or a directory: all mean "no manifest to report".
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as MediaManifest)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Move a finished stage's `manifest.json` aside as `analysis-manifest.json`
 * before the next stage is spawned. Nothing to move is not an error: a stage
 * that wrote no manifest left nothing behind, and the final notice then reports
 * "ended without a manifest" for that run as well. A rename that fails is
 * logged, because the notice could otherwise read the earlier stage's verdict.
 */
export async function archiveAnalysisManifest(
  runDir: string,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    await fs.rename(path.join(runDir, MANIFEST_NAME), path.join(runDir, ANALYSIS_MANIFEST_NAME));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    log(
      `[media] The manifest of "${runDir}" could not be moved aside to ` +
        `${ANALYSIS_MANIFEST_NAME}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        'The next stage was not started, so the final notice cannot read an earlier stage verdict.',
    );
    return false;
  }
}

/** The newest line-count of the adapter's own logs, for a run with no manifest. */
async function logTail(runDir: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(runDir, 'logs'));
  } catch {
    return undefined;
  }
  let newest: { name: string; mtimeMs: number } | undefined;
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    const full = path.join(runDir, 'logs', name);
    const stat = await fs.stat(full).catch(() => undefined);
    if (!stat || !stat.isFile()) continue;
    if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: stat.mtimeMs };
  }
  if (!newest) return undefined;
  const full = path.join(runDir, 'logs', newest.name);
  const handle = await fs.open(full, 'r').catch(() => undefined);
  if (!handle) return undefined;
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, LOG_TAIL_CHARS));
    const { bytesRead } = await handle.read(
      buffer,
      0,
      buffer.length,
      Math.max(0, size - buffer.length),
    );
    const text = buffer.subarray(0, bytesRead).toString('utf8').trim();
    return text ? `${newest.name}: ${text}` : undefined;
  } finally {
    await handle.close();
  }
}

function manifestLines(manifest: MediaManifest): string[] {
  const outputs = (manifest.outputs ?? []).map((output) => {
    const duration =
      typeof output.duration_seconds === 'number'
        ? `${output.duration_seconds}s`
        : 'duration unknown';
    const silence = output.silence?.result ? `, ${output.silence.result}` : '';
    return `- ${output.path ?? 'unnamed output'} (${duration}${silence})`;
  });
  return [
    `Media run ${manifest.run_id ?? 'unknown'}: ${manifest.status ?? 'unknown'} (${manifest.engine ?? 'unknown'} engine).`,
    ...(outputs.length ? outputs : ['- the manifest listed no output files']),
    ...(manifest.warnings?.length ? [`Manifest warnings: ${manifest.warnings.join(' ')}`] : []),
    ...(manifest.tool_reports ?? []),
  ];
}

/** What the tool itself reported about this run (an engine-limit trim, say). */
async function readRunNotes(runDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(runDir, 'render-notes.txt'), 'utf8');
    return raw
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Decide the notice from the run folder alone. The manifest is the only thing
 * that can call a run completed: a child that exited 0 without one still
 * failed, and the plan says the notice then names the missing manifest and
 * hands over the log tail.
 */
export async function mediaOutcomeNotice(runDir: string): Promise<MediaOutcomeNotice> {
  const manifest = await readManifest(runDir);
  const notes = await readRunNotes(runDir);
  if (manifest && manifest.status === 'completed') {
    const reported = new Set(manifest.tool_reports ?? []);
    return {
      completed: true,
      lines: [...manifestLines(manifest), ...notes.filter((line) => !reported.has(line))],
    };
  }
  if (manifest) {
    return {
      completed: false,
      lines: [
        `Media run ${manifest.run_id ?? 'unknown'} ended without completing: the manifest says ` +
          `"${manifest.status ?? 'no status'}".`,
      ],
    };
  }
  const tail = await logTail(runDir);
  return {
    completed: false,
    lines: [
      `Media run ended without a manifest in "${runDir}", so its outputs are unverified; ` +
        `an earlier stage manifest is kept as "${ANALYSIS_MANIFEST_NAME}" if one was written.`,
      ...(tail ? [tail] : ['No adapter log was written either.']),
      ...notes,
    ],
  };
}
