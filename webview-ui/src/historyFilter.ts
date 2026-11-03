/**
 * The sessions panel's display decisions that need no DOM: what a row's title
 * is, who its badge names, what a job row's status is, and what the search box
 * leaves in. Pure, so each rule is asserted directly rather than through a
 * render — the badge rules in particular are the ones a future change is most
 * likely to get wrong, because they read fields that are often absent.
 */
import type { TitleSource } from '../../src/sidebar/conversationTitle';
import type { JobPanelMeta } from '../../src/sidebar/messageBridge';
import type { RemoteOriginChannel } from '../../src/remote/remoteInboundSchema';

/** The agents the bus can start a chat, keyed by the name the bus writes. */
const KNOWN_AGENT_LABELS: ReadonlyMap<string, string> = new Map([
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['copilot', 'Copilot'],
]);

/** A `<agent>: ` prefix that is the sender's name rather than part of the name. */
const AGENT_TITLE_PREFIX = /^(claude|codex|copilot):\s*/i;

/** The small outlined label beside a row: who this chat is answering, or `You`. */
export interface RowBadge {
  label: string;
  /**
   * `agent` takes the badge colour, `you` the quiet description colour. A chat
   * bound to a phone is `agent` too: the colour marks "this was not opened at
   * this machine", not "a model wrote it".
   */
  kind: 'agent' | 'you';
  /** The agent class the badge's colour comes from; absent for `You`. */
  agentClass?: string;
  /** Only where the label could be misread: a channel badge says what is bound, not how the chat began. */
  tooltip?: string;
}

/** The fields a row needs to name its sender — an open tab or a closed chat. */
export interface ChatProvenance {
  title: string;
  title_source?: TitleSource;
  origin_agent?: string;
  origin_channel?: RemoteOriginChannel;
}

/** A chat's title and label: the prefix an old bus chat was named with is not part of its name. */
export function chatRowView(item: ChatProvenance): { title: string; badge: RowBadge } {
  if (item.origin_agent) {
    const name = item.origin_agent.trim();
    const known = KNOWN_AGENT_LABELS.get(name.toLowerCase());
    // An unfamiliar bus peer keeps the name it sent. `You` would be a lie: a
    // person did not open this chat, and a silent badge would make it look like
    // the seven Claude chats beside it.
    return {
      title: item.title,
      badge: known
        ? { label: known, kind: 'agent', agentClass: `history-row-badge-${known.toLowerCase()}` }
        : { label: name, kind: 'agent' },
    };
  }
  const match = AGENT_TITLE_PREFIX.exec(item.title);
  const prefixLabel = match ? KNOWN_AGENT_LABELS.get(match[1]!.toLowerCase()) : undefined;
  // Chats written before `title_source` existed carry no field, and neither do
  // archive rows rebuilt from session logs — insisting on `prompt` there would
  // leave every old agent chat wearing the prefix this change exists to remove.
  // A name a person typed (`user`) or the retitle job gave (`auto`) is shown
  // exactly as written, prefix and all: nobody but a person chose that text.
  if (prefixLabel && match && item.title_source !== 'user' && item.title_source !== 'auto') {
    return {
      title: item.title.slice(match[0].length),
      badge: {
        label: prefixLabel,
        kind: 'agent',
        agentClass: `history-row-badge-${prefixLabel.toLowerCase()}`,
      },
    };
  }
  // A chat bound to a phone conversation is not `You` — nobody at this machine
  // opened it — and it is not an agent chat either, so it names the channel
  // rather than a model. The tooltip says what the badge actually means: a row
  // a person picked with `/chat` is bound too, so the badge may not claim the
  // phone started it. An unknown channel (`fake` is the test transport's) falls
  // through to `You`, because nothing here proves otherwise.
  if (item.origin_channel === 'telegram' || item.origin_channel === 'whatsapp') {
    const channel = item.origin_channel;
    const label = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
    return {
      title: item.title,
      badge: {
        label,
        kind: 'agent',
        agentClass: `history-row-badge-${channel}`,
        tooltip: `Bound to a ${label} chat`,
      },
    };
  }
  return { title: item.title, badge: { label: 'You', kind: 'you' } };
}

/** Everything a job row says out loud, as one string to search. */
export function jobSearchText(job: JobPanelMeta): string {
  // The `2h ago` wording is left out on purpose: it moves with the clock, so a
  // match on it would be a match the same search misses tomorrow.
  return [
    job.name,
    job.lastOutcomeLabel,
    job.lastRun ? `${job.lastRun.outcome} ${job.lastRun.detail}` : '',
  ]
    .join('\n')
    .toLowerCase();
}

/**
 * The rows a query leaves, in the order the host gave them. Empty query: all
 * of them.
 *
 * A row is kept when the text typed answers to its title, to the badge beside
 * it, or to `contentMatchIds` — the ids the host reported for the text inside
 * the conversations. The last is deliberately a set the caller brings rather
 * than text this file holds: the webview never carries the saved transcripts,
 * so only the host can say which chats contain a phrase, and this file stays
 * the one owner of what a row is searchable by.
 */
export function filterChatRows<T extends ChatProvenance & { id?: string }>(
  rows: readonly T[],
  query: string,
  contentMatchIds?: ReadonlySet<string>,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...rows];
  // The stored title is searched, not the displayed one: an old `Claude: …` row
  // still answers to `claude`, and a new one whose badge says Claude answers to
  // its own name.
  return rows.filter(
    (row) =>
      row.title.toLowerCase().includes(needle) ||
      chatRowView(row).badge.label.toLowerCase().includes(needle) ||
      (contentMatchIds !== undefined && row.id !== undefined && contentMatchIds.has(row.id)),
  );
}

/** The jobs a query leaves. Name and last-outcome text, as the plan fixes them. */
export function filterJobRows(jobs: readonly JobPanelMeta[], query: string): JobPanelMeta[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...jobs];
  return jobs.filter((job) => jobSearchText(job).includes(needle));
}

/**
 * The four states a job row can show.
 *
 * `running` is this window's own streaming marker, not the store's: only the
 * webview knows whether a turn is live in front of the person reading it.
 * `none` covers both "no runs yet" and "the last run was skipped" — nothing
 * went out wrong and nothing went out right, so the dot stays hollow.
 */
export type JobRowStatus = 'running' | 'ok' | 'failing' | 'none';

/** A job's row state, from the store's numbers alone — never from label text. */
export function jobStatusOf(job: JobPanelMeta, running: boolean): JobRowStatus {
  if (running) return 'running';
  // The streak count, because that is what `failing ×N` means: a job that
  // failed once and has not run since is failing, one whose last run was
  // skipped is not.
  if (job.consecutiveFailures > 0) return 'failing';
  if (!job.lastRun) return 'none';
  if (job.lastRun.outcome === 'failed') return 'failing';
  return job.lastRun.outcome === 'ok' ? 'ok' : 'none';
}

/** Failing jobs, the number the Jobs tab shows in the error colour. */
export function failingJobCount(jobs: readonly JobPanelMeta[]): number {
  return jobs.filter((job) => jobStatusOf(job, false) === 'failing').length;
}

/** What the panel says when the search box has typed more than this tab has. */
export function noMatchMessage(query: string): string {
  return `Nothing matches "${query.trim()}".`;
}
