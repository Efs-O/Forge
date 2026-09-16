import { FileLease } from '../util/FileLease';
import { jobsFetch } from './jobsFetch';
import { defaultOutboxDir, writeOutboxItem } from './JobOutbox';
import { githubIssueCheck, githubReleaseCheck } from './checks/github';
import { diskSpaceCheck } from './checks/diskSpace';
import type { CheckContext } from './checks/checkTypes';
import { isDue, nextDue, wakeTimesFor } from './schedule';
import type { Job, JobFile, JobState, RunRow } from './jobSchema';
import type { JobStore } from './JobStore';
import type { PowerControl, SleepIfIdleInput } from '../system/PowerControl';
import { shouldSleepIfIdle } from '../system/PowerControl';
import { LlamacppAction, type LlamacppActionDeps } from './actions/llamacppAction';

/**
 * The job scheduler: the tick loop that runs due jobs, holds the
 * `jobs-scheduler` lease, reconciles the recurring wake task, applies backoff
 * on repeated failures, and delivers changes through the coalescing outbox.
 *
 * Every dependency is injected so the tick is testable with a fake clock and a
 * fake store — no real lease, no real power task, no real network. The
 * production wiring in `jobsSetup.ts` supplies the real ones.
 */

export interface JobSchedulerDeps {
  store: JobStore;
  power: PowerControl;
  /**
   * The `jobs:` config, read through a getter so a config reload picks up new
   * `allowed_hosts` / `max_concurrent` without recreating the scheduler.
   */
  getConfig: () => { allowedHosts: readonly string[]; maxConcurrent: number };
  /** The workspace id, for the lease. */
  workspaceId: string;
  /** The extension instance id, for the lease. */
  instanceId: string;
  /** The directory the lease lives in (the jobs root). */
  leaseDirectory: string;
  /** The coalescing outbox directory (D2). Defaults to `~/.forge/jobs/outbox`. */
  outboxDir?: string;
  /** Show a VS Code toast in the scheduler window (no Telegram needed). */
  notifyLocal?: (text: string) => void;
  /** Injectable clock for tests. Defaults to the real clock. */
  now?: () => Date;
  /** The reason a turn/request/approval is outstanding, or undefined when idle. */
  busy?: () => string | undefined;
  /** Run a `summarize` prompt through the model (no tools). Returns the reply. */
  summarize?: (prompt: string) => Promise<string>;
  /** The tick interval in ms. Defaults to 30 s. */
  tickMs?: number;
  /**
   * The `llamacpp_update` action deps (B5). Absent = the action is not wired
   * (a `llamacpp_update` job then records the change but does not mutate the
   * machine). Production wires it in `jobsSetup.ts`.
   */
  llamacpp?: LlamacppActionDeps;
}

const DEFAULT_TICK_MS = 30_000;
/** Consecutive failures before a job is backed off (B.3). */
const BACKOFF_THRESHOLD = 3;
/** The maximum backoff interval (B.3). */
const MAX_BACKOFF_MS = 24 * 60 * 60_000;
/** A tick arriving more than this late counts as a resume from sleep (B.3). */
const RESUME_GAP_MS = 90_000;

export class JobScheduler {
  private readonly store: JobStore;
  private readonly power: PowerControl;
  private readonly getConfig: () => { allowedHosts: readonly string[]; maxConcurrent: number };
  private readonly workspaceId: string;
  private readonly instanceId: string;
  private readonly leaseDirectory: string;
  private readonly outboxDir: string;
  private readonly notifyLocal: (text: string) => void;
  private readonly now: () => Date;
  private readonly busy: () => string | undefined;
  private readonly summarize: ((prompt: string) => Promise<string>) | undefined;
  private readonly tickMs: number;
  private readonly llamacpp: LlamacppAction | undefined;

