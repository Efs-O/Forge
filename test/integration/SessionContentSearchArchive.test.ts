/**
 * The content search against the archive as it is really stored: a body file, a
 * session log with no body, a body that went corrupt after its row was written,
 * a chat whose body was deleted, and logs from another workspace.
 * `ArchivedSessions` is the real one in a temp directory, because the seam under
 * test is its `readForSearch` — which file backs a row, what happens when it
 * cannot be read, and which rows the index will not hand back at all. A stub
 * would answer those with whatever the test wanted to be true.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { ArchivedSessions, type ArchivedSessionMeta } from '../../src/sidebar/ArchivedSessions';
import { SessionContentSearch } from '../../src/sidebar/sessionContentSearch';
import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

let root: string;
let storageDir: string;
let logsDir: string;
let workspacePath: string;
let posts: HostToWebview[];
let view: vscode.WebviewView;
let search: SessionContentSearch | undefined;

/** A panel that records what the host posts to it. */
function makeView(sink: HostToWebview[]): vscode.WebviewView {
  return {
    webview: { postMessage: (msg: unknown) => sink.push(msg as HostToWebview) },
  } as unknown as vscode.WebviewView;
}

type Result = Extract<HostToWebview, { type: 'sessionSearchResult' }>;
const results = (): Result[] =>
  posts.filter((msg): msg is Result => msg.type === 'sessionSearchResult');
const latestResult = (): Result | undefined => results().at(-1);

/** The session the panel would have drawn from: empty, because this file is about the archive. */
function emptySession(): SidebarRuntime {
  return { activeConversationId: '', conversations: [], history: [] };
}

function session(conversations: ConversationRuntime[]): SidebarRuntime {
  return {
    activeConversationId: conversations[0]?.id ?? '',
    conversations,
    history: [],
  };
}

function conversation(id: string, prompt: string): ConversationRuntime {
  return {
    id,
    title: `chat ${id}`,
    createdAt: 1,
    updatedAt: 100,
    messages: [{ role: 'user', content: prompt }],
  };
}

/** Archive row ids are file names, so the fixtures look like them. */
const BODY_ID = 'body-backed-chat';
const LOG_ID = 'log-only-chat';
const OTHER_WORKSPACE_LOG_ID = 'another-workspaces-chat';
const CORRUPT_ID = 'corrupt-body-chat';
const DELETED_ID = 'deleted-body-chat';

