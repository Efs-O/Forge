import { writeOutboxItem } from './JobOutbox';
import type { Job } from './jobSchema';
import type { JobStore } from './JobStore';

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
   * Run the job's `on_change` for a change and deliver it. Returns how many
   * outbox items were delivered and whether a summarize is still pending (the
   * change was recorded but the model is busy, so the summary waits for idle).
   */
  async deliverForChange(
    job: Job,
    result: { observation: string | null; changed: boolean; summary: string },
  ): Promise<ChangeDelivery> {
    if (!result.changed) return { delivered: 0, summaryPending: false };
    if (job.on_change.kind === 'summarize') {
      // A summarize runs only when no turn is streaming, so it never fights a
      // live chat for the GPU. If busy, record the change and defer; the next
      // idle tick summarizes it.
      if (this.deps.busy() !== undefined) return { delivered: 0, summaryPending: true };
      const summary = await this.summarizeChange(job, result.observation ?? '');
      await this.deliver(job, summary);
      return { delivered: 1, summaryPending: false };
    }
    // notify: deliver the check's own summary.
    await this.deliver(job, result.summary);
    return { delivered: 1, summaryPending: false };
  }

  /**
   * Summarize any job whose change was recorded while a turn was streaming
   * (`summary_pending`), now that a tick has reached it. Runs only when idle.
   */
  async processPendingSummaries(): Promise<void> {
    if (this.deps.busy() !== undefined) return;
    const jobs = await this.deps.store.loadAll();
    for (const { job, state } of jobs) {
      if (!state.summary_pending) continue;
      try {
        const summary = await this.summarizeChange(job, state.last_observation ?? '');
        await this.deliver(job, summary);
        this.deps.store.patchState(job.id, { summary_pending: false });
      } catch {
        // A failed summary is not fatal: the change is already in the run log.
        this.deps.notifyLocal(`Forge: could not summarize job "${job.name}".`);
      }
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
