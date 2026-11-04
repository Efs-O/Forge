/**
 * The sessions panel's Jobs section: the only place the sidebar reads the job
 * store, and the only thing that keeps an open panel current.
 *
 * Three sources feed one refresh path. Successful writes in this process arrive
 * through `JobStore.addLocalChangeListener` (the scheduler, `manage_jobs`, and
 * Telegram `/job` all write through `JobStore`, so none of them needs its own
 * panel callback); writes from another window arrive through `fs.watch` on the
 * three directories the store owns; and, while the panel is open, a 60 s pulse
 * re-reads on its own. All three land on the same reload, so a burst of writes
 * — a run row and the state patch that follows it — converges on a single
 * snapshot rather than two.
 *
 * The pulse is what keeps a card's "23h ago" honest: `formatWhen()` runs
 * host-side when the snapshot is built, so a row nothing writes to would keep
 * its time text frozen at whatever moment the last write happened, however
 * long the panel stayed open.
 *
 * **What cancels it:** `jobsPanelClosed` for the generation that opened it,
 * the sidebar view's own disposal, and `dispose()` at extension teardown each
 * release the store listener, all three watchers, the debounce timer, the
 * refresh pulse, and the in-flight read's right to publish (its guard below
 * fails once the panel is gone). Nothing here outlives an open panel.
 *
 * **What says this snapshot belongs to this panel:** the pair `(panelId, view)`.
 * `panelId` is the webview's open-panel generation and `view` is the exact
 * `WebviewView` that asked, so a close/reopen race, a window reload (which
 * resets the generation but hands back a new view), a second window, or a read
 * superseded by a newer one all drop the stale publish instead of painting an
 * older jobs list over a fresher one.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';
import { openDiscussChat } from '../jobs/jobDiscuss';
import { isJobDefinitionName, type JobStore } from '../jobs/JobStore';
import { buildJobsPanelSnapshot } from '../jobs/jobPanelSnapshot';
import type { JobFile } from '../jobs/jobSchema';
import { getLogger } from '../util/logger';
import { ChatCapacityError, type ForgeHostFacade } from './ForgeHostFacade';
import type { HostToWebview } from './messageBridge';

/** How long a burst of store writes has to settle before the panel re-reads. */
export const JOBS_REFRESH_DEBOUNCE_MS = 400;

/**
 * How long the panel may sit with no write before its relative times are
 * recomputed. One minute: the panel shows times rounded to hours and days, so
 * a longer gap would show a stale one, and a shorter one would re-read the
 * store for a panel nobody is looking at.
 */
export const JOBS_PANEL_REFRESH_INTERVAL_MS = 60_000;

/** One directory the store owns, plus the file names in it that the panel shows. */
interface WatchTarget {
  dir: string;
  accept: (name: string) => boolean;
}

export interface JobsPanelBridgeDeps {
  /** The one store instance, shared with the scheduler, `manage_jobs` and Telegram. */
  store: JobStore;
  /** The sidebar's current view, or undefined once it is disposed. */
  getView: () => vscode.WebviewView | undefined;
  hostFacade: () => ForgeHostFacade;
}

/** The panel this bridge is currently pushing to. */
interface ActivePanel {
  panelId: number;
  view: vscode.WebviewView;
}

/**
 * Pushes the job store to the sessions panel while it is open, and performs the
 * navigation a job row asks for. Holds no copy of the store: every snapshot is
 * read from disk, so the panel can never show a job that no longer exists.
 */
export class JobsPanelBridge {
  private active: ActivePanel | undefined;
  private releaseStoreListener: () => void = () => {};
  private watchers: fs.FSWatcher[] = [];
  private debounce: ReturnType<typeof setTimeout> | undefined;
  /** Re-reads on a pulse while the panel is open, so host-formatted "ago" text stays current. */
  private pulse: ReturnType<typeof setInterval> | undefined;
  /** Counts reads; only the newest one may publish, so an older read cannot overwrite a newer snapshot. */
  private publishSeq = 0;

  constructor(private readonly deps: JobsPanelBridgeDeps) {}

