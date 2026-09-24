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
import { AgentTaskRunner, type AgentTaskDeps } from './agentTask';
import { recoverInterruptedRuns } from './agentTaskState';
import { SCHEDULER_LEASE_KEY, WakeReconciler } from './schedulerWakes';
import { BACKOFF_THRESHOLD, nextDueWithBackoff } from './backoff';

/** The tick loop that runs due jobs, holds the `jobs-scheduler` lease, and
 * delivers changes through the coalescing outbox. Deps are injected so the
 * tick is testable with a fake clock and store; `jobsSetup.ts` wires prod. */

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
  /** The `agent_task` runner deps (phase 3); absent = the action records a failed run. */
  agentTask?: AgentTaskDeps;
}

const DEFAULT_TICK_MS = 30_000;
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
  private readonly agentTask: AgentTaskRunner | undefined;
  private readonly etagCache = new Map<string, string>();
  /** User-facing delivery: the outbox, the toast, and the summarize timing (B.4). */
  private readonly delivery: JobDelivery;
  /** The single writer of `ForgeScheduledWake` while this window holds the lease. */
  private readonly wakes: WakeReconciler;
  private lease: FileLease | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The tick in flight, so a second one skips it and stop() can wait it out. */
  private running: Promise<void> | undefined;
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
    this.agentTask = deps.agentTask ? new AgentTaskRunner(deps.agentTask) : undefined;
  }

  /**
   * Try for the lease and start the tick. Returns whether this window owns the
   * scheduler now. A non-owner still ticks (each tick retries acquisition), so
   * it takes over when the owner's window closes.
   */
  async start(options: { immediate?: boolean } = {}): Promise<boolean> {
    // `immediate` defaults to true: production wants the first tick on
    // acquisition. A test drives ticks itself and passes `immediate: false`.
    const immediate = options.immediate ?? true;
    const owner = await this.acquireLease();
    if (owner) await this.reconcileWakes();
    if (owner) await this.recoverRuns();
    // A tick's failure is shown, not left as an unhandled rejection.
    this.timer = setInterval(
      () =>
        void this.tick().catch((err: Error) =>
          this.notifyLocal(`Forge jobs: tick failed: ${err.message}`),
        ),
      this.tickMs,
    );
    if (owner && immediate) await this.tick();
    return owner;
  }

  /** Crash recovery (CI-enforced): report and clear `task_run` markers nobody refreshes. */
  private recoverRuns(jobs?: JobFile[]): Promise<Set<string>> {
    const isOwn = (id: string): boolean => this.runningJobs.has(id);
    return recoverInterruptedRuns(this.store, this.outboxDir, () => this.now().getTime(), {
      ...(jobs ? { jobs } : {}),
      isOwn,
    });
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
    // Its failure was already reported to whoever started it.
    await this.running?.catch(() => undefined);
    await this.lease?.release();
    this.lease = undefined;
  }

  /**
   * The lease was lost — another window stole it, or a heartbeat failed. Drop
   * it and go passive, but **stay alive and keep ticking**: the next tick tries
   * to re-acquire, and picks the scheduler back up if it succeeds.
   *
   * Never `stop()`: that made a transient loss permanent for the window's
   * lifetime, silently, while the scheduled wake kept waking the machine.
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
    this.running = this.runTick().finally(() => (this.running = undefined));
    return this.running;
  }

  private async runTick(): Promise<void> {
    // No lease: try to take it. A window that lost its lease (or whose holder
    // went away) picks the scheduler back up here rather than staying dead.
    if (!this.lease) {
      if (!(await this.acquireLease())) return;
      await this.reconcileWakes();
    }
    const now = this.now();
    const jobs = await this.store.loadAll();
    // Every tick, not just at start: a lease taken over from a dead window
    // inherits its stale `task_run` markers.
    const cleared = await this.recoverRuns(jobs);
    for (const jf of jobs) if (cleared.has(jf.job.id)) jf.state.task_run = null;
    // A live marker this window does not own is a run in another window.
    const isOwn = (id: string): boolean => this.runningJobs.has(id);
    const busy = (jf: JobFile | undefined): boolean => !!jf?.state.task_run && !isOwn(jf.job.id);
    const gap = this.lastTickAt === undefined ? 0 : now.getTime() - this.lastTickAt;
    const firstTick = this.lastTickAt === undefined;
    this.lastTickAt = now.getTime();
    // A tick arriving long after the last one is a resume from sleep. A
    // process's first tick detects it from the job states instead (D7: VS Code
    // was closed while jobs fell due).
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
    // A `run_now` marker (B2) runs the job even if not due or paused. It is
    // consumed before the run (no replay after a crash); a busy job keeps it.
    const keep = (id: string): boolean => isOwn(id) || busy(byId.get(id));
    for (const id of await this.store.consumeRunRequests(keep)) {
      const jobFile = byId.get(id);
      if (!jobFile || seen.has(id)) continue;
      seen.add(id);
      toRun.push(jobFile);
    }
    for (const jf of jobs) {
      const pendingAgentTask = jf.state.task_pending && jf.job.action?.kind === 'agent_task';
      if (!jf.job.enabled || seen.has(jf.job.id) || busy(jf)) continue;
      if (!pendingAgentTask && !isDue(jf.state, now)) continue;
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

    await this.delivery.processPendingSummaries();

    // A llamacpp_update that staged a build (apply, or an approved prepare)
    // switches now that the tick has reached it, only when idle (B5).
    await this.llamacpp?.processPendingSwitches();

    // D6: a job that woke the machine and found nothing to do may suspend
    // again, but only on a resume, only if no input and nothing is busy.
    if (isResume) await this.maybeSleepIfIdle(jobs);
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
    let detached = false;
    try {
      // A pending agent task is a retry of the already-observed change. The
      // etag cache may quite correctly report the same observation again, so
      // do not make the pending task pass through the check a second time.
      const result =
        state.task_pending && job.action?.kind === 'agent_task'
          ? {
              observation: state.task_pending_observation ?? state.last_observation,
              changed: true,
              summary: 'retrying pending agent task',
            }
          : await this.runCheck(jobFile);
      if (result.changed && job.action?.kind === 'agent_task') {
        if (!(await this.store.load(job.id))) return;
        if (this.agentTask) {
          // Started, not awaited: the runner owns the `runningJobs` guard until
          // it ends, so the next tick cannot start a second run (AC11).
          detached = true;
          // Hand over THIS check's observation; the runner saves it on success only.
          const runFile = { job, state: { ...state, last_observation: result.observation } };
          void this.agentTask.run(runFile, wasLate).finally(() => this.runningJobs.delete(job.id));
          return;
        }
        const error = 'agent_task runner not wired (no host facade or backend pool)';
        await this.store.appendRun(job.id, {
          at: now.getTime(),
          late: wasLate,
          outcome: 'failed',
          changed: true,
          summary: error,
          error,
          delivered: 0,
        });
        await this.applyBackoff(jobFile, error);
        return;
      }
      if (!(await this.store.load(job.id))) return;
      const change = await this.delivery.deliverForChange(job, result);
      let delivered = change.delivered;
      // Skip the "recovered" line for an agent task: it already reports every
      // failure, so one run must not yield two messages (AC10).
      if (state.consecutive_failures >= BACKOFF_THRESHOLD && job.action?.kind !== 'agent_task') {
        await this.delivery.deliver(
          job,
          `recovered after ${state.consecutive_failures} consecutive failures`,
        );
        delivered++;
      }
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
          error: message,
          delivered: 0,
        })
        .catch(() => undefined);
      // Reporting every failed run turned one GitHub outage into a toast a tick.
      await this.applyBackoff(jobFile, message).catch(() => undefined);
    } finally {
      hold?.dispose();
      if (!detached) this.runningJobs.delete(job.id);
    }
  }

  /** D6: suspend again after a wake if a job asked to and nothing is busy. */
  private async maybeSleepIfIdle(jobs: readonly JobFile[]): Promise<void> {
    if (this.busy() !== undefined) return;
    // A running agent task is busy even when no turn streams (a tool may be
    // mid-download); `runningJobs` holds it for the whole detached run (AC11).
    if (this.runningJobs.size > 0) return;
    const anySleepIfIdle = jobs.some((jf) => jf.job.enabled && jf.job.after === 'sleep_if_idle');
    if (!anySleepIfIdle) return;
    const msSinceInput = await this.power.idleSinceResume();
    if (msSinceInput === null) return;
    // Anchor on the last input: untouched since the resume, the machine may sleep again.
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
    const ctx = buildCheckContext(allowedHosts, job.id, this.etagCache);
    let checkResult = await runCheck(jobFile, ctx);

    // A mutating action (llamacpp_update) runs when the check reports a change
    // (B5). It is the only action that mutates the machine; a failure here is a
    // failed run and backs off like any other. It needs a github_release check
    // (the tag comes from the observation) and the action to be wired.
    if (checkResult.changed && job.action?.kind === 'llamacpp_update') {
      if (job.check.kind === 'github_release' && this.llamacpp) {
        // The type is nullable; never `JSON.parse(null)` before a machine mutation.
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

    return checkResult;
  }

  /** Apply backoff after a failure: double the interval up to 24 h (B.3). */
  private async applyBackoff(jobFile: JobFile, message: string): Promise<void> {
    const { job, state } = jobFile;
    const count = state.consecutive_failures + 1;
    const now = this.now();
    const nextDueAt = nextDueWithBackoff(job.schedule, now, count);
    this.store.patchState(job.id, {
      last_run_at: now.getTime(),
      next_due_at: nextDueAt,
      consecutive_failures: count,
    });
    // Not yet backed off: that was just a normal reschedule.
    if (count < BACKOFF_THRESHOLD) return;
    // Report once, on the run that crosses the threshold. Later
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
