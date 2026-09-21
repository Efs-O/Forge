import { FileLease } from '../util/FileLease';

import { defaultOutboxDir } from './JobOutbox';
import { JobDelivery } from './JobDelivery';
import { runCheck, buildCheckContext } from './checks/runCheck';
import { isDue, nextDue, wakeTimesFor } from './schedule';
import type { JobFile, RunRow } from './jobSchema';
import type { JobStore } from './JobStore';
import type { PowerControl, SleepIfIdleInput } from '../system/PowerControl';
import { shouldSleepIfIdle } from '../system/PowerControl';
import { LlamacppAction, type LlamacppActionDeps } from './actions/llamacppAction';
import { SCHEDULER_LEASE_KEY, WakeReconciler } from './schedulerWakes';

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
  /** User-facing delivery: the outbox, the toast, and the summarize timing (B.4). */
  private readonly delivery: JobDelivery;
  /** The single writer of `ForgeScheduledWake` while this window holds the lease. */
  private readonly wakes: WakeReconciler;

  private lease: FileLease | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private disposed = false;
  /** The wall-clock time of the last tick, for resume detection. */
  private lastTickAt: number | undefined;

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
    this.wakes = new WakeReconciler(this.power);
    this.delivery = new JobDelivery({
      store: this.store,
      outboxDir: this.outboxDir,
      notifyLocal: this.notifyLocal,
      busy: this.busy,
      summarize: this.summarize,
      now: () => this.now().getTime(),
    });
    this.llamacpp = deps.llamacpp
      ? new LlamacppAction(deps.llamacpp, {
          store: this.store,
          allowedHosts: () => this.getConfig().allowedHosts,
          busy: this.busy,
          now: () => this.now().getTime(),
          deliver: (jobId, text) => this.delivery.deliverForJob(jobId, text),
          notifyLocal: this.notifyLocal,
        })
      : undefined;
  }

  /**
   * Try for the lease and start the tick. Returns whether this window owns the
   * scheduler now. A non-owner still ticks — every tick without the lease only
   * retries acquisition — so it takes over when the owner's window closes.
   * Returning before the interval existed left the loser passive forever.
   */
  async start(options: { immediate?: boolean } = {}): Promise<boolean> {
    // `immediate` defaults to true: production wants the first tick on
    // acquisition. A test drives ticks itself and passes `immediate: false`.
    const immediate = options.immediate ?? true;
    const owner = await this.acquireLease();
    if (owner) await this.reconcileWakes();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    if (owner && immediate) await this.tick();
    return owner;
  }

  /**
   * Try to take the `jobs-scheduler` lease. Returns whether this window now
   * holds it. Used both on `start()` and on every tick that finds itself
   * without one, so a lost lease is recovered rather than fatal.
   */
  private async acquireLease(): Promise<boolean> {
    try {
      this.lease = await FileLease.acquire({
        directory: this.leaseDirectory,
        key: SCHEDULER_LEASE_KEY,
        workspaceId: this.workspaceId,
        instanceId: this.instanceId,
        onLost: () => this.handleLeaseLost(),
      });
      this.wakes.reset();
      return true;
    } catch {
      this.lease = undefined;
      return false;
    }
  }

  /**
   * Stop for good: the tick stops, the lease is released, and the scheduler
   * cannot be restarted. This is disposal — `jobsSetup` calls it on
   * deactivation and on a config reload that disables jobs.
   *
   * It is NOT what happens when the lease is merely lost; see
   * {@link handleLeaseLost}.
   */
  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.lease?.release();
    this.lease = undefined;
  }

  /**
   * The lease was lost — another window stole it, or a heartbeat failed. Drop
   * it and go passive, but **stay alive and keep ticking**: the next tick tries
   * to re-acquire, and picks the scheduler back up if it succeeds.
   *
   * This must never be `stop()`. Disposing here made a transient lease loss
   * permanent for the lifetime of the window — silently, with no toast, no run
   * row and no outbox item, while `ForgeScheduledWake` stayed armed and kept
   * waking the machine for jobs that nobody was running any more.
   */
  private handleLeaseLost(): void {
    this.lease = undefined;
  }

  /**
   * Reconcile the wake task with the enabled `wake: true` jobs (lease
   * acquisition, job change, config reload). An empty set deletes the task.
   */
  async reconcileWakes(): Promise<void> {
    if (!this.lease) return;
    const jobs = (await this.store.loadAll()).map((jf) => jf.job);
    await this.wakes.reconcile(wakeTimesFor(jobs, this.now()));
  }

  /** Watch the store and reconcile wakes on change; a no-op until this window holds the lease. */
  watch(): void {
    this.store.watch(() => {
      this.reconcileWakes().catch((err: Error) =>
        this.notifyLocal(`Forge jobs: could not update the scheduled wake: ${err.message}`),
      );
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
    if (this.running || this.disposed) return;
    // Claimed before the lease attempt: two interval ticks racing through the
    // acquisition await both ran every due job (seen under load, 2026-09-21).
    this.running = true;
    try {
      // No lease: try to take it. A window that lost its lease (or whose holder
      // went away) picks the scheduler back up here rather than staying dead.
      if (!this.lease) {
        if (!(await this.acquireLease())) return;
        await this.reconcileWakes();
      }
      const now = this.now();
      const jobs = await this.store.loadAll();
      const gap = this.lastTickAt === undefined ? 0 : now.getTime() - this.lastTickAt;
      const firstTick = this.lastTickAt === undefined;
      this.lastTickAt = now.getTime();
      // A tick arriving long after the last one is a resume from sleep. The
      // FIRST tick of a process has no previous tick to measure against, but it
      // is the same situation in disguise — VS Code was closed while jobs fell
      // due (D7) — so detect it from the job states instead, or D7's `late`
      // flag never gets set on the one path it was written for.
      const isResume = firstTick
        ? jobs.some(
            (jf) =>
              jf.job.enabled &&
              jf.state.next_due_at !== null &&
              now.getTime() - jf.state.next_due_at > RESUME_GAP_MS,
          )
        : gap > RESUME_GAP_MS;

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
      await this.delivery.processPendingSummaries();

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
      const change = await this.delivery.deliverForChange(job, result);
      let delivered = change.delivered;
      if (state.consecutive_failures >= BACKOFF_THRESHOLD) {
        await this.delivery.deliver(
          job,
          `recovered after ${state.consecutive_failures} consecutive failures`,
        );
        delivered++;
      }
      // When the check did not change, a previously pending summary must
      // survive this run so JobDelivery.processPendingSummaries can deliver it once
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
      // The failure is REPORTED by applyBackoff, once, when the job crosses the
      // threshold (B.3: "After 3 consecutive failures, report once"). Reporting
      // every failed run instead turned a GitHub outage into a toast on every
      // tick and inflated the coalesced outbox count for what was one
      // continuous fault.
      await this.applyBackoff(jobFile, message).catch(() => undefined);
    } finally {
      hold?.dispose();
      this.runningJobs.delete(job.id);
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

  /** Run the check. Returns the observation, whether it changed, and a summary. */
  private async runCheck(jobFile: JobFile): Promise<{
    observation: string | null;
    changed: boolean;
    summary: string;
  }> {
    const { job } = jobFile;
    const { allowedHosts } = this.getConfig();
    // The ETag cache is keyed PER JOB, not per URL alone. Two jobs watching the
    // same repo share a URL, and a cache keyed on the URL alone hands job B a
    // 304 on its very first run — leaving it with no baseline while the server
    // says "nothing new", a state the check cannot tell apart from a real
    // no-change. The same happens to one job whose state file was lost while
    // the process kept its cache.
    const ctx = buildCheckContext(allowedHosts, job.id);
    let checkResult = await runCheck(jobFile, ctx);

    // A mutating action (llamacpp_update) runs when the check reports a change
    // (B5). It is the only action that mutates the machine; a failure here is a
    // failed run and backs off like any other. It needs a github_release check
    // (the tag comes from the observation) and the action to be wired.
    if (checkResult.changed && job.action?.kind === 'llamacpp_update') {
      if (job.check.kind === 'github_release' && this.llamacpp) {
        // `changed` is only ever true with a real observation, but the type is
        // nullable now and a silent `JSON.parse(null)` is not the failure mode
        // to pick for the one action that mutates the machine.
        const tag =
          checkResult.observation === null
            ? undefined
            : (JSON.parse(checkResult.observation) as { tag?: string }).tag;
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
    // Report exactly once, on the run that crosses the threshold. Later
    // failures keep extending the backoff silently; the recovery (a success
    // after backoff) is reported by the next successful run.
    if (count === BACKOFF_THRESHOLD) {
      await this.delivery.deliver(job, `failing: ${message}`).catch(() => undefined);
    }
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