  /**
   * The panel opened. Captures this generation and this view, subscribes,
   * starts the refresh pulse, and pushes the store as it reads right now. A
   * reopen under a different generation — or the same number on a reloaded
   * view — replaces the previous subscription rather than stacking a second
   * one, and a reopen of the panel that is already open starts nothing.
   */
  openPanel(panelId: number): void {
    const view = this.deps.getView();
    if (!view) return;
    if (this.active && (this.active.panelId !== panelId || this.active.view !== view)) {
      this.release();
    }
    if (!this.active) {
      this.active = { panelId, view };
      this.subscribe();
      // One pulse per open panel: the `!this.active` guard above is what makes
      // reopening the panel that is already open start nothing rather than
      // stack a second timer, and `release()` — close, a replaced generation,
      // a replaced view, `dispose()` — clears it on every path that stops the
      // pushes. It re-reads through `refresh()`, so the same staleness guards
      // apply: a pulse that lands after the panel closed publishes nothing.
      this.pulse = setInterval(() => void this.refresh(), JOBS_PANEL_REFRESH_INTERVAL_MS);
    }
    void this.refresh();
  }

  /**
   * The panel closed. A close from an older generation is ignored: the webview
   * can only have one open at a time, and a late message from the one it
   * replaced must not tear down the current subscription.
   */
  closePanel(panelId: number): void {
    if (!this.active || this.active.panelId !== panelId) return;
    this.release();
  }

  /**
   * A job row was clicked. The job is re-read by id at click time (never from
   * the snapshot the row came from), so a job deleted since the panel opened
   * reports that instead of navigating on stale data.
   */
  async clickJob(panelId: number, id: string): Promise<void> {
    const active = this.active;
    if (!active || active.panelId !== panelId) return;
    const { view } = active;
    let jobFile: JobFile | undefined;
    try {
      jobFile = await this.deps.store.load(id);
    } catch (err) {
      this.postError(view, panelId, `could not read the job store: ${message(err)}`);
      return;
    }
    if (!jobFile) {
      this.postError(view, panelId, `that job no longer exists.`);
      return;
    }
    try {
      await this.navigate(jobFile);
    } catch (err) {
      this.postError(view, panelId, `could not open job "${jobFile.job.name}": ${message(err)}`);
      return;
    }
    // The chat is open and focused; only now may the webview collapse the panel.
    // If the panel closed during the navigation, this acknowledgement is dropped
    // and the next panel opening reads the store again anyway.
    if (!this.isCurrent(panelId, view)) return;
    this.post(view, { type: 'jobOpened', panelId, id });
  }

  /** Extension teardown: stop pushing whatever panel is open. */
  dispose(): void {
    this.release();
  }

  /**
   * Focus the job's chat. An `agent_task` whose `state.conversation_id` still
   * resolves activates that chat — that is where its turn is streaming live, so
   * clicking a Running row takes you to the turn rather than starting a second
   * one. A stale id goes through `openDiscussChat`, which restores-or-creates
   * and seeds, and refuses while a task run is in flight rather than
   * double-turning a chat. A chat cap that is full is rethrown instead: the
   * discuss path answers first with its own reason, and for a Running job that
   * reason — "is running" — is not the one the user has to act on.
   */
  private async navigate(jobFile: JobFile): Promise<void> {
    const host = this.deps.hostFacade();
    const stored = jobFile.state.conversation_id;
    if (jobFile.job.action?.kind === 'agent_task' && stored) {
      try {
        await host.restoreConversation(stored, { activate: true });
        return;
      } catch (err) {
        // A full chat cap is an answer in itself, not a stale id: rethrow it,
        // because the discuss path below refuses first with "is running" for a
        // job whose task run is in flight, and that sends the user to close a
        // chat that is not the problem.
        if (err instanceof ChatCapacityError) throw err;
        // Anything else means the stored id no longer resolves: fall through
        // to discuss, which creates a chat and persists the new id.
      }
    }
    await openDiscussChat(host, this.deps.store, jobFile, true);
  }