function writeLog(id: string, workspace: string, lines: Record<string, unknown>[]): void {
  const rows = [
    { type: 'session_start', workspace_path: workspace, timestamp_ms: 1000, model: 'test-model' },
    ...lines.map((line, index) => ({ timestamp_ms: 1001 + index, ...line })),
  ];
  fs.writeFileSync(
    path.join(logsDir, `${id}.jsonl`),
    `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
}

/** A persisted body, in the shape `conversationPersistedSchema` accepts. */
function bodyJson(id: string, prompt: string, answer: string): string {
  return JSON.stringify({
    id,
    title: `saved ${id}`,
    createdAt: 2000,
    updatedAt: 2100,
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: answer },
    ],
  });
}

function bodyPath(id: string): string {
  return path.join(storageDir, 'archive', `${id}.json`);
}

function indexPath(): string {
  return path.join(storageDir, 'archive', 'index.json');
}

/** An index as it would look after these chats were archived: rows naming the
 *  file that backed each one, which is what `readForSearch` decides from. */
function writeIndex(rows: { id: string; source?: 'body' | 'log'; updatedAt: number }[]): void {
  fs.writeFileSync(
    indexPath(),
    JSON.stringify(
      rows.map((row) => ({
        id: row.id,
        title: `saved ${row.id}`,
        createdAt: 2000,
        updatedAt: row.updatedAt,
        messageCount: 2,
        ...(row.source ? { source: row.source } : {}),
      })),
    ),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-content-search-'));
  storageDir = path.join(root, 'storage');
  logsDir = path.join(root, 'logs');
  workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(path.join(storageDir, 'archive'), { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });
  posts = [];
  view = makeView(posts);
  writeLog(LOG_ID, workspacePath, [
    { role: 'user', content: 'which file draws the sessions panel search box' },
    { role: 'assistant', content: 'HistoryList is the shell, HistoryTabContent the rows.' },
    // A tool row is what the agent read, not what anyone said: a word that only
    // appears here must not make this chat findable by that word.
    { role: 'tool', tool_call_id: 'call-1', content: 'ephemeral tool output about wobble' },
  ]);
  writeLog(OTHER_WORKSPACE_LOG_ID, path.join(root, 'a-different-workspace'), [
    { role: 'user', content: 'wobble only lives in another workspaces log' },
  ]);
  fs.writeFileSync(bodyPath(BODY_ID), bodyJson(BODY_ID, 'how do I stop the wobble', 'clamp the panel size.'));
  // A row whose body went corrupt after it was written — a crash mid-write is
  // the realistic shape, and the row outlives the file it can no longer parse.
  fs.writeFileSync(bodyPath(CORRUPT_ID), '{"id":"corrupt-body-chat","title":"broken","messages":[');
  writeIndex([
    { id: BODY_ID, source: 'body', updatedAt: 2100 },
    { id: LOG_ID, source: 'log', updatedAt: 1100 },
    { id: CORRUPT_ID, source: 'body', updatedAt: 1050 },
    // The index still names a chat whose body has been deleted.
    { id: DELETED_ID, source: 'body', updatedAt: 900 },
  ]);
  search = undefined;
});

afterEach(() => {
  search?.dispose();
  search = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

/** The archive, with a record of which rows the search actually opened. */
function makeArchive(reads: string[] = []): ArchivedSessions {
  class Reading extends ArchivedSessions {
    override async readForSearch(row: ArchivedSessionMeta) {
      reads.push(row.id);
      return super.readForSearch(row);
    }
  }
  return new Reading(storageDir, workspacePath, logsDir);
}

function makeSearch(archive: ArchivedSessions, sidebar: SidebarRuntime = emptySession()) {
  const bridge = new SessionContentSearch({
    getSidebar: () => sidebar,
    getView: () => view,
    overflow: archive,
    // One file per pass, guaranteed: the budget is spent before the pass has read
    // anything, so the pass boundary — which is what these tests measure — always
    // publishes a partial. `1` meant the same thing but only held when a read happened
    // to cross a clock tick; on the ubuntu runner the whole walk finished inside one
    // millisecond and no partial was ever published.
    passBudgetMs: 0,
    resumeMs: 5,
  });
  search = bridge;
  return bridge;
}

/** Poll until `check` holds, so a test waits only as long as the scan takes. */
async function waitFor(check: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(detail);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Ask, then wait for THIS query's walk to finish. Waiting on "the latest result
 * is complete" alone would return the previous query's finished answer, because
 * the posts array outlives one scan — which is exactly the stale-match mistake
 * these tests exist to catch.
 */
async function searchArchived(
  bridge: SessionContentSearch,
  query: string,
  tab: 'chats' | 'archived' = 'archived',
): Promise<Result> {
  const before = results().length;
  bridge.search({ type: 'sessionSearchQuery', panelId: 1, requestId: 1, tab, query });
  await waitFor(
    () =>
      results().length > before &&
      latestResult()?.query === query &&
      latestResult()?.complete === true,
    `the search for "${query}" never finished walking`,
  );
  return latestResult()!;
}

describe('the content search against the real archive', () => {
  it('finds text in a persisted body that is nowhere in its title', async () => {
    const bridge = makeSearch(makeArchive());
    const result = await searchArchived(bridge, 'clamp the panel size');
    expect(result.ids).toEqual([BODY_ID]);
    expect(result.query).toBe('clamp the panel size');
    expect(result.tab).toBe('archived');
    expect(result.panelId).toBe(1);
    expect(result.requestId).toBe(1);
  });

  it('finds a log-only session, whose body was never written', async () => {
    const bridge = makeSearch(makeArchive());
    const result = await searchArchived(bridge, 'sessions panel');
    expect(result.ids).toEqual([LOG_ID]);
  });

  it('matches independent keywords across title and saved messages in real body and log files', async () => {
    const bridge = makeSearch(makeArchive());
    const body = await searchArchived(bridge, 'saved size wobble');
    expect(body.ids).toEqual([BODY_ID]);
    expect(body.hits?.[0].score).toBe(12);
    expect(body.hits?.[0].snippet).toContain('clamp the panel size');
    const log = await searchArchived(bridge, 'saved rows sessions -wobble');
    expect(log.ids).toEqual([LOG_ID]);
    expect(log.hits?.[0].snippet).toContain('sessions panel');
    expect((await searchArchived(bridge, '"panel size"')).ids).toEqual([BODY_ID]);
    expect((await searchArchived(bridge, '"size panel"')).ids).toEqual([]);
    expect((await searchArchived(bridge, 'saved -"panel size"')).ids).toEqual([LOG_ID]);
    expect((await searchArchived(bridge, '-wobble')).ids).toEqual([LOG_ID]);
  });

  it('matches case-insensitively, and echoes what was typed rather than a trimmed copy', async () => {
    const bridge = makeSearch(makeArchive());
    const result = await searchArchived(bridge, '  HOW DO I STOP THE WOBBLE  ');
    expect(result.ids).toEqual([BODY_ID]);
    // The echo is verbatim, spaces and all: the webview compares its own box
    // against it, so trimming the echo would make a valid reply look stale.
    expect(result.query).toBe('  HOW DO I STOP THE WOBBLE  ');
  });

  it('ignores a tool row, and a log from a workspace this window did not open', async () => {
    const bridge = makeSearch(makeArchive());
    // `wobble` lives in this workspace's body, in another workspace's log, and
    // in a tool row of this workspace's log. Only user and assistant turns
    // count, and the other workspace's chat is never listed by the archive.
    const result = await searchArchived(bridge, 'wobble');
    expect(result.ids).toEqual([BODY_ID]);
    const toolOnly = await searchArchived(bridge, 'ephemeral tool output');
    expect(toolOnly.ids).toEqual([]);
    const other = await searchArchived(bridge, 'another workspaces log');
    expect(other.ids).toEqual([]);
  });

  it('reports a body it could not read as unreadable, not as a chat that does not match', async () => {
    const bridge = makeSearch(makeArchive());
    const result = await searchArchived(bridge, 'clamp');
    expect(result.ids).toEqual([BODY_ID]);
    // The corrupt file is a row the panel draws, so a bare no-match would read
    // as "it is not in there" when the truth is "I could not look inside it".
    expect(result.unreadable).toBe(1);
  });

  it('never quarantines, rebuilds or deletes while searching', async () => {
    const archive = makeArchive();
    const bridge = makeSearch(archive);
    await searchArchived(bridge, 'clamp');
    expect(fs.existsSync(bodyPath(CORRUPT_ID))).toBe(true);
    expect(
      fs.readdirSync(path.join(storageDir, 'archive')).filter((name) => name.includes('.corrupt-')),
    ).toEqual([]);
    expect(fs.existsSync(path.join(logsDir, `${LOG_ID}.jsonl`))).toBe(true);
    expect(archive.list().map((row) => row.id).sort()).toEqual(
      [BODY_ID, CORRUPT_ID, LOG_ID].sort(),
    );
  });

  it('leaves a chat whose body was deleted out of the archive, and out of the search', async () => {
    const archive = makeArchive();
    // The index still names it; the file does not exist, so the archive drops
    // the row rather than handing the search a chat nobody can open.
    expect(archive.list().map((row) => row.id)).not.toContain(DELETED_ID);
    const bridge = makeSearch(archive);
    const result = await searchArchived(bridge, 'deleted chat');
    expect(result.ids).toEqual([]);
  });

  it('rebuilds a missing index from this workspace only, so another workspaces chats never appear', async () => {
    fs.rmSync(indexPath());
    const archive = makeArchive();
    const rows = archive.list().map((row) => row.id);
    expect(rows).toContain(LOG_ID);
    expect(rows).not.toContain(OTHER_WORKSPACE_LOG_ID);
    const bridge = makeSearch(archive);
    const result = await searchArchived(bridge, 'another workspaces log');
    expect(result.ids).toEqual([]);
  });

  it('answers a Chats search from the open conversation without opening any archive file', async () => {
    const reads: string[] = [];
    const bridge = makeSearch(
      makeArchive(reads),
      session([conversation('open-1', 'clamp the panel size before it overflows')]),
    );
    const result = await searchArchived(bridge, 'clamp the panel', 'chats');
    expect(result.ids).toEqual(['open-1']);
    expect(reads).toEqual([]);
  });

  it('skips the archived copy of a chat that is open, so a match is never reported from a file the panel is not drawing', async () => {
    const reads: string[] = [];
    const bridge = makeSearch(
      makeArchive(reads),
      session([conversation(BODY_ID, 'a totally different prompt')]),
    );
    const archived = await searchArchived(bridge, 'clamp the panel size');
    expect(archived.ids).toEqual([]);
    expect(reads).not.toContain(BODY_ID);
    // The same words, searched where the panel is drawing that chat from: the
    // open copy, not the stale body file.
    const openCopy = await searchArchived(bridge, 'totally different prompt', 'chats');
    expect(openCopy.ids).toEqual([BODY_ID]);
  });

  it('publishes what it has found before the walk finishes, so a match is not held back', async () => {
    const bridge = makeSearch(makeArchive());
    bridge.search({
      type: 'sessionSearchQuery',
      panelId: 1,
      requestId: 1,
      tab: 'archived',
      query: 'clamp',
    });
    await waitFor(
      () => results().some((result) => !result.complete && result.ids.includes(BODY_ID)),
      'the scan never published a partial result',
    );
    const partial = results().find((result) => !result.complete)!;
    expect(partial.complete).toBe(false);
    // Cumulative, not incremental: the final publish repeats this id rather than
    // adding to it, so a dropped publish cannot leave half a result behind.
    await waitFor(() => latestResult()?.complete === true, 'the scan never finished');
    expect(latestResult()?.ids).toEqual([BODY_ID]);
    expect(results().filter((result) => !result.complete).every((result) => result.ids.length > 0)).toBe(
      true,
    );
  });

  it('stops the walk when the panel that asked for it closes', async () => {
    const bridge = makeSearch(makeArchive());
    bridge.search({
      type: 'sessionSearchQuery',
      panelId: 1,
      requestId: 1,
      tab: 'archived',
      query: 'clamp',
    });
    // Wait for the walk to be visibly running before closing it, so this proves
    // a cancellation rather than a scan that never started.
    await waitFor(() => results().length > 0, 'the walk never published a partial result');
    bridge.closePanel(1);
    const published = results().length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(results()).toHaveLength(published);
    expect(results().every((result) => result.panelId === 1)).toBe(true);
  });

  it('ignores a close from another panel generation, so a reopen cannot be cancelled by the panel it replaced', async () => {
    const bridge = makeSearch(makeArchive());
    bridge.search({
      type: 'sessionSearchQuery',
      panelId: 2,
      requestId: 1,
      tab: 'archived',
      query: 'clamp',
    });
    bridge.closePanel(1);
    await waitFor(
      () => latestResult()?.complete === true,
      'a close for another generation stopped the current scan',
    );
    expect(latestResult()?.ids).toEqual([BODY_ID]);
  });
});
