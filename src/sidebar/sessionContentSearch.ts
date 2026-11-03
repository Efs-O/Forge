/**
 * The sessions panel's content search: the only place the host reads saved
 * transcripts to answer a search box.
 *
 * Titles and sender badges are filtered in the webview from the rows it already
 * has (`webview-ui/src/historyFilter.ts`); what the webview cannot do is read
 * the transcripts, so this bridge answers that, panel-scoped, exactly the way
 * `jobPanelUpdates.ts` answers the Jobs tab. It holds no copy of the session:
 * every read goes through `getSidebar()` or `ArchivedSessions.readForSearch`,
 * so a chat that closed, was renamed or was deleted mid-scan is searched as it
 * is at the moment the scan reaches it, never as it was when the panel opened.
 *
 * **Why one query is several publishes.** The archive in front of this is not
 * small: measured on this workspace, 211 overflow bodies (191 MB) and 354
 * session logs (253 MB) belong to it. Reading all of it inside one keystroke is
 * not possible, so a pass reads until its time budget is spent, publishes the
 * matches it has reached (`complete: false`), and resumes after a short gap.
 * Each pass reports the whole set it has reached, so the webview replaces rather
 * than merges, and a dropped publish cannot leave half a result behind. The
 * ids a pass has already read are not read again for the same query, so the
 * archive is walked once per query rather than once per pass.
 *
 * **What cancels it:** a newer query for the same panel (the older scan stops at
 * its next check), `closePanel` for the generation that asked, the sidebar view
 * being replaced or disposed (`isCurrent` compares the captured view), and
 * `dispose()` at extension teardown — which also clears the pending resume timer.
 * Nothing here outlives an open panel, and no path waits on a question.
 *
 * **What says a reply belongs to this panel:** the pair `(panelId, view)` plus
 * `requestId` and the echoed `query`. A close/reopen race, a window reload, a
 * second window, a tab change and rapid typing each have their own guard.
 */
import type * as vscode from 'vscode';
import { z } from 'zod';
import { getLogger } from '../util/logger';
import type { ChatMessage } from '../llm/types';
import { textContent } from './sessionProjections';
import type { SlimPersistMessage, SidebarRuntime } from './sessionTypes';
import { ArchivedSessions, type ArchivedSessionMeta } from './ArchivedSessions';
import type { HostToWebview } from './messageBridge';
import {
  SESSION_SEARCH_QUERY_MAX_CHARS,
  type SessionSearchQueryMsg,
  type SessionSearchTab,
} from './sessionSearchMessages';

/**
 * The contract the host enforces on every search request, kept here rather than
 * beside the shapes in `sessionSearchMessages.ts` because that file is imported
 * by the webview, and a schema in it would ship the whole validation library to
 * the panel for one message. The webview is a client, not a trusted caller: a
 * message that names a tab the panel does not have, or a `panelId` that is not
 * an integer, would otherwise start a scan of the whole archive that nobody is
 * waiting for.
 */
const sessionSearchQuerySchema = z
  .object({
    type: z.literal('sessionSearchQuery'),
    panelId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    requestId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    tab: z.enum(['chats', 'archived']),
    query: z.string().max(SESSION_SEARCH_QUERY_MAX_CHARS),
  })
  .strict();

/** How long one pass may read before it publishes what it has and resumes. */
export const SESSION_SEARCH_PASS_BUDGET_MS = 600;
/** The gap between passes, so a long walk yields to whatever else is running. */
export const SESSION_SEARCH_RESUME_MS = 250;

const log = getLogger();

/** What a search may match: the text a person typed and the text the agent said. */
export function transcriptSearchText(
  messages: readonly (ChatMessage | SlimPersistMessage)[],
): string {
  const parts: string[] = [];
  for (const message of messages) {
    // A tool turn is what the agent read, not what anyone said, and an internal
    // turn is a prompt the person never saw. Both are excluded on purpose: a
    // match the panel cannot point at is worse than no match.
    if (message.internal === true) continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = textContent(message.content);
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

/** The same rule, applied to the session-log rows an archived chat was rebuilt from. */
export function sessionLogSearchText(rows: readonly Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const row of rows) {
    const role = row['role'];
    if (role !== 'user' && role !== 'assistant') continue;
    if (row['internal'] === true) continue;
    // `SessionLogger` already flattens an attachment-carrying prompt's text
    // parts into one string, so a string check is the whole rule here.
    const content = row['content'];
    if (typeof content === 'string' && content) parts.push(content);
  }
  return parts.join('\n');
}

export interface SessionContentSearchDeps {
  /** Read live, not captured: the sidebar session is reassigned as chats change. */
  getSidebar: () => SidebarRuntime;
  /** The sidebar's current view, or undefined once it is disposed. */
  getView: () => vscode.WebviewView | undefined;
  /** The overflow archive, or absent when this window has no workspace storage. */
  overflow?: ArchivedSessions;
  /** Injectable timing; the exported constants are the production values. */
  passBudgetMs?: number;
  resumeMs?: number;
}

/** Where one id's text came from, or why it could not be read. */
type SearchText =
  | { kind: 'text'; text: string }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'gone' };

