/**
 * `/jobs` and `/job <n|name> <action>` for a paired chat (B3).
 *
 * Split from `RemoteCommandHandler` like `RemotePowerCommands`: these two carry
 * state no other command does — a `/job <n> delete` must be confirmed before it
 * lands, and the confirmation is a second message (there is no button
 * affordance on `RemoteChannel`). The commands are a thin owner-facing surface
 * over the same `JobStore` the `manage_jobs` tool (B2) edits, so a job changed
 * on the phone and a job changed in a chat are the same files.
 *
 * `run` writes a `run_requests/<id>` marker the scheduler consumes on its next
 * tick, so a run requested from the Telegram window still runs in whichever
 * window holds the jobs lease. `approve` is the B5 `llamacpp_update` approval
 * and is not implementable until that phase; it answers with a clear "not yet"
 * rather than a silent no-op.
 */

import type { JobStore } from '../jobs/JobStore';
import type { JobFile } from '../jobs/jobSchema';
import { describeSchedule, formatWhen } from '../jobs/jobDescribe';
import { openDiscussChat } from '../jobs/jobDiscuss';
import { approveStaged } from '../jobs/actions/llamacppUpdate';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';

/** How long a `/job <n> delete` stays confirmable. Short: it is destructive. */
const CONFIRM_WINDOW_MS = 90_000;

interface PendingDelete {
  chatId: string;
  jobId: string;
  jobName: string;
  /** The job's `updated_at` when the confirmation was offered, so a job that is deleted and recreated with the same id in the window is not deleted by a stale confirmation. */
  updatedAt: number;
  expiresAt: number;
}

export interface RemoteJobContext {
  channel: RemoteChannel;
  host: ForgeHostFacade;
  signal: AbortSignal;
  store: JobStore;
  /** True when `jobs.enabled` in the active config. */
  jobsEnabled: boolean;
}

/**
 * Pending delete confirmations, keyed by `channel:chatId`.
 *
 * Module-level, like the `/sleep` pending map: per-process, self-expiring, and
 * meant to live only between two consecutive messages from one chat. A window
 * reload drops it, which is correct — a delete nobody confirmed must not
 * survive into a new session.
 */
const pendingDelete = new Map<string, PendingDelete>();

function keyOf(context: RemoteJobContext, chatId: string): string {
  return `${context.channel.name}:${chatId}`;
}

async function reply(context: RemoteJobContext, chatId: string, text: string): Promise<void> {
  await context.channel.send(chatId, text, { signal: context.signal });
}

/**
 * Handle `/jobs` and `/job`. Returns undefined when the command is neither, so
 * the caller falls through to the rest of the command map.
 */
export async function handleRemoteJobCommand(
  command: string | undefined,
  operands: readonly string[],
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteJobContext,
): Promise<RemoteInboundDisposition | undefined> {
  if (command === '/jobs') return handleJobsList(event, context);
  if (command === '/job') return handleJob(operands, event, context);
  return undefined;
}

/** `/jobs` — list the jobs, numbered. */
async function handleJobsList(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteJobContext,
): Promise<RemoteInboundDisposition> {
  if (!context.jobsEnabled) {
    await reply(
      context,
      event.chatId,
      'Forge: jobs are not enabled in this window (no `jobs:` block in config).',
    );
    return { kind: 'handled' };
  }
  const all = await context.store.loadAll();
  if (all.length === 0) {
    await reply(
      context,
      event.chatId,
      'Forge: no jobs are defined. Ask the agent to create one, or define a job file in ~/.forge/jobs/.',
    );
    return { kind: 'handled' };
  }
  const now = new Date();
  const lines = all.map((jf, index) => {
    const { job, state } = jf;
    const status = job.enabled ? 'enabled' : 'paused';
    const last = state.last_run_at === null ? 'never' : formatWhen(state.last_run_at, now);
    const outcome =
      state.last_run_at === null
        ? 'no runs yet'
        : state.consecutive_failures > 0
          ? `failing x${state.consecutive_failures}`
          : 'ok';
    const next =
      state.next_due_at === null
        ? 'not scheduled'
        : job.enabled
          ? `next ${formatWhen(state.next_due_at, now)}`
          : 'paused';
    return `${index + 1}. ${job.name} — ${status} · ${describeSchedule(job.schedule)} · last ${last} (${outcome}) · ${next}`;
  });
  await reply(
    context,
    event.chatId,
    `Forge: ${all.length} job(s):\n\n${lines.join('\n')}\n\nUse /job <n|name> pause|resume|run|delete|chat.`,
  );
  return { kind: 'handled' };
}

