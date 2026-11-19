import type { FileLease } from '../util/FileLease';
import { defaultOutboxDir } from './JobOutbox';
import { JobDelivery } from './JobDelivery';
import { isDue, wakeTimesFor } from './schedule';
import type { JobFile } from './jobSchema';
import type { JobStore } from './JobStore';
import type { PowerControl } from '../system/PowerControl';
import { LlamacppAction, type LlamacppActionDeps } from './actions/llamacppAction';
import { AgentTaskRunner, type AgentTaskDeps } from './agentTask';
import { RetitleRunner, type RetitleDeps } from './retitleRun';
import { recoverInterruptedRuns } from './agentTaskState';
import { WakeReconciler } from './schedulerWakes';
import { acquireSchedulerLease } from './jobLease';
import { describeError } from '../util/describeError';
import { makeApprovalWarnings } from './approvalJobRuleWarnings';
import type { JobsFetchCacheEntry } from './jobsFetch';
import type { ForgeConfig } from '../config/types';
import { JobModelLane, type PendingModelAction } from './jobModelLane';
import {
  runJobCheck,
  executeScheduledJob,
  applyJobBackoff,
  recordUnwiredActionRun,
  sleepIfIdleIfRequested,
} from './jobRunLifecycle';

/** The tick loop that runs due jobs, holds the `jobs-scheduler` lease, and
 * delivers changes through the coalescing outbox. Deps are injected so the
 * tick is testable with a fake clock and store; `jobsSetup.ts` wires prod. */

export interface JobSchedulerDeps {
  store: JobStore;
  power: PowerControl;
  /** Current `jobs:` config, read fresh on each use. */
  getConfig: () => { allowedHosts: readonly string[]; maxConcurrent: number };
  getApprovalPolicy?: () => ForgeConfig['approvals'];
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
  /** Show each report in the job's own chat too, as a notice row, when it is open here. */
  postToJobChat?: (conversationId: string, text: string) => void;
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
  /** The `retitle` runner deps; absent = the action records a failed run. */
  retitle?: RetitleDeps;
}

const DEFAULT_TICK_MS = 30_000;
/** A tick arriving more than this late counts as a resume from sleep (B.3). */
const RESUME_GAP_MS = 90_000;

function isModelAction(job: JobFile['job'] | undefined): boolean {
  return job?.action?.kind === 'agent_task' || job?.action?.kind === 'retitle';
}

export class JobScheduler {
  private readonly store: JobStore;
  private readonly power: PowerControl;
  private readonly getConfig: () => { allowedHosts: readonly string[]; maxConcurrent: number };
  private readonly getApprovalPolicy: () => ForgeConfig['approvals'] | undefined;
  private readonly workspaceId: string;
  private readonly instanceId: string;
  private readonly leaseDirectory: string;
  private readonly outboxDir: string;
  private readonly notifyLocal: (text: string) => void;
  private readonly approvalRuleWarnings: ReturnType<typeof makeApprovalWarnings>;
  private readonly now: () => Date;
  private readonly busy: () => string | undefined;
  private readonly summarize: ((prompt: string) => Promise<string>) | undefined;
  private readonly tickMs: number;
  private readonly llamacpp: LlamacppAction | undefined;
  private readonly agentTask: AgentTaskRunner | undefined;
  private readonly retitle: RetitleRunner | undefined;
  private gpuGateAbortController = new AbortController();
  private readonly etagCache = new Map<string, JobsFetchCacheEntry>();
  /** User-facing delivery: the outbox, the toast, and the summarize timing (B.4). */
  private readonly delivery: JobDelivery;
  /** The single writer of `ForgeScheduledWake` while this window holds the lease. */
  private readonly wakes: WakeReconciler;
  private lease: FileLease | undefined;
  /** The last lease error shown, so a persisting one is not toasted every tick. */
  private leaseError: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The tick in flight, so a second one skips it and stop() can wait it out. */
  private running: Promise<void> | undefined;
  private disposed = false;
  /** The wall-clock time of the last tick, for resume detection. */
  private lastTickAt: number | undefined;
  /** Job ids with a run in progress, so the same job is not double-run. */
  private readonly runningJobs = new Set<string>();
  /** Checks use maxConcurrent; a detached model action does not consume a check worker. */
  private readonly checkingJobs = new Set<string>();
  /** The one admitted background model action, held until its entire run ends. */
  private readonly modelLane = new JobModelLane();
  /** A pending admission attempt is detached so stop() can abort it without holding a tick. */
  private modelAdmission: Promise<void> | undefined;

