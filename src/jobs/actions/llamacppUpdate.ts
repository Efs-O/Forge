import * as fs from 'fs';
import * as path from 'path';
import type { Action } from '../jobSchema';
import {
  installLlamacppBuild,
  type InstalledBuild,
  type LlamacppInstallEnv,
} from './llamacppInstall';
import { clearStaged, isStale, readStaged, writeStaged, type StagedBuild } from './stagedBuild';

/**
 * The `llamacpp_update` action (B5) — the only mutating job action. Fixed
 * stages, no model-authored steps:
 *
 *   2. Download the tag's `llama-b<tag>` + `cudart-llama-b<tag>` zips (gated).
 *   3. Verify each against the release API digest; no digest or a mismatch
 *      stops before anything is written.
 *   4. Extract both into `llama.cpp-<tag>\`; if that folder exists, stop.
 *   5. Smoke test: `--version` reports the tag, `--list-devices` runs, and (when
 *      embeddings are configured) one embedding round-trip on a free port.
 *   6. `prepare` stops here and asks for approval (24 h expiry). `apply` skips
 *      the gate (decided 2026-09-14) and requests the switch immediately.
 *   7. Switch: write only `llama_server.binary` (comments preserved), restart
 *      the backend only when no turn is streaming, else defer to the next idle
 *      tick.
 *   8. Post-check the backend; on failure restore the previous binary, restart,
 *      and report.
 *
 * Stages 2-5 are `installLlamacppBuild` (llamacppInstall.ts, shared with the
 * `install_llamacpp` tool); stage 6 is `stageLlamacppUpdate`; stages 7-8 are `performSwitch`, driven
 * by `processPendingSwitches` on the scheduler's idle tick. Old build folders
 * are never deleted.
 */

export interface LlamacppUpdateEnv extends LlamacppInstallEnv {
  /** The jobs root (holds `staged/`). */
  jobsRoot: string;
  /**
   * Whether the job still exists. A delete can land while its check is in
   * flight (after `delete` cleaned `staged/`), so staging and switching both
   * ask, and a build whose job is gone is never staged or switched.
   */
  jobExists: (jobId: string) => Promise<boolean>;
  /**
   * Set `llama_server.binary` in config.yaml, preserving comments. Passing
   * `undefined` deletes the field (the post-check restore when there was no
   * prior binary), so the config is never left pointing at a broken build.
   */
  setBinary: (binary: string | undefined) => void;
  /**
   * Restart the backend for the active model. This is also the post-check
   * (stage 8): `acquire` waits for the server to become healthy, so a resolve
   * means the new binary serves and a throw means it failed to start.
   */
  restartModel: (modelName: string) => Promise<void>;
  /** The active model name to restart, or undefined when none is loaded. */
  activeModel: () => string | undefined;
  /** Deliver a user-facing fact for a job (the scheduler prefixes the name). */
  deliver: (jobId: string, text: string) => Promise<void>;
  /** The clock. */
  now: () => number;
}

export interface StageResult {
  /** One line for the run log. The only field the scheduler reads. */
  summary: string;
}

/**
 * Run stages 2-6 for a job whose `github_release` check reported a change.
 * The tag and repo come from the check's observation (step 1). On any failure
 * before the switch, the config is untouched and the staged metadata is
 * cleared.
 */
export async function stageLlamacppUpdate(
  action: Extract<Action, { kind: 'llamacpp_update' }>,
  jobId: string,
  repo: string,
  tag: string,
  env: LlamacppUpdateEnv,
): Promise<StageResult> {
  if (!(await env.jobExists(jobId))) {
    return { summary: `job ${jobId} was deleted during its check; nothing staged` };
  }
  let installed: InstalledBuild;
  try {
    installed = await installLlamacppBuild(repo, tag, action.asset_pattern, env);
  } catch (err) {
    // A failure before the switch must not leave a pre-existing staged build
    // (e.g. a previous switch_pending) switchable. Clear this job's stage.
    clearStaged(env.jobsRoot, jobId);
    throw err;
  }

  // Stage 6: record the staged build. `apply` requests the switch now;
  // `prepare` waits for the owner's approval.
  const staged: StagedBuild = {
    job_id: jobId,
    tag,
    new_binary: installed.newBinary,
    old_binary: env.getConfig().currentBinary,
    assets: installed.assets,
    staged_at: env.now(),
    switch_pending: action.mode === 'apply',
    mode: action.mode,
  };
  writeStaged(env.jobsRoot, staged);
  const summary =
    action.mode === 'apply'
      ? `${tag} staged and passed the smoke test; switching when idle`
      : `${tag} staged and passed the smoke test; reply /job <n> approve to switch`;
  await env.deliver(jobId, summary);
  return { summary };
}

/**
 * Run stages 7-8 for a staged build: write the new binary, restart (only when
 * idle), and post-check. On a post-check failure, restore the previous binary,
 * restart again, and report.
 */