/** `/job <n|name> <action>` — act on one job. */
async function handleJob(
  operands: readonly string[],
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteJobContext,
): Promise<RemoteInboundDisposition> {
  if (!context.jobsEnabled) {
    await reply(context, event.chatId, 'Forge: jobs are not enabled in this window.');
    return { kind: 'handled' };
  }
  // The action is the final token; a trailing "confirm" belongs to delete
  // (handleDelete re-reads the raw text for it). Everything before the action
  // is the job reference, so a multi-word name like "/job Disk Monitor pause"
  // resolves "Disk Monitor" rather than misreading "Monitor" as the action.
  const lowered = operands.map((token) => token.toLowerCase());
  let actionTokens = operands;
  if (lowered.length > 0 && lowered[lowered.length - 1] === 'confirm') {
    actionTokens = operands.slice(0, -1);
  }
  const rawAction = actionTokens[actionTokens.length - 1];
  const ref = actionTokens.slice(0, -1).join(' ');
  const action = (rawAction ?? '').toLowerCase();
  if (!ref || !action) {
    await reply(
      context,
      event.chatId,
      'Forge: usage — /job <n|name> pause|resume|run|delete|chat. /jobs lists the jobs.',
    );
    return { kind: 'rejected', reason: 'usage: /job <n|name> pause|resume|run|delete|chat' };
  }
  if (action === 'approve') {
    // Approve a staged `llamacpp_update` (B5). The approve sets `switch_pending`
    // on the staged file; the scheduler (lease holder) performs the switch on
    // its next idle tick. It needs a job reference, so resolve the job first.
    const all = await context.store.loadAll();
    const match = resolveJob(all, ref);
    if (match.kind !== 'one') {
      await reply(context, event.chatId, `Forge: no single job matches "${ref}" to approve.`);
      return { kind: 'rejected', reason: `no job matches: ${ref}` };
    }
    const message = approveStaged(context.store.root, match.jobFile.job.id, Date.now());
    await reply(context, event.chatId, `Forge: ${message}`);
    return { kind: 'handled' };
  }
  if (
    action !== 'pause' &&
    action !== 'resume' &&
    action !== 'run' &&
    action !== 'delete' &&
    action !== 'chat'
  ) {
    await reply(
      context,
      event.chatId,
      `Forge: unknown action "${rawAction}" — use pause, resume, run, delete, or chat.`,
    );
    return { kind: 'rejected', reason: `unknown action: ${rawAction}` };
  }
  const all = await context.store.loadAll();
  const match = resolveJob(all, ref);
  if (match.kind === 'none') {
    await reply(context, event.chatId, `Forge: no job matches "${ref}". /jobs lists the ids.`);
    return { kind: 'rejected', reason: `no job matches: ${ref}` };
  }
  if (match.kind === 'ambiguous') {
    const names = match.candidates.map((jf) => `${jf.job.name} (${jf.job.id})`).join(', ');
    await reply(
      context,
      event.chatId,
      `Forge: "${ref}" is ambiguous — it matches: ${names}. Use the exact id or number.`,
    );
    return { kind: 'rejected', reason: `ambiguous: ${ref}` };
  }
  const jobFile = match.jobFile;
  switch (action) {
    case 'pause':
      await context.store.saveJob({ ...jobFile.job, enabled: false, updated_at: Date.now() });
      await reply(
        context,
        event.chatId,
        `Forge: paused "${jobFile.job.name}" [${jobFile.job.id}].`,
      );
      return { kind: 'handled' };
    case 'resume':
      await context.store.saveJob({ ...jobFile.job, enabled: true, updated_at: Date.now() });
      await reply(
        context,
        event.chatId,
        `Forge: resumed "${jobFile.job.name}" [${jobFile.job.id}].`,
      );
      return { kind: 'handled' };
    case 'chat': {
      // Open (or reuse) the job's discuss chat and seed it. Not activated: a
      // chat opened from the phone should not steal the foreground from
      // whatever the user is doing in the window.
      //
      // Caught here, not left to propagate: a failed open (chat limit reached,
      // a send error, a store error) would otherwise surface as a transport
      // failure and be redelivered up to three times, each attempt re-running
      // the open. A clear rejection is the right outcome for a non-transient
      // failure; the user can retry the command.
      try {
        await openDiscussChat(context.host, context.store, jobFile, false);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        await reply(
          context,
          event.chatId,
          `Forge: could not open the discuss chat for "${jobFile.job.name}" [${jobFile.job.id}].\n\n${detail}`,
        );
        return { kind: 'rejected', reason: `could not open discuss chat: ${detail}` };
      }
      await reply(
        context,
        event.chatId,
        `Forge: opened the discuss chat for "${jobFile.job.name}" [${jobFile.job.id}]. It is seeded with the job, its recent runs, and the last observation — send a message there to discuss it.`,
      );
      return { kind: 'handled' };
    }
    case 'run':
      await context.store.requestRun(jobFile.job.id);
      await reply(
        context,
        event.chatId,
        `Forge: run requested for "${jobFile.job.name}" [${jobFile.job.id}]. It runs on the next scheduler tick, in whichever window holds the jobs lease.`,
      );
      return { kind: 'handled' };
    case 'delete':
      return handleDelete(jobFile, event, context);
    default:
      await reply(context, event.chatId, 'Forge: unknown action.');
      return { kind: 'rejected', reason: 'unknown action' };
  }
}

