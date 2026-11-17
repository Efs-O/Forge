/**
 * `forge.sh notify`: one agent telling the owner something on Telegram.
 *
 * An agent that runs a long, unattended job (Claude Code, Codex, a scheduled
 * script) finishes or fails in a window that may hold no Telegram transport at
 * all, and `say` would spend a chat and a model turn to say one line. So this
 * route writes the same coalescing outbox item the job scheduler writes, and
 * the window holding the Telegram lease delivers it (`JobOutboxWatcher`).
 *
 * The key is `agent_<from>`, never a job id: `jobSlug` only ever produces
 * `[a-z0-9-]`, so `JobStore` deleting a job can never take an agent's pending
 * notify, and the reverse holds — a notify cannot shadow a job's item.
 *
 * A refusal is the point of this route as much as the queue is: with Telegram
 * off, or with `jobs.enabled` off so no window drains the folder, the item
 * would sit unreadable forever. The agent is told why, and nothing is written.
 */
import type { ForgeConfig } from '../config/types';
import { writeOutboxItem } from '../jobs/JobOutbox';
import { requireText, type AgentRouteFields } from './agentRouteFields';

/** One notify is a status line, not a transcript; the same cap `remote-notify` uses. */
export const AGENT_NOTIFY_MAX_CHARS = 4_000;

/** The outbox key for an agent's notify. `_` never appears in a generated job id (jobSlug), so a job's delete cannot remove it. */
export function agentNotifyKey(from: string): string {
  return `agent_${from}`;
}

export type AgentNotifyResult = { kind: 'queued' } | { kind: 'refused'; error: string };

/** Why this window's config would leave a notify undelivered, or undefined. */
export function notifyRefusal(config: Pick<ForgeConfig, 'remote' | 'jobs'>): string | undefined {
  if (config.remote?.enabled !== true || config.remote.telegram.enabled !== true) {
    return 'Telegram is off in this Forge (remote.enabled and remote.telegram.enabled), so nothing would deliver this. Nothing was queued.';
  }
  if (config.jobs?.enabled !== true) {
    return 'jobs.enabled is off in this Forge, so no window delivers the notify outbox. Nothing was queued.';
  }
  return undefined;
}

/** The owner-facing sink a window supplies: queue this text, or refuse with the reason. */
export function makeNotifyOwner(
  getConfig: () => ForgeConfig,
  outboxDir: string,
): (from: string, text: string) => Promise<AgentNotifyResult> {
  return async (from: string, text: string): Promise<AgentNotifyResult> => {
    const refusal = notifyRefusal(getConfig());
    if (refusal) return { kind: 'refused', error: refusal };
    await writeOutboxItem(outboxDir, agentNotifyKey(from), from, text, Date.now());
    return { kind: 'queued' };
  };
}

/** Parse the request and queue it: 200 with what the agent can now say, 409 with the reason. */
export async function handleAgentNotifyRoute(
  from: string,
  fields: AgentRouteFields,
  notifyOwner: (from: string, text: string) => Promise<AgentNotifyResult>,
): Promise<{ status: number; text: string }> {
  const text = requireText(fields, AGENT_NOTIFY_MAX_CHARS);
  const result = await notifyOwner(from, text);
  if (result.kind === 'refused') return { status: 409, text: result.error };
  return {
    status: 200,
    text: `Queued for the owner's Telegram. The Forge window holding the Telegram lease sends it; until then a newer notify from ${from} replaces it.`,
  };
}
