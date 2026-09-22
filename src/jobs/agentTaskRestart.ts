import * as fs from 'fs';
import * as YAML from 'yaml';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { IBackendPool } from '../backend/poolTypes';
import type { AgentTaskOutcome } from './agentTask';

/**
 * Step 7 of the agent-task runner (AGENT_TASK_JOBS_PLAN phase 4): after the
 * turn has fully ended, restart the backend on the new binary when the agent
 * asked for it (`RESTART: yes`) and reported `RESULT: ok`. If the new binary
 * does not come up, restore config.yaml from the pre-turn snapshot and restart
 * once more. This is deterministic runner code, not the model: the model runs
 * on the backend being replaced, so it cannot restart itself.
 *
 * It deliberately does NOT import from `src/jobs/actions/llamacpp*` (retired in
 * phase 5); it carries over that code's lessons instead:
 * - no model loaded → nothing to restart; the new binary takes effect on the
 *   next load;
 * - a restore restart that also fails is never swallowed: the report says so
 *   and that `llama_server.binary` needs a manual fix.
 */

/** The wall-clock cap on a single restart. A cap hit counts as a failed restart. */
export const RESTART_CAP_MS = 5 * 60_000;

export interface RestartAfterTurnDeps {
  host: ForgeHostFacade;
  pool: IBackendPool;
  /** The live config.yaml path (the rollback target). */
  configPath: string | undefined;
  /** The pre-turn config.yaml snapshot (the rollback source). */
  backupPath: string | undefined;
  /** Injectable abortable timer for the 5-minute restart cap. Defaults to setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Run step 7 and return the (possibly updated) outcome. Only restarts on
 * `RESTART: yes` AND `RESULT: ok`; a failed restart rolls back and maps the
 * outcome to `failed`. Never throws: every failure path returns a failed
 * outcome so the runner's report reflects it.
 */
export async function restartAfterTurn(
  deps: RestartAfterTurnDeps,
  jobModel: string,
  outcome: AgentTaskOutcome,
): Promise<AgentTaskOutcome> {
  // Step 7 fires only on RESTART: yes AND RESULT: ok.
  if (!outcome.restart || outcome.kind !== 'ok') return outcome;

  // No model is loaded, so there is no backend to restart. The config write is
  // done; the next model load uses the new binary.
  if (deps.pool.loadedModelNames().length === 0) {
    return {
      ...outcome,
      sentence: `${outcome.sentence} (no model loaded; new binary takes effect on next load)`,
    };
  }

  // Acceptance #6: the failure report names BOTH binaries. The new one is in
  // the live config (what the agent pointed it at), the old in the snapshot.
  const old = readBinaryFrom(deps.backupPath) ?? 'the previous';
  const newBin = readBinaryFrom(deps.configPath) ?? 'the new';
  // Both paths are needed for a restore; without either nothing is put back.
  const hadBackup = deps.backupPath !== undefined && deps.configPath !== undefined;
  let result: { ok: boolean; error?: string | undefined };
  try {
    result = await restartWithCap(deps.host, jobModel, deps.sleep);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (result.ok) return outcome;

  // Failed restart: restore config.yaml's bytes from the snapshot, then restart
  // once more. The restore restart is the post-check for the restored binary.
  let restoreOk = false;
  let restoreError = result.error ?? 'unknown error';
  try {
    await restoreConfig(deps.backupPath, deps.configPath);
    const restoreResult = await restartWithCap(deps.host, jobModel, deps.sleep);
    restoreOk = restoreResult.ok;
    restoreError = restoreResult.error ?? 'unknown error';
  } catch (err) {
    restoreError = err instanceof Error ? err.message : String(err);
  }
  if (restoreOk) {
    // With a snapshot the restore put the old binary back, so the new binary did
    // not take effect. Without one, nothing was restored and the retry simply
    // loaded the new binary on the second try — the honest end state is ok.
    if (hadBackup) {
      return {
        kind: 'failed',
        sentence: `new binary ${newBin} did not load, rolled back to ${old}`,
        restart: false,
        finalText: outcome.finalText,
      };
    }
    return {
      kind: 'ok',
      sentence:
        `${outcome.sentence} (new binary ${newBin} did not load on the first try ` +
        `but loaded on retry; no snapshot to roll back to)`,
      restart: false,
      finalText: outcome.finalText,
    };
  }
  // The rollback also failed to start: say so, and that the binary needs a
  // manual fix. Never swallow it.
  const rollback = hadBackup
    ? `the rollback to ${old}`
    : 'the rollback (no snapshot to roll back to)';
  return {
    kind: 'failed',
    sentence:
      `new binary ${newBin} did not load and ${rollback} also failed to start ` +
      `(${restoreError}) — fix llama_server.binary manually`,
    restart: false,
    finalText: outcome.finalText,
  };
}

/**
 * Restart the model, racing it against the 5-minute cap. Resolves as soon as
 * either settles; a cap hit is a failed restart. The cap timer is aborted on a
 * normal finish so it never outlives the call.
 */
async function restartWithCap(
  host: ForgeHostFacade,
  model: string,
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<{ ok: boolean; error?: string | undefined }> {
  const timer = sleep ?? sleepWithAbort;
  const controller = new AbortController();
  const cap = timer(RESTART_CAP_MS, controller.signal).then(
    () => ({
      ok: false as const,
      error: `restart timed out after ${RESTART_CAP_MS / 60000} minutes`,
    }),
    () => {
      throw new Error('restart cap aborted');
    },
  );
  cap.catch(() => {}); // prevent unhandled rejection when the restart finishes first
  const restart = host.restartModel(model).then(
    () => ({ ok: true as const, error: undefined as string | undefined }),
    (err: unknown) => ({
      ok: false as const,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
  const outcome = await Promise.race([restart, cap]);
  controller.abort(); // cancel the cap on a normal finish (no-op if it already fired)
  return outcome;
}

/** Restore config.yaml's bytes from the pre-turn snapshot. A no-op with no backup. */
async function restoreConfig(
  backupPath: string | undefined,
  configPath: string | undefined,
): Promise<void> {
  if (!backupPath || !configPath) return;
  const bytes = await fs.promises.readFile(backupPath);
  await fs.promises.writeFile(configPath, bytes);
}

/** The `llama_server.binary` value in the pre-turn snapshot (the old binary). */
function readBinaryFrom(backupPath: string | undefined): string | undefined {
  if (!backupPath) return undefined;
  try {
    const doc = YAML.parse(fs.readFileSync(backupPath, 'utf8'));
    return doc?.llama_server?.binary;
  } catch {
    return undefined;
  }
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('timer aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('timer aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
