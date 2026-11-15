import { writeOutboxItem } from './JobOutbox';
import type { Job } from './jobSchema';
import type { JobStore } from './JobStore';
import { describeError } from '../util/describeError';
import { getLogger } from '../util/logger';

/**
 * Turning a check result into something the user actually sees (§B.4).
 *
 * Split out of `JobScheduler` because it is a separate concern with a separate
 * design section, not merely to shed lines: the scheduler decides *when* a job
 * runs, this decides *what the user is told and when they are told it*. The two
 * rules that live here are both about timing rather than scheduling — a
 * `summarize` must wait for an idle backend so it never fights a live chat for
 * the GPU, and every user-facing fact goes to the coalescing file outbox
 * because the window running the scheduler may not be the window holding the
 * Telegram transport.
 */
/** First retry delay for a failed pending summary; doubles per failure. */
const SUMMARY_RETRY_BASE_MS = 60_000;
/** The longest a failed pending summary waits between attempts. */
const SUMMARY_RETRY_MAX_MS = 6 * 60 * 60_000;

export interface JobDeliveryDeps {
  store: JobStore;
  /** The coalescing outbox directory (D2). */
  outboxDir: string;
  /** Show a VS Code toast in the scheduler window (no Telegram needed). */
  notifyLocal: (text: string) => void;
  /** The reason a turn is outstanding, or undefined when idle. */
  busy: () => string | undefined;
  /** Run a `summarize` prompt through the model (no tools). Returns the reply. */
  summarize: ((prompt: string) => Promise<string>) | undefined;
  /** The clock, in epoch ms. */
  now: () => number;
}

/** What delivering a change produced, for the run row and the state patch. */
export interface ChangeDelivery {
  /** How many outbox items were written for this run. */
  delivered: number;
  /** The change is recorded but its summary still waits for an idle backend. */
  summaryPending: boolean;
}

export class JobDelivery {
  constructor(private readonly deps: JobDeliveryDeps) {}

  /**
   * Deliver a user-facing fact for a job: a toast in the scheduler window (no
   * Telegram needed) and a coalesced outbox file for the Telegram lease holder
   * to deliver to the owner chat (D2). The outbox write is the durable record;
   * the toast is the local half when no Telegram window is around.
   */
  async deliver(job: Job, text: string): Promise<void> {
    const message = `Job "${job.name}": ${text}`;
    this.deps.notifyLocal(message);
    await writeOutboxItem(this.deps.outboxDir, job.id, job.name, message, this.deps.now());
  }

  /**
   * {@link deliver} for a run that must finish either way. Returns the run
   * row's `delivered` count: 1, or 0 with the error logged when the outbox
   * write failed. The toast has been shown by then; only Telegram missed it.
   */
  async tryDeliver(job: Job, text: string): Promise<number> {
    try {
      await this.deliver(job, text);
      return 1;
    } catch (error) {
      getLogger().warn(
        `[JobDelivery] job "${job.name}": report not delivered: ${describeError(error)}`,
      );
      return 0;
    }
  }

  /** Deliver a fact for a job by id (callers that do not hold the `Job`). */
  async deliverForJob(jobId: string, text: string): Promise<void> {
    const jobFile = await this.deps.store.load(jobId);
    if (!jobFile) {
      this.deps.notifyLocal(`Forge: ${text}`);
      return;
    }
    await this.deliver(jobFile.job, text);
  }

  /**
   * What the job wants NOW, re-read from disk. A check and a summary are both
   * slow, and the owner can change their mind while either runs.
   *
   * A `check: none` job reports a change on every tick because nothing can
   * observe anything (see `checks/runCheck.ts`). Delivering that is a live
   * notification each cycle: the lab's student created one such job and got a
   * phone ping every tick. `changed` stays true so an `agent_task` action still
   * runs on schedule; only the delivery is suppressed. Mute or restore a job's
   * notifications with `on_change`, never by inventing a check.
   *
   * `keep` is the paused case: audit A8 says a paused job keeps its recorded
   * change pending until it is resumed, so a pause must never clear it. Only
   * `none` or a deleted job clears.
   */
  private async liveIntent(
    jobId: string,
  ): Promise<
    { kind: 'deliver'; job: Job } | { kind: 'keep' } | { kind: 'clear'; definitionGone: boolean }
  > {
    const current = await this.deps.store.load(jobId);
    if (!current) return { kind: 'clear', definitionGone: true };
    if (current.job.check.kind === 'none') return { kind: 'clear', definitionGone: false };
    if (!current.job.enabled) return { kind: 'keep' };
    return { kind: 'deliver', job: current.job };
  }

  /**
   * The job's CURRENT definition when it still wants a CHECK notification, or
   * undefined when the owner switched its check to `none`, paused it, or deleted
   * it. Callers that report a fact about the check — not about an action, which
   * reports under `action.report` regardless — must ask before delivering.
   */
  async liveCheckTarget(jobId: string): Promise<Job | undefined> {
    const intent = await this.liveIntent(jobId);
    return intent.kind === 'deliver' ? intent.job : undefined;
  }