  constructor(deps: JobSchedulerDeps) {
    this.store = deps.store;
    this.power = deps.power;
    this.getConfig = deps.getConfig;
    this.workspaceId = deps.workspaceId;
    this.instanceId = deps.instanceId;
    this.leaseDirectory = deps.leaseDirectory;
    this.outboxDir = deps.outboxDir ?? defaultOutboxDir();
    this.notifyLocal = deps.notifyLocal ?? (() => undefined);
    this.getApprovalPolicy = deps.getApprovalPolicy ?? (() => undefined);
    this.approvalRuleWarnings = makeApprovalWarnings(this.getApprovalPolicy, this.notifyLocal);
    this.now = deps.now ?? (() => new Date());
    this.busy = deps.busy ?? (() => undefined);
    this.summarize = deps.summarize;
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    this.wakes = new WakeReconciler(this.power);
    this.delivery = new JobDelivery({
      store: this.store,
      outboxDir: this.outboxDir,
      notifyLocal: this.notifyLocal,
      postToJobChat: deps.postToJobChat,
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
    this.agentTask = deps.agentTask
      ? new AgentTaskRunner({
          ...deps.agentTask,
          ...(deps.agentTask.gpuGate
            ? {
                gpuGate: {
                  ...deps.agentTask.gpuGate,
                  signal: () => this.gpuGateAbortController.signal,
                },
              }
            : {}),
        })
      : undefined;
    this.retitle = deps.retitle
      ? new RetitleRunner({
          ...deps.retitle,
          ...(deps.retitle.gpuGate
            ? {
                gpuGate: {
                  ...deps.retitle.gpuGate,
                  signal: () => this.gpuGateAbortController.signal,
                },
              }
            : {}),
        })
      : undefined;
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
    // A tick's failure is shown, not left as an unhandled rejection.
    this.timer = setInterval(
      () =>
        void this.tick().catch((err: Error) =>
          this.notifyLocal(`Forge jobs: tick failed: ${err.message}`),
        ),
      this.tickMs,
    );
    if (owner) {
      await this.reconcileWakes().catch((err: Error) =>
        this.notifyLocal(`Forge jobs: could not update the scheduled wake: ${err.message}`),
      );
      await this.recoverRuns();
    }
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
    if (this.gpuGateAbortController.signal.aborted) {
      this.gpuGateAbortController = new AbortController();
    }
    try {
      this.lease = await acquireSchedulerLease(
        this.leaseDirectory,
        this.workspaceId,
        this.instanceId,
        () => {
          this.lease = undefined;
          this.gpuGateAbortController.abort();
        },
        this.wakes,
      );
      this.leaseError = undefined;
    } catch (error) {
      // Not another window: no scheduled job runs until this clears. Shown
      // once per distinct error; the next tick tries again.
      const message = describeError(error);
      if (message !== this.leaseError) {
        this.notifyLocal(`Forge jobs: could not take the scheduler lease: ${message}`);
      }
      this.leaseError = message;
      this.lease = undefined;
    }
    return this.lease !== undefined;
  }

  /**
   * Stop for good: the tick stops, the lease is released, and the scheduler
   * cannot be restarted. This is disposal — `jobsSetup` calls it on
   * deactivation and on a config reload that disables jobs.
   *
   * It is NOT what happens when the lease is merely lost (see
   * {@link acquireLease}); a lost lease keeps the scheduler alive.
   */
  async stop(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.gpuGateAbortController.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // Its failure was already reported to whoever started it.
    await this.running?.catch(() => undefined);
    await this.modelAdmission?.catch(() => undefined);
    await this.lease?.release();
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
    this.approvalRuleWarnings.observe(jobs);
    // Every tick, not just at start: a lease taken over from a dead window
    // inherits its stale `task_run` markers.
    const cleared = await this.recoverRuns(jobs);
    for (const jf of jobs) if (cleared.has(jf.job.id)) jf.state.task_run = null;
    // A live marker another window owns is a run in progress; a marker this tick
    // cleared counts as busy too, so only the next tick may start that job.
    const isOwn = (id: string): boolean => this.runningJobs.has(id);
    const busy = (jf: JobFile | undefined): boolean =>
      (!!jf?.state.task_run && !isOwn(jf.job.id)) || (!!jf && cleared.has(jf.job.id));
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
    const keep = (id: string): boolean =>
      isOwn(id) ||
      busy(byId.get(id)) ||
      ((this.modelLane.occupied || this.modelAdmission !== undefined) &&
        isModelAction(byId.get(id)?.job));
    const runNowIds = new Set<string>();
    for (const id of await this.store.consumeRunRequests(keep)) {
      const jobFile = byId.get(id);
      if (!jobFile || seen.has(id)) continue;
      seen.add(id);
      runNowIds.add(id);
      toRun.push(jobFile);
    }
    for (const jf of jobs) {
      const pendingTask =
        jf.state.task_pending &&
        (jf.job.action?.kind === 'agent_task' || jf.job.action?.kind === 'retitle');
      if (!jf.job.enabled || seen.has(jf.job.id) || busy(jf)) continue;
      if (!pendingTask && !isDue(jf.state, now)) continue;
      seen.add(jf.job.id);
      toRun.push(jf);
    }
    const limit = this.getConfig().maxConcurrent;
    const modelActions: PendingModelAction[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, toRun.length) }, async () => {
      // Only check work consumes this pool. A detached model action keeps its
      // job identity for de-duplication, but must not prevent later due checks.
      while (cursor < toRun.length && this.checkingJobs.size < limit) {
        const index = cursor++;
        const jobFile = toRun[index]!;
        if (this.runningJobs.has(jobFile.job.id)) continue;
        await this.runJob(jobFile, isResume, modelActions, runNowIds.has(jobFile.job.id));
      }
    });
    await Promise.all(workers);

    // Checks for every due job have now run. Admission proceeds off-tick, so
    // Stop can abort a slow GPU sample and later ticks can keep checking.
    if (!this.modelLane.occupied && this.modelAdmission === undefined) {
      let resolveStarted!: () => void;
      const started = new Promise<void>((resolve) => (resolveStarted = resolve));
      const attempt = this.modelLane.process(
        modelActions,
        () => this.disposed || this.gpuGateAbortController.signal.aborted,
        (candidate) => this.admitModelAction(candidate, resolveStarted),
      );
      const tracked = attempt
        .catch((err: unknown) =>
          this.notifyLocal(`Forge jobs: admission failed: ${describeError(err)}`),
        )
        .finally(() => {
          if (this.modelAdmission === tracked) this.modelAdmission = undefined;
        });
      this.modelAdmission = tracked;
      await Promise.race([started, tracked]);
    }

    if (!this.modelLane.occupied && this.modelAdmission === undefined)
      await this.delivery.processPendingSummaries();

    // A llamacpp_update that staged a build (apply, or an approved prepare)
    // switches now that the tick has reached it, only when idle (B5).
    await this.llamacpp?.processPendingSwitches();

    // D6: a job that woke the machine and found nothing to do may suspend
    // again, but only on a resume, only if no input and nothing is busy.
    if (isResume) await this.maybeSleepIfIdle(jobs);
  }