  private lease: FileLease | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private disposed = false;
  /** The wall-clock time of the last tick, for resume detection. */
  private lastTickAt: number | undefined;
  /** The ETag cache, shared across runs for the process's lifetime. */
  private readonly etagCache = new Map<string, string>();
  /** Job ids with a run in progress, so the same job is not double-run. */
  private readonly runningJobs = new Set<string>();

  constructor(deps: JobSchedulerDeps) {
    this.store = deps.store;
    this.power = deps.power;
    this.getConfig = deps.getConfig;
    this.workspaceId = deps.workspaceId;
    this.instanceId = deps.instanceId;
    this.leaseDirectory = deps.leaseDirectory;
    this.outboxDir = deps.outboxDir ?? defaultOutboxDir();
    this.notifyLocal = deps.notifyLocal ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
    this.busy = deps.busy ?? (() => undefined);
    this.summarize = deps.summarize;
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    this.llamacpp = deps.llamacpp
      ? new LlamacppAction(deps.llamacpp, {
          jobsRoot: this.store.root,
          allowedHosts: () => this.getConfig().allowedHosts,
          busy: this.busy,
          now: () => this.now().getTime(),
          deliver: (jobId, text) => this.deliverForJob(jobId, text),
          notifyLocal: this.notifyLocal,
        })
      : undefined;
  }

  /**
   * Acquire the lease and start the tick. Returns false when another window
   * already owns the scheduler (the lease is held) — this window then does
   * nothing, which is the correct behaviour for a non-owner.
   */
  async start(options: { immediate?: boolean } = {}): Promise<boolean> {
    // `immediate` defaults to true: production wants the first tick on
    // acquisition. A test drives ticks itself and passes `immediate: false`.
    const immediate = options.immediate ?? true;
    try {
      this.lease = await FileLease.acquire({
        directory: this.leaseDirectory,
        key: 'jobs-scheduler',
        workspaceId: this.workspaceId,
        instanceId: this.instanceId,
        onLost: () => this.stop(),
      });
    } catch {
      // Another window owns the scheduler. Do not tick.
      return false;
    }
    // Reconcile the wake task on lease acquisition: a window that restarts
    // must re-register the wakes for its jobs, not trust the task from a
    // previous life.
    await this.reconcileWakes();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    if (immediate) await this.tick();
    return true;
  }

