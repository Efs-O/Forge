import {
  processPendingSwitches as runPendingSwitches,
  stageLlamacppUpdate,
  type LlamacppUpdateEnv,
  type StageResult,
} from './llamacppUpdate';
import type { Action } from '../jobSchema';
import type { JobStore } from '../JobStore';

/**
 * The deps the `llamacpp_update` action needs that the scheduler does not
 * already hold. The scheduler supplies the rest (jobs root, allowed hosts,
 * busy, clock, and the outbox-backed deliver) through {@link LlamacppActionContext}
 * when it builds the action. Production wires these in `jobsSetup.ts`.
 */
export interface LlamacppActionDeps {
  /** The `%LOCALAPPDATA%\Forge` root the builds and staging live under. */
  localRoot: string;
  /** The config slice the action reads (current binary, embeddings, host). */
  getLlamacppConfig: () => {
    currentBinary: string | undefined;
    embeddings: { enabled?: boolean; model_path?: string } | undefined;
    llama_server: { host?: string; port?: number } | undefined;
  };
  runCommand: LlamacppUpdateEnv['runCommand'];
  sha256File: LlamacppUpdateEnv['sha256File'];
  extractZip: LlamacppUpdateEnv['extractZip'];
  /**
   * Set `llama_server.binary` in config.yaml, preserving comments. Passing
   * `undefined` deletes the field (the post-check restore when there was no
   * prior binary).
   */
  setBinary: (binary: string | undefined) => void;
  /** Restart the backend for the active model (also the post-check, stage 8). */
  restartModel: (modelName: string) => Promise<void>;
  /** The active model name to restart, or undefined when none is loaded. */
  activeModel: () => string | undefined;
}

/**
 * The scheduler-owned context the action builds its env from. Kept as a small
 * record so the action stays free of a scheduler dependency (no cycle): the
 * scheduler passes its own jobs root, allowed hosts, busy check, clock, and
 * outbox-backed deliver.
 */
export interface LlamacppActionContext {
  /** The job store: its root holds `staged/`, and `load` says whether a job
   *  still exists (a delete can race an in-flight check). */
  store: Pick<JobStore, 'root' | 'load'>;
  /** The `jobs:` allowed hosts, read through a getter so reloads apply. */
  allowedHosts: () => readonly string[];
  /** The reason a turn is outstanding, or undefined when idle. */
  busy: () => string | undefined;
  /** The clock, in epoch ms. */
  now: () => number;
  /** Deliver a fact for a job by id (the outbox-backed path). */
  deliver: (jobId: string, text: string) => Promise<void>;
  /** Show a VS Code toast in the scheduler window. */
  notifyLocal: (text: string) => void;
}

/**
 * The `llamacpp_update` action (B5) as the scheduler drives it. It owns the
 * env the pipeline needs and the two entry points the scheduler calls:
 * `stage` (stages 2-6, on a changed `github_release` check) and
 * `processPendingSwitches` (stages 7-8, on the idle tick). Keeping this here
 * rather than in `JobScheduler.ts` keeps the scheduler under its line limit
 * and the action's wiring in one place.
 */
export class LlamacppAction {
  constructor(
    private readonly deps: LlamacppActionDeps,
    private readonly ctx: LlamacppActionContext,
  ) {}

  /** Build the pipeline env from the deps and the scheduler context. */
  private buildEnv(): LlamacppUpdateEnv {
    const d = this.deps;
    return {
      jobsRoot: this.ctx.store.root,
      jobExists: async (jobId) => (await this.ctx.store.load(jobId)) !== undefined,
      localRoot: d.localRoot,
      fetchOptions: () => ({ allowedHosts: this.ctx.allowedHosts(), etagCache: new Map() }),
      getConfig: d.getLlamacppConfig,
      runCommand: d.runCommand,
      sha256File: d.sha256File,
      extractZip: d.extractZip,
      setBinary: d.setBinary,
      restartModel: d.restartModel,
      activeModel: d.activeModel,
      deliver: (jobId, text) => this.ctx.deliver(jobId, text),
      now: this.ctx.now,
    };
  }

  /**
   * Stages 2-6: download, verify, extract, smoke-test the tag's build and
   * record it as staged. Returns the run-log summary. Throws on any failure
   * before the switch (the caller treats it as a failed run).
   */
  async stage(
    action: Extract<Action, { kind: 'llamacpp_update' }>,
    jobId: string,
    repo: string,
    tag: string,
  ): Promise<StageResult> {
    return stageLlamacppUpdate(action, jobId, repo, tag, this.buildEnv());
  }

  /**
   * Stages 7-8 on the idle tick: switch any staged build with
   * `switch_pending` set and not expired. Runs only when idle so a switch
   * never fights a live turn for the GPU.
   */
  async processPendingSwitches(): Promise<void> {
    if (this.ctx.busy() !== undefined) return;
    try {
      await runPendingSwitches(this.ctx.store.root, this.buildEnv());
    } catch (err) {
      this.ctx.notifyLocal(
        `Forge: llamacpp_update switch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