  /** Run one job: check, act, record. Updates state and the run log. */
  private async runJob(
    jobFile: JobFile,
    isResume: boolean,
    modelActions: PendingModelAction[],
    runNow: boolean,
  ): Promise<void> {
    const id = jobFile.job.id;
    this.runningJobs.add(id);
    this.checkingJobs.add(id);
    try {
      await executeScheduledJob(jobFile, isResume, runNow, {
        store: this.store,
        power: this.power,
        delivery: this.delivery,
        now: this.now,
        runCheck: (file) => this.runCheck(file),
        applyBackoff: (file, message) => this.applyBackoff(file, message),
        hasModelRunner: (file) =>
          file.job.action?.kind === 'agent_task'
            ? this.agentTask !== undefined
            : file.job.action?.kind === 'retitle' && this.retitle !== undefined,
        queueModelAction: (candidate) => modelActions.push(candidate),
      });
    } finally {
      this.checkingJobs.delete(id);
      this.runningJobs.delete(id);
    }
  }

  private async admitModelAction(
    candidate: PendingModelAction,
    onAttemptStarted: () => void,
  ): Promise<void> {
    const fresh = await this.store.load(candidate.jobFile.job.id);
    if (
      !fresh ||
      (!fresh.job.enabled && !candidate.runNow) ||
      (fresh.state.task_run !== null && !this.runningJobs.has(fresh.job.id))
    )
      return;
    const runner = fresh.job.action?.kind === 'agent_task' ? this.agentTask : this.retitle;
    if (!runner) {
      const error =
        fresh.job.action?.kind === 'agent_task'
          ? 'agent_task runner not wired (no host facade or backend pool)'
          : 'retitle runner not wired (no storage folder for this workspace)';
      await recordUnwiredActionRun(
        this.store,
        this.delivery,
        this.now,
        { ...fresh, state: candidate.jobFile.state },
        candidate.wasLate,
        error,
      );
      return;
    }
    await this.modelLane.run(candidate, fresh, runner, {
      onStart: () => {
        this.runningJobs.add(fresh.job.id);
        onAttemptStarted();
      },
      onFinish: () => this.runningJobs.delete(fresh.job.id),
      onError: (err) =>
        this.notifyLocal(`Forge jobs: ${fresh.job.name} failed: ${describeError(err)}`),
    });
  }

  /** D6: suspend again after a wake if a job asked to and nothing is busy. */
  private async maybeSleepIfIdle(jobs: readonly JobFile[]): Promise<void> {
    return sleepIfIdleIfRequested(this.busy, this.runningJobs, this.power, jobs);
  }

  /** Run the check. Returns the observation, whether it changed, and a summary. */
  private async runCheck(jobFile: JobFile) {
    return runJobCheck(this.getConfig, this.etagCache, this.llamacpp, jobFile);
  }

  /** Apply backoff after a failure: double the interval up to 24 h (B.3). */
  private async applyBackoff(jobFile: JobFile, message: string): Promise<void> {
    return applyJobBackoff(this.store, this.delivery, this.now, jobFile, message);
  }
}