export async function performSwitch(
  jobsRoot: string,
  staged: StagedBuild,
  env: LlamacppUpdateEnv,
): Promise<{ ok: boolean; summary: string }> {
  if (isStale(staged, env.now())) {
    clearStaged(jobsRoot, staged.job_id);
    return { ok: false, summary: `${staged.tag} approval expired; not switching` };
  }
  // The restore target is the binary in the config RIGHT NOW, not the one
  // snapshotted at stage time: between staging and the switch (up to 24 h in
  // prepare mode) the user or another job may have changed it, and restoring
  // the stale value would point the config at a build that no longer applies
  // (audit F5). `staged.old_binary` is kept only as a display fact.
  const oldBinary = env.getConfig().currentBinary;
  env.setBinary(staged.new_binary);
  const model = env.activeModel();
  if (!model) {
    // No model is loaded, so there is no backend to restart or post-check. The
    // config write is done; the next model load uses the new binary.
    clearStaged(jobsRoot, staged.job_id);
    const summary = `switched llama_server.binary to ${staged.tag} (no model loaded; takes effect on next load)`;
    await env.deliver(staged.job_id, summary);
    return { ok: true, summary };
  }
  try {
    // restartModel waits for the server to be healthy, so a resolve is the
    // post-check passing and a throw is it failing.
    await env.restartModel(model);
  } catch (err) {
    // Always restore the previous binary, even when there was none: a
    // post-check failure must never leave the config on a broken build. When the
    // restore target is an absolute path (as in production), verify it still
    // exists before writing it back — the user may have deleted the old build
    // between staging and the switch, and writing a dead path would leave the
    // config pointing at nothing (audit F5). A relative value is restored as-is:
    // this layer has no base to resolve it against, and it resolves the same way
    // it did before the switch.
    if (oldBinary !== undefined && path.isAbsolute(oldBinary) && !fs.existsSync(oldBinary)) {
      clearStaged(jobsRoot, staged.job_id);
      const detail = err instanceof Error ? err.message : String(err);
      // The config is deliberately LEFT on the failed tag rather than unset.
      // An unset binary guarantees the next model load fails with a generic
      // "binary missing" that names nothing; the failed tag still points at a
      // real build the user can inspect, and the message below names the exact
      // key to fix. (Claude's audit note, 2026-09-16.)
      const summary = `post-check failed after switching to ${staged.tag} (${detail}); restore target ${oldBinary} no longer exists — config left on ${staged.tag}, fix llama_server.binary manually`;
      await env.deliver(staged.job_id, summary);
      return { ok: false, summary };
    }
    env.setBinary(oldBinary);
    // Clear the stage so the next idle tick does not retry the same broken
    // binary in a loop. The extracted build folder stays on disk (old builds
    // are never deleted); the job re-stages on the next release.
    clearStaged(jobsRoot, staged.job_id);
    const detail = err instanceof Error ? err.message : String(err);
    const summary = `post-check failed after switching to ${staged.tag} (${detail}); restored ${oldBinary ?? 'previous'} binary`;
    await env.deliver(staged.job_id, summary);
    // The restore restart is the post-check for the restored binary. A failure
    // here is not swallowed (audit F5): it means the config now points at a
    // build that does not serve, and the user must be told.
    try {
      await env.restartModel(model);
    } catch (restoreErr) {
      const restoreDetail = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      const restoreSummary = `restored ${oldBinary ?? 'previous'} binary but it failed to start (${restoreDetail}) — fix llama_server.binary manually`;
      await env.deliver(staged.job_id, restoreSummary);
    }
    return { ok: false, summary };
  }
  clearStaged(jobsRoot, staged.job_id);
  const summary = `switched llama_server.binary to ${staged.tag}`;
  await env.deliver(staged.job_id, summary);
  return { ok: true, summary };
}

/**
 * The scheduler's idle-tick pass: perform the switch for every staged build
 * that has `switch_pending` set and is not expired. Runs only when idle (the
 * caller checks `busy`), so a switch never fights a live turn for the GPU.
 */
export async function processPendingSwitches(
  jobsRoot: string,
  env: LlamacppUpdateEnv,
): Promise<string[]> {
  const summaries: string[] = [];
  let entries: string[];
  try {
    const dir = path.join(jobsRoot, 'staged');
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return summaries; // no staged dir yet
  }
  for (const file of entries) {
    const jobId = file.slice(0, -'.json'.length);
    const staged = readStaged(jobsRoot, jobId);
    if (!staged) continue;
    if (!(await env.jobExists(jobId))) {
      clearStaged(jobsRoot, jobId); // orphaned: its job was deleted after staging began
      continue;
    }
    if (!staged.switch_pending) continue;
    const result = await performSwitch(jobsRoot, staged, env);
    summaries.push(result.summary);
  }
  return summaries;
}

/**
 * The remote `/job <n> approve` handler for a `prepare`-mode staged build.
 * Marks it `switch_pending` so the next idle tick performs the switch. Returns
 * a user-facing message.
 */
export function approveStaged(jobsRoot: string, jobId: string, now: number): string {
  const staged = readStaged(jobsRoot, jobId);
  if (!staged) return `no staged build for job ${jobId} to approve`;
  if (isStale(staged, now)) {
    clearStaged(jobsRoot, jobId);
    return `the staged build for ${staged.tag} has expired (24 h); it will re-stage on the next release`;
  }
  if (staged.switch_pending) return `${staged.tag} is already switching`;
  writeStaged(jobsRoot, { ...staged, switch_pending: true });
  return `${staged.tag} approved; switching when idle`;
}
