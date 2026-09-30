import type { CheckContext, CheckResult } from './checkTypes';
import type { HfDiscussionCheck } from '../jobSchema';

/**
 * `hf_discussion`: watch a Hugging Face discussion thread (a model, dataset or
 * space discussion or PR). One gated, ETag-cached fetch of the public API; a
 * new comment, a status change (open/closed/merged) or any other new event is
 * a change; an edit to an existing comment is not. Lets an `agent_task` read the thread only on days
 * it moved, instead of running a model turn daily to find nothing.
 *
 * The observation is a stable JSON string of the status, event count and the
 * newest event (who, when, a bounded excerpt) — enough for the agent's prompt
 * to say what moved without refetching blind.
 */

/** A bounded excerpt, so a long comment cannot blow the run log or the prompt. */
const MAX_EXCERPT_CHARS = 300;

const API_SEGMENT: Record<HfDiscussionCheck['repo_type'], string> = {
  model: 'models',
  dataset: 'datasets',
  space: 'spaces',
};

interface HfEvent {
  id?: unknown;
  type?: unknown;
  createdAt?: unknown;
  author?: { name?: unknown };
  data?: { latest?: { raw?: unknown } };
}

interface HfDiscussion {
  status?: unknown;
  title?: unknown;
  events?: unknown;
  error?: unknown;
}

export async function hfDiscussionCheck(
  check: HfDiscussionCheck,
  lastObservation: string | null,
  ctx: CheckContext,
): Promise<CheckResult> {
  // A check built directly (not through the schema) has no repo_type; the
  // schema default is `model`.
  const segment = API_SEGMENT[check.repo_type ?? 'model'];
  const url = `https://huggingface.co/api/${segment}/${check.repo}/discussions/${check.discussion_number}`;
  const result = await ctx.fetch(url);

  if (result.notModified) {
    return { observation: lastObservation, changed: false, summary: 'discussion unchanged' };
  }

  const thread = JSON.parse(result.body) as HfDiscussion;
  if (typeof thread.status !== 'string' || !Array.isArray(thread.events)) {
    throw new Error(
      `Forge: could not read discussion ${check.discussion_number} in ${check.repo}: ${
        typeof thread.error === 'string' ? thread.error : 'no status/events in response'
      }`,
    );
  }
  const events = thread.events as HfEvent[];
  const last = events.at(-1);
  const lastEvent = last
    ? {
        id: typeof last.id === 'string' ? last.id : '',
        type: typeof last.type === 'string' ? last.type : 'unknown',
        author: typeof last.author?.name === 'string' ? last.author.name : 'unknown',
        at: typeof last.createdAt === 'string' ? last.createdAt : '',
        excerpt:
          typeof last.data?.latest?.raw === 'string'
            ? last.data.latest.raw.slice(0, MAX_EXCERPT_CHARS)
            : '',
      }
    : null;
  const observation = JSON.stringify({
    status: thread.status,
    title: typeof thread.title === 'string' ? thread.title : '',
    events: events.length,
    last_event: lastEvent,
  });
  // The first run only records a baseline; it never reports "changed" (B.2).
  // Compare the structural fields, not the excerpt: an edit to the newest
  // comment rewrites its text but is not new activity.
  const key = (obs: string): string => {
    const o = JSON.parse(obs) as { status?: string; events?: number; last_event?: { id?: string } };
    return `${o.status}|${o.events}|${o.last_event?.id ?? ''}`;
  };
  const changed = lastObservation !== null && key(observation) !== key(lastObservation);
  const when = lastEvent
    ? `, last ${lastEvent.type} by ${lastEvent.author} at ${lastEvent.at}`
    : '';
  return {
    observation,
    changed,
    summary: `discussion #${check.discussion_number} is ${thread.status}, ${events.length} events${when}`,
  };
}
