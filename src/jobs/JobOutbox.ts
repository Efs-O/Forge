import { randomUUID } from 'crypto';
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
export function defaultOutboxDir(home: string = os.homedir()): string {
  return path.join(home, '.forge', 'jobs', 'outbox');
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

/**
 * A claim: this module's own hand-off file, and one no reader mistakes for an
 * item. `readOutboxItems` only takes names ending in `.json`, and a claim ends
 * in its token, so it is invisible to a drain by construction; the explicit
 * pattern below keeps that deliberate rather than a side effect of the suffix.
 */
function claimPathFor(dir: string, jobId: string, token: string): string {
  return `${itemPath(dir, jobId)}.claim-${token}`;
}
const CLAIM_PATTERN = /\.json\.claim-[0-9a-f-]{36}$/u;

/** How long a claim can outlive the delivery that made it. */
export const CLAIM_STALE_MS = 30 * 60_000;

async function unlinkQuiet(file: string): Promise<void> {
  await fs.promises.unlink(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

/** Hand a claimed file back to the pending set. `link` never replaces, so a
 *  change newer still, written after the claim, wins instead of being clobbered. */
async function restoreClaim(claim: string, file: string): Promise<void> {
  try {
    await fs.promises.link(claim, file);
    await fs.promises.unlink(claim);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    await unlinkQuiet(claim);
  }
}

/**
 * Delete a job's pending item after it has been delivered.
 *
 * `expectedChangedAt` makes this a compare-and-delete, and the watcher must
 * pass it. Delivery is not instantaneous: the scheduler can write a NEWER
 * change for the same job between the moment the watcher handed the text to the
 * transport and the moment it unlinks. Because coalescing keeps exactly one
 * file per job, that newer change lands on the very file about to be removed,
 * and a blind unlink would drop a change nothing counted — the one outcome the
 * outbox exists to prevent. When the file on disk no longer carries the
 * `changed_at` that was delivered, the delete is skipped and the next drain
 * sends the newer text.
 *
 * The compare and the claim are one step now. The old form read the file, then
 * unlinked it, and a newer change landing between those two awaits was removed
 * with it - the one loss the outbox exists to prevent, and a window a slow
 * transport made real. Renaming first makes the hand-off atomic: whatever is
 * pending at the moment of the claim is what this delivery settles, and a change
 * that arrives after it lands on a fresh file the claim never touches.
 *
 * Omitting `expectedChangedAt` deletes unconditionally: that is for a caller
 * discarding an item outright (a deleted job), not for a delivery.
 */
export async function deleteOutboxItem(
  dir: string,
  jobId: string,
  expectedChangedAt?: number,
): Promise<void> {
  const file = itemPath(dir, jobId);
  if (expectedChangedAt === undefined) {
    await unlinkQuiet(file);
    return;
  }
  const claim = claimPathFor(dir, jobId, randomUUID());
  try {
    await fs.promises.rename(file, claim);
  } catch (err) {
    // Nothing pending, or another pass already claimed it: this delivery has
    // nothing left to settle either way.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  // `rename` carries the source's mtime, and a pending item can be far older
  // than the delivery that picks it up - no window open for an hour, a slow
  // transport. Stamp the claim now, or a reclaim pass reads the item's age,
  // judges this in-flight claim stale, hands it back to the pending set, and
  // the same change reaches its chat twice.
  try {
    await fs.promises.utimes(claim, new Date(), new Date());
  } catch (err) {
    // Already gone: a reclaim pass handed it back, so this delivery has
    // nothing left to settle either way.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return;
  }
  let claimed: OutboxItem | undefined;
  try {
    claimed = JSON.parse(await fs.promises.readFile(claim, 'utf8')) as OutboxItem;
  } catch {
    claimed = undefined;
  }
  if (claimed && claimed.changed_at === expectedChangedAt) {
    await unlinkQuiet(claim);
    return;
  }
  // Newer than what was delivered, or bytes no writer owns any more: give them
  // back rather than drop them. An unreadable file is one the next drain skips
  // exactly as this one did, so restoring it costs nothing and keeps its bytes.
  await restoreClaim(claim, file);
}

/**
 * Reclaim claims left behind by a delivery that died between the claim and the
 * settle, and drop the ones nothing can settle. Called by the drain before it
 * reads the pending set.
 *
 * A claim is made only once the text reached an owner chat, so an orphan is
 * bytes already delivered: it goes back to the pending set only when nothing
 * newer is waiting there, and is dropped otherwise. Without this, a window that
 * died mid-delivery would strand its claim and with it the job's newest change.
 *
 * Delivery is at-least-once, and this is where the repeat comes from: an orphan
 * whose text did reach a chat is restored and sent again. Losing a change is
 * the outcome the outbox exists to prevent, so the repeat is the right side to
 * err on. One known cost: a `writeOutboxItem` landing while a newer item is
 * claimed cannot see the claimed file, so it restarts `earlier_count` and
 * `first_undelivered_at`. The newest text still wins; only the count is off.
 */
export async function reclaimOutboxClaims(
  dir: string,
  now: number = Date.now(),
  olderThanMs: number = CLAIM_STALE_MS,
): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  let touched = 0;
  for (const name of entries) {
    if (!CLAIM_PATTERN.test(name)) continue;
    const claim = path.join(dir, name);
    const written = await fs.promises.stat(claim).then(
      (stat) => stat.mtimeMs,
      () => 0,
    );
    if (now - written < olderThanMs) continue;
    await restoreClaim(claim, path.join(dir, name.replace(/\.claim-[0-9a-f-]{36}$/u, '')));
    touched += 1;
  }
  return touched;
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
    // A claim is a delivery's hand-off file, not a pending item: it is read by
    // the delivery that made it, never by a drain. Named this way on purpose, so
    // the suffix test cannot be satisfied by a job id that happens to contain it.
    if (!entry.isFile() || !entry.name.endsWith('.json') || CLAIM_PATTERN.test(entry.name))
      continue;
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
