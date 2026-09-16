import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomicSync } from '../util/atomicWrite';

/**
 * The coalescing file outbox (D2).
 *
 * The job scheduler runs in whichever window holds the `jobs-scheduler` lease,
 * which may not be the window that holds the Telegram lease. A job notification
 * cannot therefore call the remote sink directly — the remote outbox is held in
 * memory by the Telegram window, and a different window's `notify()` never
 * reaches it (the sink drops a conversation-less event).
 *
 * Instead the scheduler writes one file per job here, and the window holding
 * the Telegram lease watches this directory and delivers each item to the
 * owner chat. Coalescing is automatic: a job has at most one pending file, a
 * new change replaces the text and bumps a count, and an item that has been
 * sitting for more than 24 h is delivered as a count, not a flood of messages.
 *
 * All writes are atomic (`writeFileAtomicSync`): the Telegram watcher reads
 * these files while the scheduler writes them, so a torn read must be
 * impossible.
 */

/** One pending notification for a job. At most one file per job id. */
export interface OutboxItem {
  /** The job id (also the file name). */
  job_id: string;
  /** The job's display name, used by the stale-count message. */
  name: string;
  /** The newest message, already formatted by the scheduler. */
  text: string;
  /** Epoch ms of the newest change. */
  changed_at: number;
  /** How many earlier changes were coalesced away (superseded). */
  earlier_count: number;
  /** Epoch ms of the oldest still-undelivered change. */
  first_undelivered_at: number;
}

/** An item sitting longer than this is delivered as a count, never as text. */
export const OUTBOX_STALE_MS = 24 * 60 * 60_000;

/** The default outbox directory: `~/.forge/jobs/outbox`. */
export function defaultOutboxDir(): string {
  return path.join(os.homedir(), '.forge', 'jobs', 'outbox');
}

function itemPath(dir: string, jobId: string): string {
  // The job id is a slug (jobSchema enforces [A-Za-z0-9._-]+), so it is safe as
  // a file name. Defend anyway: a crafted id must not escape the directory.
  // Strip path separators first, then collapse runs of dots so `..` cannot
  // survive into the file name.
  const safe = jobId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  return path.join(dir, `${safe}.json`);
}

/** Read one job's pending item, or undefined when there is none. */
export async function readOutboxItem(dir: string, jobId: string): Promise<OutboxItem | undefined> {
  try {
    const raw = await fs.promises.readFile(itemPath(dir, jobId), 'utf8');
    return JSON.parse(raw) as OutboxItem;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Write (or coalesce) a job's pending item.
 *
 * When an item is already pending, the new change supersedes it: the text is
 * replaced with the newest, `earlier_count` is bumped, and `first_undelivered_at`
 * is preserved (the item's age is measured from the oldest undelivered change).
 * When nothing is pending, a fresh item starts the count at zero.
 */
export async function writeOutboxItem(
  dir: string,
  jobId: string,
  name: string,
  text: string,
  now: number,
): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true });
  const existing = await readOutboxItem(dir, jobId).catch(() => undefined);
  const item: OutboxItem = {
    job_id: jobId,
    name,
    text,
    changed_at: now,
    earlier_count: existing ? existing.earlier_count + 1 : 0,
    first_undelivered_at: existing ? existing.first_undelivered_at : now,
  };
  writeFileAtomicSync(itemPath(dir, jobId), JSON.stringify(item, null, 2));
}

/** Delete a job's pending item after it has been delivered. */
export async function deleteOutboxItem(dir: string, jobId: string): Promise<void> {
  await fs.promises.unlink(itemPath(dir, jobId)).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

/** Every pending item, oldest first. An unreadable file is skipped, not fatal. */
export async function readOutboxItems(dir: string): Promise<OutboxItem[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const items: OutboxItem[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const raw = await fs.promises.readFile(path.join(dir, entry.name), 'utf8').catch(() => null);
    if (!raw) continue;
    try {
      items.push(JSON.parse(raw) as OutboxItem);
    } catch {
      // A torn or corrupt item is skipped; the next write replaces it.
    }
  }
  return items.sort((a, b) => a.first_undelivered_at - b.first_undelivered_at);
}

/**
 * Render the text to send for a pending item.
 *
 * Fresh items (under 24 h) send the newest message, with a line naming how many
 * earlier changes were coalesced. A stale item (over 24 h) sends only a count —
 * the messages it coalesced are no longer individually meaningful, and a flood
 * is exactly what the outbox exists to prevent.
 */
export function renderOutboxMessage(item: OutboxItem, now: number): string {
  const total = item.earlier_count + 1;
  if (now - item.first_undelivered_at > OUTBOX_STALE_MS) {
    return `Job "${item.name}": ${total} change${total === 1 ? '' : 's'} while you were away — open the job to catch up.`;
  }
  if (item.earlier_count > 0) {
    return `${item.text}\n(+${item.earlier_count} earlier change${item.earlier_count === 1 ? '' : 's'} coalesced)`;
  }
  return item.text;
}