  /** Re-read the store and push it, dropping this read if it is no longer the newest. */
  private async refresh(): Promise<void> {
    const active = this.active;
    if (!active) return;
    const { panelId, view } = active;
    const seq = ++this.publishSeq;
    const stillMine = (): boolean => this.publishSeq === seq && this.isCurrent(panelId, view);
    try {
      const jobs = await buildJobsPanelSnapshot(this.deps.store);
      // Stale by the time the read landed: the panel closed, a newer generation
      // opened, a newer read superseded this one, or this window's sidebar view
      // was replaced. Each of those has its own snapshot already.
      if (!stillMine()) return;
      this.post(view, { type: 'jobsSnapshot', panelId, jobs });
    } catch (err) {
      // The panel keeps whatever it last showed rather than looking empty.
      if (!stillMine()) return;
      this.postError(view, panelId, `could not read the job store: ${message(err)}`);
    }
  }

  /** Coalesce a burst of notifications into one re-read. */
  private readonly scheduleRefresh = (): void => {
    if (!this.active) return;
    if (this.debounce) return;
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.refresh();
    }, JOBS_REFRESH_DEBOUNCE_MS);
  };

  /** This panel is still the open one, on the view that asked for it. */
  private isCurrent(panelId: number, view: vscode.WebviewView): boolean {
    return (
      !!this.active &&
      this.active.panelId === panelId &&
      this.active.view === view &&
      this.deps.getView() === view
    );
  }

  /** Subscribe to both write sources, scoped to this open panel. */
  private subscribe(): void {
    this.releaseStoreListener = this.deps.store.addLocalChangeListener(this.scheduleRefresh);
    for (const target of this.watchTargets()) {
      let watcher: fs.FSWatcher | undefined;
      try {
        // Synchronous, and only the watched directory: `fs.watch` needs it to
        // exist right now. `JobStore.watch()` carries the same comment — an
        // awaited `ensureDirs()` raced the watch and left its rejection
        // unhandled.
        fs.mkdirSync(target.dir, { recursive: true });
        watcher = fs.watch(target.dir, (_event, name) => {
          // A null filename (platform could not say) still counts, as in
          // `JobStore.watch()`; anything else that is not a job file — the
          // scheduler lease, its heartbeats, atomic-write temporaries — is not
          // a reason to re-read the store.
          const file = name?.toString();
          if (file && !target.accept(file)) return;
          this.scheduleRefresh();
        });
      } catch (err) {
        // A directory we cannot watch (permissions, a deleted root) leaves the
        // store listener working; the panel simply refreshes slower, not never.
        // Name the directory and the error: this is the only place that knows,
        // and without it cross-window updates stop with no trace.
        watcher = undefined;
        getLogger().warn(`[JobsPanelBridge] could not watch ${target.dir}: ${message(err)}`);
      }
      if (watcher) this.watchers.push(watcher);
    }
  }

  /**
   * The three directories the store writes into: definitions, `state/` and
   * `runs/`. Derived from `store.root` the way `JobStore.outboxDir` is, so a
   * store rooted elsewhere (a test) watches its own tree and never the real
   * `~/.forge/jobs`.
   */
  private watchTargets(): WatchTarget[] {
    const root = this.deps.store.root;
    return [
      { dir: root, accept: isJobDefinitionName },
      { dir: path.join(root, 'state'), accept: (name) => name.endsWith('.json') },
      { dir: path.join(root, 'runs'), accept: (name) => name.endsWith('.jsonl') },
    ];
  }

  /** Release everything this panel held: listener, watchers, timer, and any pending publish. */
  private release(): void {
    this.active = undefined;
    this.releaseStoreListener();
    this.releaseStoreListener = () => {};
    for (const watcher of this.watchers.splice(0)) {
      try {
        watcher.close();
      } catch {
        // Already closed by the platform; nothing left to release.
      }
    }
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    if (this.pulse) {
      clearInterval(this.pulse);
      this.pulse = undefined;
    }
  }

  /**
   * Post straight to the view that opened this panel, not through the
   * provider's `post()`: a jobs snapshot is not turn progress, and the captured
   * view is what makes the staleness guard mean anything.
   */
  private post(view: vscode.WebviewView, msg: HostToWebview): void {
    view.webview.postMessage(msg);
  }

  private postError(view: vscode.WebviewView, panelId: number, detail: string): void {
    if (!this.isCurrent(panelId, view)) return;
    this.post(view, { type: 'error', message: `Forge: ${detail}` });
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
