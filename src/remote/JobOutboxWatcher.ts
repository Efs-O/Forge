import * as fs from 'fs';
import { deleteOutboxItem, readOutboxItems, renderOutboxMessage } from '../jobs/JobOutbox';

/**
 * Watches the jobs outbox directory and delivers each pending item to the
 * owner chat (B.4). Lives in the window that holds the Telegram lease: that is
 * the only window whose remote sink can actually reach the owner's phone, so
 * it is the one that drains the outbox the scheduler window writes.
 *
 * An item is deleted only after delivery is accepted (the remote outbox
 * recorded it). When the channel has no paired owner, delivery returns 0 and
 * the file stays pending — it is retried on the next scan, and the 24 h cutoff
 * in `renderOutboxMessage` turns a long-sitting item into a count.
 *
 * The deliver callback is injected so this is testable without a transport: a
 * fake that records calls and returns a count is all the logic needs.
 */
export interface JobOutboxWatcherDeps {
  /** The outbox directory to watch. */
  outboxDir: string;
  /**
   * Deliver one message to the owner chat. Returns the number of chats
   * reached; 0 means "not delivered, keep the file pending".
   */
  deliver: (text: string) => Promise<number>;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Debounce for `fs.watch` bursts. Defaults to 1 s. */
  debounceMs?: number;
  /** Report a delivery failure without throwing. */
  onError?: (message: string) => void;
  /** Filesystem seams for lifecycle tests. */
  mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>;
  watch?: (path: string, listener: () => void) => fs.FSWatcher;
}

export class JobOutboxWatcher {
  private readonly outboxDir: string;
  private readonly deliver: (text: string) => Promise<number>;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly onError: (message: string) => void;
  private readonly mkdir: NonNullable<JobOutboxWatcherDeps['mkdir']>;
  private readonly watch: NonNullable<JobOutboxWatcherDeps['watch']>;
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private draining = false;
  private started = false;
  private generation = 0;

  constructor(deps: JobOutboxWatcherDeps) {
    this.outboxDir = deps.outboxDir;
    this.deliver = deps.deliver;
    this.now = deps.now ?? (() => Date.now());
    this.debounceMs = deps.debounceMs ?? 1000;
    this.onError = deps.onError ?? (() => undefined);
    this.mkdir = deps.mkdir ?? ((dir, options) => fs.promises.mkdir(dir, options));
    this.watch = deps.watch ?? ((dir, listener) => fs.watch(dir, listener));
  }

  /** Start watching and drain anything already pending. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;
    void this.ensureDirAndScan(generation).catch((err: Error) => {
      this.onError(`Forge jobs outbox watch failed: ${err.message}`);
    });
  }

  /** Stop watching. Pending items stay on disk for the next holder. */
  stop(): void {
    this.started = false;
    this.generation += 1;
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    this.watcher?.close();
    this.watcher = undefined;
  }

  private async ensureDirAndScan(generation: number): Promise<void> {
    try {
      await this.mkdir(this.outboxDir, { recursive: true });
    } catch (err) {
      this.onError(`Forge jobs outbox directory unavailable: ${(err as Error).message}`);
      return;
    }
    if (!this.started || generation !== this.generation) return;
    this.watcher = this.watch(this.outboxDir, () => this.scheduleScan());
    await this.drain(generation);
  }

  private scheduleScan(): void {
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.drain(this.generation).catch((err: Error) => {
        this.onError(`Forge jobs outbox scan failed: ${err.message}`);
      });
    }, this.debounceMs);
  }

  /**
   * Deliver every pending item, oldest first. Serialized: one drain at a time,
   * so a burst of writes coalesces into one pass and an item is never delivered
   * twice in flight. Public so a test drives one pass deterministically (the
   * `fs.watch` path is covered by the debounce, not the delivery logic).
   */
  async drain(generation = this.generation): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const items = await readOutboxItems(this.outboxDir);
      for (const item of items) {
        if (generation !== this.generation) return;
        const text = renderOutboxMessage(item, this.now());
        const reached = await this.deliver(text).catch((err) => {
          this.onError(`Forge job notification delivery failed: ${(err as Error).message}`);
          return 0;
        });
        if (reached > 0) {
          // Compare-and-delete on `changed_at`: the scheduler may have written a
          // newer change for this job while the delivery was in flight, and
          // coalescing puts it in this same file. Removing it blind would drop a
          // change nothing counted.
          await deleteOutboxItem(this.outboxDir, item.job_id, item.changed_at).catch((err) => {
            this.onError(`Forge could not remove a delivered job item: ${(err as Error).message}`);
          });
        }
        // reached === 0: no owner chat yet; leave the file pending for the
        // next scan (a Telegram window may appear, or it ages into a count).
      }
    } finally {
      this.draining = false;
      // A restart while this pass ran had its own drain refused by `draining`;
      // scan for it now instead of leaving items until the next file event.
      if (this.started && generation !== this.generation) this.scheduleScan();
    }
  }
}