/** `/job <n|name> delete` — needs a second, confirming message. */
async function handleDelete(
  jobFile: JobFile,
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  context: RemoteJobContext,
): Promise<RemoteInboundDisposition> {
  const key = keyOf(context, event.chatId);
  const flags = event.text
    .trim()
    .split(/\s+/)
    .map((token) => token.toLowerCase());
  if (flags.includes('confirm')) {
    const held = pendingDelete.get(key);
    pendingDelete.delete(key);
    if (!held || held.expiresAt < Date.now() || held.jobId !== jobFile.job.id) {
      return {
        kind: 'rejected',
        reason:
          'nothing to confirm — send /job <n|name> delete first (a confirmation expires after 90s)',
      };
    }
    // The job must be the SAME one the confirmation was offered for. If it was
    // deleted and recreated with the same id in the 90s window, its
    // `updated_at` differs and a stale confirmation must not delete the
    // replacement.
    if (jobFile.job.updated_at !== held.updatedAt) {
      return {
        kind: 'rejected',
        reason: `the job "${held.jobName}" changed or was removed — send /job <n|name> delete again to confirm the current one`,
      };
    }
    await context.store.delete(held.jobId);
    await reply(
      context,
      event.chatId,
      `Forge: deleted "${held.jobName}" [${held.jobId}]. Its definition, state, and run log are gone.`,
    );
    return { kind: 'handled' };
  }
  pendingDelete.set(key, {
    chatId: event.chatId,
    jobId: jobFile.job.id,
    jobName: jobFile.job.name,
    updatedAt: jobFile.job.updated_at,
    expiresAt: Date.now() + CONFIRM_WINDOW_MS,
  });
  await reply(
    context,
    event.chatId,
    `Forge: about to delete "${jobFile.job.name}" [${jobFile.job.id}]. Its definition, state, and run log will be removed.\n\nSend /job ${jobFile.job.id} delete confirm within 90 seconds to go ahead.`,
  );
  return { kind: 'handled' };
}

/** Resolve a job by number (1-based, as listed by /jobs), exact id, exact name, or unique substring. */
type JobMatch =
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: JobFile[] }
  | { kind: 'one'; jobFile: JobFile };

function resolveJob(all: readonly JobFile[], ref: string): JobMatch {
  const trimmed = ref.trim();
  // A bare number is the position in the /jobs list (1-based).
  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    const byNumber = all[index - 1];
    if (byNumber) return { kind: 'one', jobFile: byNumber };
    return { kind: 'none' };
  }
  const needle = trimmed.toLowerCase();
  const exact = all.find(
    (jf) => jf.job.id.toLowerCase() === needle || jf.job.name.toLowerCase() === needle,
  );
  if (exact) return { kind: 'one', jobFile: exact };
  const partial = all.filter(
    (jf) => jf.job.id.toLowerCase().includes(needle) || jf.job.name.toLowerCase().includes(needle),
  );
  if (partial.length === 0) return { kind: 'none' };
  if (partial.length === 1) return { kind: 'one', jobFile: partial[0]! };
  return { kind: 'ambiguous', candidates: partial };
}

/** Test seam: drops any delete confirmation this process is holding. */
export function resetPendingJobDeletes(): void {
  pendingDelete.clear();
}
