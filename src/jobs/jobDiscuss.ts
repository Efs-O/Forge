/**
 * The job discuss chat (B.6): open (or reuse) the chat a job's discussion lives
 * in, and seed it with the job definition, the last 10 run rows, and the last
 * observation. One shared path for every entry point — `manage_jobs
 * {action:"discuss"}` (B2) and the Telegram `/job <n> chat` (B4) — so the seed
 * and the conversation-id persistence can never diverge between surfaces.
 *
 * The chat is opened on demand (D3), not appended to by every run. Its
 * conversation id is persisted in `state.conversation_id`, so the next entry
 * point reuses the same chat. The seed is capped at 4000 characters: a job with
 * a long observation must not blow the context of the chat it opens.
 */

import type { JobStore } from './JobStore';
import type { JobFile, RunRow } from './jobSchema';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';

/** The result of opening a job's discuss chat. */
export interface DiscussResult {
  /** The conversation id the discussion is in (existing or newly created). */
  conversationId: string;
  /** True when a new conversation was created; false when the existing one was reused. */
  created: boolean;
}

/**
 * Restore the job's existing conversation, or create a new one when the stored
 * id no longer resolves. Shared by {@link openDiscussChat} and the agent-task
 * runner (phase 3) so the restore-or-create fallback can never diverge between
 * the two entry points. Persists the id so the next entry point reuses the chat.
 */
export async function resolveJobConversation(
  host: ForgeHostFacade,
  store: JobStore,
  jobFile: JobFile,
  activate: boolean,
): Promise<DiscussResult> {
  const { job, state } = jobFile;
  let conversationId: string | null = state.conversation_id;
  let created = false;
  if (conversationId) {
    try {
      await host.restoreConversation(conversationId, { activate });
    } catch {
      // The conversation no longer exists; fall through and create a new one.
      conversationId = null;
    }
  }
  if (!conversationId) {
    const newConversation = await host.createConversation({ activate });
    conversationId = newConversation.id;
    created = true;
  }
  // Persist the conversation id so the next entry point reuses the same chat.
  // patchState reads and writes with no await between them, so a run that
  // finishes in the meantime is not clobbered (the lost-update race a
  // load-then-saveState pair has).
  store.patchState(job.id, { conversation_id: conversationId });
  return { conversationId, created };
}

/**
 * Open (or reuse) the job's discuss chat and seed it. `activate` controls
 * whether the conversation is brought to the foreground: the sidebar entry
 * point activates it, the Telegram entry point does not (opening a chat should
 * not steal the foreground from whatever the user is doing in the window).
 *
 * Refuses while a task run is in flight (`task_run` set): a seed sent mid-run
 * would be a second turn in the same conversation (AC12).
 */
export async function openDiscussChat(
  host: ForgeHostFacade,
  store: JobStore,
  jobFile: JobFile,
  activate: boolean,
): Promise<DiscussResult> {
  const { job, state } = jobFile;
  if (state.task_run) {
    throw new Error(
      `Job "${job.name}" is running; its chat shows the turn live. ` +
        'Try again once it finishes.',
    );
  }
  const { conversationId, created } = await resolveJobConversation(host, store, jobFile, activate);
  const seed = buildDiscussSeed(jobFile, await store.readRuns(job.id));
  await host.send(conversationId, seed);
  return { conversationId, created };
}

/** Build the discuss-chat seed (B.6): the job, last 10 run rows, last observation. */
export function buildDiscussSeed(jobFile: JobFile, runs: RunRow[]): string {
  const { job, state } = jobFile;
  const recent = runs.slice(-10);
  const runLines = recent.length
    ? recent.map(
        (row) =>
          `- ${new Date(row.at).toLocaleString()}: ${row.outcome}` +
          `${row.changed ? ' (changed)' : ''}${row.late ? ' (late)' : ''} — ${row.summary}`,
      )
    : ['(no runs yet)'];
  const parts = [
    `Job "${job.name}" [${job.id}]`,
    '',
    'Definition:',
    JSON.stringify(job, null, 2),
    '',
    `Last observation: ${state.last_observation ?? '(none yet)'}`,
    '',
    `Last ${recent.length} run(s):`,
    ...runLines,
    '',
    'The user wants to discuss this job.',
  ];
  let seed = parts.join('\n');
  if (seed.length > 4000) {
    const tail = '\n\nThe user wants to discuss this job.';
    seed = parts.join('\n').slice(0, 4000 - tail.length) + tail;
  }
  return seed;
}