/** One query's walk. Replaced wholesale by the next query, so only one runs. */
interface Scan {
  panelId: number;
  requestId: number;
  tab: SessionSearchTab;
  /** What was typed, echoed back so the webview can drop a reply for other text. */
  query: string;
  /** The needle, made the same way `historyFilter.ts` makes its title match. */
  needle: string;
  view: vscode.WebviewView;
  /** Ids still to be read, newest first, as they were when the scan started. */
  pending: string[];
  /** Matches reached so far, newest first — every pass republishes this whole set. */
  matched: string[];
  unreadable: number;
  /** Overflow rows read from the index at scan start, so a pass is not re-listing. */
  rowsById: Map<string, ArchivedSessionMeta>;
}

/**
 * Walks saved transcripts for the search box and publishes what it finds.
 * Holds no transcript of its own: an in-memory conversation is read from the
 * session, an archived one from disk, and neither is kept after its pass.
 */
export class SessionContentSearch {
  private current: Scan | undefined;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: SessionContentSearchDeps) {}

  /**
   * The box changed, or this is the first query for a freshly opened panel.
   *
   * An empty box is answered immediately and cancels whatever was walking: the
   * webview keeps its own title and badge filter, so there is nothing left to
   * search and no reason to read 400 MB for a query nobody typed.
   */
  search(raw: SessionSearchQueryMsg): void {
    const parsed = sessionSearchQuerySchema.safeParse(raw);
    const view = this.deps.getView();
    if (!parsed.success) {
      // A request the panel could not have meant — a non-integer generation, a
      // tab it does not have, a needle longer than any search box holds — is
      // refused rather than walked, and the panel is told why rather than left
      // waiting for a reply that will never come.
      const tooLong =
        typeof raw?.query === 'string' && raw.query.length > SESSION_SEARCH_QUERY_MAX_CHARS;
      const detail = tooLong
        ? `a search box cannot hold a ${raw.query.length}-character query (limit ${SESSION_SEARCH_QUERY_MAX_CHARS})`
        : `malformed chat search request: ${parsed.error.issues[0]?.message ?? 'invalid'}`;
      if (view) this.post(view, { type: 'error', message: `Forge: ${detail}.` });
      return;
    }
    if (!view) return;
    const { panelId, requestId, tab, query } = parsed.data;
    const needle = query.trim().toLowerCase();
    if (!needle) {
      this.current = undefined;
      this.clearResume();
      this.post(view, {
        type: 'sessionSearchResult',
        panelId,
        requestId,
        tab,
        query,
        ids: [],
        complete: true,
      });
      return;
    }
    const scan: Scan = {
      panelId,
      requestId,
      tab,
      query,
      needle,
      view,
      pending: [],
      matched: [],
      unreadable: 0,
      rowsById: new Map(),
    };
    // A newer query replaces the older scan; its next check fails and it stops
    // mid-read rather than racing it, so two walks never publish for one panel.
    this.current = scan;
    this.clearResume();
    this.collectTargets(scan);
    void this.runPass(scan);
  }

  /** The panel that asked closed. A close from another generation is ignored. */
  closePanel(panelId: number): void {
    if (!this.current || this.current.panelId !== panelId) return;
    this.current = undefined;
    this.clearResume();
  }

  /** Extension teardown: stop whatever is walking, for any panel. */
  dispose(): void {
    this.current = undefined;
    this.clearResume();
  }

  /**
   * The ids this query has to walk, newest first, exactly as the panel will draw
   * them: Chats is what is open, Archived is every closed chat — recent history
   * first, then the overflow index, with a chat that is briefly in both counted
   * once. Snapshotted once per query, so a session sync mid-scan cannot reshuffle
   * the walk or make the scan re-read a chat it has already searched.
   */
  private collectTargets(scan: Scan): void {
    const sidebar = this.deps.getSidebar();
    const seen = new Set<string>();
    const ordered: { id: string; updatedAt: number }[] = [];
    const push = (id: string, updatedAt: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      ordered.push({ id, updatedAt });
    };
    if (scan.tab === 'chats') {
      for (const conversation of sidebar.conversations)
        push(conversation.id, conversation.updatedAt);
    } else {
      for (const conversation of sidebar.history) push(conversation.id, conversation.updatedAt);
      const rows = this.deps.overflow?.list() ?? [];
      for (const row of rows) {
        // A row that duplicates an open or recent chat is drawn from the open or
        // recent copy, so searching the archive copy again would only cost a read.
        if (sidebar.conversations.some((c) => c.id === row.id)) continue;
        if (sidebar.history.some((c) => c.id === row.id)) continue;
        scan.rowsById.set(row.id, row);
        push(row.id, row.updatedAt);
      }
    }
    scan.pending = ordered.sort((a, b) => b.updatedAt - a.updatedAt).map((target) => target.id);
  }

  /** Read until the budget is spent or the walk ends, then publish once. */
  private async runPass(scan: Scan): Promise<void> {
    const budget = this.deps.passBudgetMs ?? SESSION_SEARCH_PASS_BUDGET_MS;
    const deadline = Date.now() + budget;
    while (scan.pending.length > 0) {
      if (!this.isCurrent(scan)) return;
      const id = scan.pending.shift()!;
      const found = await this.textFor(id, scan);
      // The read landed after the panel closed, the query changed or this
      // window's view was replaced: whatever it found belongs to a panel nobody
      // is looking at, so it is dropped rather than published.
      if (!this.isCurrent(scan)) return;
      if (found.kind === 'text') {
        if (found.text.toLowerCase().includes(scan.needle)) scan.matched.push(id);
      } else if (found.kind === 'unreadable') {
        scan.unreadable += 1;
        log.warn(`[SessionContentSearch] could not read ${id}: ${found.reason}`);
      }
      if (Date.now() >= deadline) {
        // Partial, and the panel says so: a no-match the scan has not earned
        // would tell the person their chat does not contain the words.
        this.publish(scan, false);
        if (!this.isCurrent(scan)) return;
        this.scheduleResume(scan);
        return;
      }
    }
    this.publish(scan, true);
  }

  /** One id's text, read fresh: in memory first, then the archive it was filed in. */
  private async textFor(id: string, scan: Scan): Promise<SearchText> {
    const sidebar = this.deps.getSidebar();
    const conversation =
      sidebar.conversations.find((item) => item.id === id) ??
      sidebar.history.find((item) => item.id === id);
    if (conversation) return { kind: 'text', text: transcriptSearchText(conversation.messages) };
    const row = scan.rowsById.get(id);
    if (!row) return { kind: 'gone' };
    const source = await (this.deps.overflow?.readForSearch(row) ?? Promise.resolve(undefined));
    if (source === undefined) return { kind: 'gone' };
    if (source.kind === 'body')
      return { kind: 'text', text: transcriptSearchText(source.messages) };
    if (source.kind === 'log') return { kind: 'text', text: sessionLogSearchText(source.rows) };
    return { kind: 'unreadable', reason: source.reason };
  }

  private publish(scan: Scan, complete: boolean): void {
    if (!this.isCurrent(scan)) return;
    this.post(scan.view, {
      type: 'sessionSearchResult',
      panelId: scan.panelId,
      requestId: scan.requestId,
      tab: scan.tab,
      query: scan.query,
      ids: [...scan.matched],
      complete,
      ...(scan.unreadable > 0 ? { unreadable: scan.unreadable } : {}),
    });
  }

  /** Continue this walk after a gap, unless something has already cancelled it. */
  private scheduleResume(scan: Scan): void {
    this.clearResume();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      if (this.isCurrent(scan)) void this.runPass(scan);
    }, this.deps.resumeMs ?? SESSION_SEARCH_RESUME_MS);
  }

  private clearResume(): void {
    if (!this.resumeTimer) return;
    clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
  }

  /**
   * This scan is still the one, on the view that asked for it. The view is part
   * of the guard because a window reload hands back a new view under the same
   * generation number, and a reply posted into a disposed view is lost anyway.
   */
  private isCurrent(scan: Scan): boolean {
    return this.current === scan && this.deps.getView() === scan.view;
  }

  /**
   * Post straight to the view that asked, not through the provider's `post()`:
   * a search result is not turn progress, and the captured view is what makes
   * the staleness guard mean something.
   */
  private post(view: vscode.WebviewView, msg: HostToWebview): void {
    view.webview.postMessage(msg);
  }
}