  /**
   * Run the job's `on_change` for a change and deliver it. Returns how many
   * outbox items were delivered and whether a summarize is still pending (the
   * change was recorded but the model is busy, so the summary waits for idle).
   */
  async deliverForChange(
    job: Job,
    result: { observation: string | null; changed: boolean; summary: string },
  ): Promise<ChangeDelivery> {
    if (!result.changed) return { delivered: 0, summaryPending: false };
    // The definition reaching here can predate the check that produced this
    // result, so it is re-read before anything is said: a job switched to
    // `none`, paused, or deleted while the check ran must not notify.
    const target = await this.liveIntent(job.id);
    if (target.kind !== 'deliver') {
      // Paued keeps the change pending for the resume (A8); `none`/deleted has
      // nothing left to keep.
      return { delivered: 0, summaryPending: target.kind === 'keep' };
    }
    const live = target.job;
    if (live.on_change.kind === 'summarize') {
      // A summarize runs only when no turn is streaming, so it never fights a
      // live chat for the GPU. If busy, record the change and defer; the next
      // idle tick summarizes it.
      if (this.deps.busy() !== undefined) return { delivered: 0, summaryPending: true };
      const summary = await this.summarizeChange(live, result.observation ?? '');
      // The owner can change their mind while the model writes this.
      const after = await this.liveIntent(job.id);
      if (after.kind !== 'deliver') {
        return { delivered: 0, summaryPending: after.kind === 'keep' };
      }
      await this.deliver(after.job, summary);
      return { delivered: 1, summaryPending: false };
    }
    // notify: deliver the check's own summary.
    await this.deliver(live, result.summary);
    return { delivered: 1, summaryPending: false };
  }

  /**
   * Summarize any job whose change was recorded while a turn was streaming
   * (`summary_pending`), now that a tick has reached it. Runs only when idle.
   *
   * A paused job does no model work: its change stays pending until it is
   * resumed (audit A8). A failed attempt keeps the change pending and backs
   * off, doubling from a minute to six hours, instead of retrying every tick;
   * the first failure is reported once through the outbox so a phone-only
   * user learns of it, and the eventual summary says it recovered (audit A9).
   */
  async processPendingSummaries(): Promise<void> {
    if (this.deps.busy() !== undefined) return;
    const now = this.deps.now();
    const jobs = await this.deps.store.loadAll();
    for (const { job, state } of jobs) {
      if (!state.summary_pending || !job.enabled) continue;
      if (job.check.kind === 'none') {
        // A change recorded before this suppression existed, or by a job since
        // switched to `none`: there is nothing to summarise, so the flag is
        // cleared rather than delivered on every idle tick.
        this.deps.store.patchState(job.id, {
          summary_pending: false,
          summary_failures: 0,
          summary_retry_at: null,
        });
        continue;
      }
      if (state.summary_retry_at !== null && now < state.summary_retry_at) continue;
      let summary: string;
      try {
        summary = await this.summarizeChange(job, state.last_observation ?? '');
      } catch (err) {
        const after = await this.liveIntent(job.id);
        if (after.kind === 'clear') {
          // Switched to `none`, or deleted, while the summary was attempted:
          // nothing is left to retry, and no failure notice is owed. A deleted
          // job owns no state file, so there is nothing to clear — patching one
          // would revive the file `delete()` removed.
          if (!after.definitionGone) {
            this.deps.store.patchState(job.id, {
              summary_pending: false,
              summary_failures: 0,
              summary_retry_at: null,
            });
          }
          continue;
        }
        if (after.kind === 'keep') {
          // Paused mid-attempt: the change stays pending for the resume (A8),
          // and a paused job owes no failure notice.
          continue;
        }
        const failures = state.summary_failures + 1;
        const delay = Math.min(SUMMARY_RETRY_MAX_MS, SUMMARY_RETRY_BASE_MS * 2 ** (failures - 1));
        this.deps.store.patchState(job.id, {
          summary_failures: failures,
          summary_retry_at: now + delay,
        });
        if (failures === 1) {
          await this.deliver(
            after.job,
            `could not summarize the recorded change (${(err as Error).message}); ` +
              'retrying with backoff.',
          );
        }
        continue;
      }
      const afterSuccess = await this.liveIntent(job.id);
      if (afterSuccess.kind === 'clear') {
        // The owner stopped the notifications while the model wrote this
        // summary. The answer exists; it is simply not sent. A deleted job owns
        // no state file, so there is nothing here to clear.
        if (!afterSuccess.definitionGone) {
          this.deps.store.patchState(job.id, {
            summary_pending: false,
            summary_failures: 0,
            summary_retry_at: null,
          });
        }
        continue;
      }
      if (afterSuccess.kind === 'keep') {
        // Paused while the model wrote it: not sent, and still pending for the
        // resume (A8) — clearing here would lose the recorded change.
        continue;
      }
      const recovered = state.summary_failures > 0 ? 'summary (recovered): ' : '';
      await this.deliver(afterSuccess.job, `${recovered}${summary}`);
      this.deps.store.patchState(job.id, {
        summary_pending: false,
        summary_failures: 0,
        summary_retry_at: null,
      });
    }
  }

  /**
   * Summarize a recorded change with a no-tools model call. The prompt is built
   * from the job name, the typed observation, and the requested focus — no
   * free-form user prompt (B.5).
   */
  private async summarizeChange(job: Job, observation: string): Promise<string> {
    if (!this.deps.summarize) return 'summarize unavailable (no model wired)';
    const focus = job.on_change.kind === 'summarize' ? job.on_change.focus : ['release_notes'];
    const prompt =
      `Summarize what changed for the job "${job.name}". ` +
      `Focus: ${focus.join(', ')}. ` +
      `The check's observation is:\n${observation}\n\n` +
      'Write a short, plain summary of the change and why it matters. ' +
      'If the observation is empty or you cannot tell, say so.';
    const reply = await this.deps.summarize(prompt);
    return reply.trim().slice(0, 500);
  }
}