  /** Stop the tick, release the lease, and dispose any held power requests. */
  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.lease?.release();
    this.lease = undefined;
  }

  /**
   * Reconcile the recurring wake task with the current set of enabled,
   * `wake: true` jobs. Called on lease acquisition, on a job change, and on
   * config reload. An empty set deletes the task, so disabling jobs cannot
   * leave a stale task that wakes the machine.
   */
  async reconcileWakes(): Promise<void> {
    if (!this.lease) return;
    const jobs = await this.store.loadAll();
    const wakes = wakeTimesFor(
      jobs.map((jf) => jf.job),
      this.now(),
    );
    await this.power.setScheduledWakes(wakes);
  }

  /** Watch the store and reconcile wakes on change. */
  watch(): void {
    this.store.watch(() => {
      void this.reconcileWakes();
    });
  }

  /**
   * One tick: run every due job, at most `maxConcurrent` at a time. A tick that
   * arrives more than `RESUME_GAP_MS` late is a resume from sleep: overdue jobs
   * run once, marked `late`, and a `sleep_if_idle` job may suspend again.
   *
   * Public so the tick is testable with a fake clock and store; the interval
   * calls it, and a test drives it directly.
   */
  async tick(): Promise<void> {
    if (this.running || this.disposed || !this.lease) return;
    this.running = true;
    try {
      const now = this.now();
      const gap = this.lastTickAt === undefined ? 0 : now.getTime() - this.lastTickAt;
      this.lastTickAt = now.getTime();
      const isResume = gap > RESUME_GAP_MS;

      const jobs = await this.store.loadAll();
      const byId = new Map(jobs.map((jf) => [jf.job.id, jf]));
      const toRun: JobFile[] = [];
      const seen = new Set<string>();
      // A `run_now` marker (B2) runs the job on this tick even if it is not due
      // or paused — an explicit request overrides the schedule. The marker is
      // consumed before the run, so a crash mid-run does not leave a stale
      // request that fires again on the next tick.
      for (const id of await this.store.consumeRunRequests()) {
        const jobFile = byId.get(id);
        if (!jobFile || seen.has(id)) continue;
        seen.add(id);
        toRun.push(jobFile);
      }
      // Then the jobs that fell due normally. A job already queued by a marker
      // is not run twice in the same tick.
      for (const jf of jobs) {
        if (!jf.job.enabled || seen.has(jf.job.id) || !isDue(jf.state, now)) continue;
        seen.add(jf.job.id);
        toRun.push(jf);
      }
      const limit = this.getConfig().maxConcurrent;
      let cursor = 0;
      const workers = Array.from({ length: Math.min(limit, toRun.length) }, async () => {
        while (cursor < toRun.length) {
          const index = cursor++;
          const jobFile = toRun[index]!;
          if (this.runningJobs.has(jobFile.job.id)) continue;
          await this.runJob(jobFile, isResume);
        }
      });
      await Promise.all(workers);

      // A change recorded while a turn was streaming is summarized now that the
      // tick has reached it (the summary waits for idle, B.4).
      await this.processPendingSummaries();

      // A llamacpp_update that staged a build (apply, or an approved prepare)
      // switches now that the tick has reached it, only when idle (B5).
      await this.llamacpp?.processPendingSwitches();

      // D6: a job that woke the machine and found nothing to do may suspend
      // again, but only on a resume, only if no input and nothing is busy.
      if (isResume) await this.maybeSleepIfIdle(jobs);
    } finally {
      this.running = false;
    }
  }

  /** Run one job: check, act, record. Updates state and the run log. */
  private async runJob(jobFile: JobFile, isResume: boolean): Promise<void> {
    const { job, state } = jobFile;
    this.runningJobs.add(job.id);
    const now = this.now();
    // A job is late when it fell due before this resume tick (the machine was
    // off when it was due). A first-ever run (no next_due_at) is not late.
    const wasLate = isResume && state.next_due_at !== null && state.next_due_at < now.getTime();
    const hold = job.wake ? this.power.holdAwake(`job ${job.id}`) : undefined;
    try {
      const result = await this.runCheck(jobFile);
      const change = await this.deliverForChange(job, state, result);
      let delivered = change.delivered;
      if (state.consecutive_failures >= BACKOFF_THRESHOLD) {
        await this.deliver(
          job,
          `recovered after ${state.consecutive_failures} consecutive failures`,
        );
        delivered++;
      }
      // When the check did not change, a previously pending summary must
      // survive this run so processPendingSummaries can still deliver it once
      // idle. A no-change run must not clobber a pending summarize.
      const nextSummaryPending = result.changed ? change.summaryPending : state.summary_pending;
      const row: RunRow = {
        at: now.getTime(),
        late: wasLate,
        outcome: 'ok',
        changed: result.changed,
        summary: result.summary,
        delivered,
      };
      await this.store.appendRun(job.id, row);
      this.store.patchState(job.id, {
        last_run_at: now.getTime(),
        last_ok_at: now.getTime(),
        last_observation: result.observation,
        consecutive_failures: 0,
        next_due_at: nextDue(job.schedule, now).getTime(),
        summary_pending: nextSummaryPending,
      });
    } catch (err) {
      const message = (err as Error).message;
      await this.store
        .appendRun(job.id, {
          at: now.getTime(),
          late: wasLate,
          outcome: 'failed',
          changed: false,
          summary: 'run failed',
          delivered: 0,
        })
        .catch(() => undefined);
      await this.deliver(job, `failing: ${message}`).catch(() => undefined);
      await this.applyBackoff(jobFile, message).catch(() => undefined);
    } finally {
      hold?.dispose();
      this.runningJobs.delete(job.id);
    }
  }

  /**
   * Run the job's `on_change` for a change and deliver it. Returns how many
   * outbox items were delivered and whether a summarize is still pending (the
   * change was recorded but the model is busy, so the summary waits for idle).
   */
  private async deliverForChange(
    job: Job,
    _state: JobState,
    result: { observation: string; changed: boolean; summary: string },
  ): Promise<{ delivered: number; summaryPending: boolean }> {
    if (!result.changed) return { delivered: 0, summaryPending: false };
    if (job.on_change.kind === 'summarize') {
      // A summarize runs only when no turn is streaming, so it never fights a
      // live chat for the GPU. If busy, record the change and defer; the next
      // idle tick summarizes it.
      if (this.busy() !== undefined) return { delivered: 0, summaryPending: true };
      const summary = await this.summarizeChange(job, result.observation);
      await this.deliver(job, summary);
      return { delivered: 1, summaryPending: false };
    }
    // notify: deliver the check's own summary.
    await this.deliver(job, result.summary);
    return { delivered: 1, summaryPending: false };
  }

  /**
   * Summarize a recorded change with a no-tools model call. The prompt is built
   * from the job name, the typed observation, and the requested focus — no
   * free-form user prompt (B.5).
   */
  private async summarizeChange(job: Job, observation: string): Promise<string> {
    if (!this.summarize) return 'summarize unavailable (no model wired)';
    const focus = job.on_change.kind === 'summarize' ? job.on_change.focus : ['release_notes'];
    const prompt =
      `Summarize what changed for the job "${job.name}". ` +
      `Focus: ${focus.join(', ')}. ` +
      `The check's observation is:\n${observation}\n\n` +
      'Write a short, plain summary of the change and why it matters. ' +
      'If the observation is empty or you cannot tell, say so.';
    const reply = await this.summarize(prompt);
    return reply.trim().slice(0, 500);
  }

  /**
   * Summarize any job whose change was recorded while a turn was streaming
   * (`summary_pending`), now that a tick has reached it. Runs only when idle.
   */
  private async processPendingSummaries(): Promise<void> {
    if (this.busy() !== undefined) return;
    const jobs = await this.store.loadAll();
    for (const { job, state } of jobs) {
      if (!state.summary_pending) continue;
      try {
        const summary = await this.summarizeChange(job, state.last_observation ?? '');
        await this.deliver(job, summary);
        this.store.patchState(job.id, { summary_pending: false });
      } catch {
        // A failed summary is not fatal: the change is already in the run log.
        this.notifyLocal(`Forge: could not summarize job "${job.name}".`);
      }
    }
  }

  /** D6: suspend again after a wake if a job asked to and nothing is busy. */
  private async maybeSleepIfIdle(jobs: readonly JobFile[]): Promise<void> {
    if (this.busy() !== undefined) return;
    const anySleepIfIdle = jobs.some((jf) => jf.job.enabled && jf.job.after === 'sleep_if_idle');
    if (!anySleepIfIdle) return;
    const msSinceInput = await this.power.idleSinceResume();
    if (msSinceInput === null) return;
    // The resume is "now" minus nothing measurable here; use the last input as
    // the anchor. If the user has not touched the box since the resume, the
    // machine may go back to sleep.
    const input: SleepIfIdleInput = {
      msSinceResume: 0,
      msSinceInput,
      busy: this.busy(),
    };
    if (shouldSleepIfIdle(input)) {
      await this.power.suspend().catch(() => undefined);
    }
  }

  /**
   * Deliver a user-facing fact for a job: a toast in the scheduler window (no
   * Telegram needed) and a coalesced outbox file for the Telegram lease holder
   * to deliver to the owner chat (D2). The outbox write is the durable record;
   * the toast is the local half when no Telegram window is around.
   */
  private async deliver(job: Job, text: string): Promise<void> {
    const message = `Job "${job.name}": ${text}`;
    this.notifyLocal(message);
    await writeOutboxItem(this.outboxDir, job.id, job.name, message, this.now().getTime());
  }

  /** Run the check. Returns the observation, whether it changed, and a summary. */
  private async runCheck(jobFile: JobFile): Promise<{
    observation: string;
    changed: boolean;
    summary: string;
  }> {
    const { job, state } = jobFile;
    const { allowedHosts } = this.getConfig();
    const ctx: CheckContext = {
      fetch: (url) => jobsFetch(url, { allowedHosts, etagCache: this.etagCache }),
      etagCache: this.etagCache,
      allowedHosts,
    };

    let checkResult;
    switch (job.check.kind) {
      case 'github_release':
        checkResult = await githubReleaseCheck(job.check, state.last_observation, ctx);
        break;
      case 'github_issue':
        checkResult = await githubIssueCheck(job.check, state.last_observation, ctx);
        break;
      case 'disk_space':
        checkResult = await diskSpaceCheck(job.check, state.last_observation, ctx);
        break;
    }

    // A mutating action (llamacpp_update) runs when the check reports a change
    // (B5). It is the only action that mutates the machine; a failure here is a
    // failed run and backs off like any other. It needs a github_release check
    // (the tag comes from the observation) and the action to be wired.
    if (checkResult.changed && job.action?.kind === 'llamacpp_update') {
      if (job.check.kind === 'github_release' && this.llamacpp) {
        const tag = (JSON.parse(checkResult.observation) as { tag?: string }).tag;
        if (typeof tag === 'string' && tag.length > 0) {
          const stage = await this.llamacpp.stage(job.action, job.id, job.check.repo, tag);
          checkResult = { ...checkResult, summary: stage.summary };
        }
      }
    }

    return {
      observation: checkResult.observation,
      changed: checkResult.changed,
      summary: checkResult.summary,
    };
  }

  /** Deliver a fact for a job by id (the action does not hold the Job). */
  private async deliverForJob(jobId: string, text: string): Promise<void> {
    const jobFile = await this.store.load(jobId);
    if (!jobFile) {
      this.notifyLocal(`Forge: ${text}`);
      return;
    }
    await this.deliver(jobFile.job, text);
  }

  /** Apply backoff after a failure: double the interval up to 24 h (B.3). */
  private async applyBackoff(jobFile: JobFile, message: string): Promise<void> {
    const { job, state } = jobFile;
    const count = state.consecutive_failures + 1;
    const now = this.now();
    if (count < BACKOFF_THRESHOLD) {
      // Not yet backed off: just reschedule normally.
      this.store.patchState(job.id, {
        last_run_at: now.getTime(),
        next_due_at: nextDue(job.schedule, now).getTime(),
        consecutive_failures: count,
      });
      return;
    }
    // Back off: push the next due out by a doubling interval, capped at 24 h.
    const scheduledIntervalMs = Math.max(
      60_000,
      nextDue(job.schedule, now).getTime() - now.getTime(),
    );
    const backoffMs = Math.min(
      MAX_BACKOFF_MS,
      scheduledIntervalMs * 2 ** (count - BACKOFF_THRESHOLD + 1),
    );
    const nextDueAt = now.getTime() + backoffMs;
    this.store.patchState(job.id, {
      last_run_at: now.getTime(),
      next_due_at: nextDueAt,
      consecutive_failures: count,
    });
    // The first backoff is reported once; the recovery (a success after
    // backoff) is reported by the next successful run.
    await this.store.appendRun(job.id, {
      at: now.getTime(),
      late: false,
      outcome: 'skipped',
      changed: false,
      summary: `backed off after ${count} failures: ${message}`,
      delivered: 0,
    });
  }
}
