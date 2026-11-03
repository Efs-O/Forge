/**
 * The rules the sessions panel's content search matches on, and the two
 * questions this repo asks of every new wait and every new webview message:
 * what cancels it, and what says a reply belongs to this panel and this query.
 *
 * The archive itself is exercised against real files in
 * `test/integration/SessionContentSearchArchive.test.ts`; this file keeps to the
 * in-memory half (open tabs and recent history, which the host already holds)
 * plus one archive stub whose reads are deliberately slow, because cancellation
 * can only be observed while a read is in flight.
 */
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { ArchivedSessions, type ArchivedSessionMeta } from '../../src/sidebar/ArchivedSessions';
import {
  SessionContentSearch,
  sessionLogSearchText,
  transcriptSearchText,
} from '../../src/sidebar/sessionContentSearch';
import { SESSION_SEARCH_QUERY_MAX_CHARS } from '../../src/sidebar/sessionSearchMessages';
import type { HostToWebview, SessionSearchQueryMsg } from '../../src/sidebar/messageBridge';
import type { ChatMessage } from '../../src/llm/types';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';

let posts: HostToWebview[];
let view: vscode.WebviewView;
let search: SessionContentSearch | undefined;

function makeView(sink: HostToWebview[]): vscode.WebviewView {
  return {
    webview: { postMessage: (msg: unknown) => sink.push(msg as HostToWebview) },
  } as unknown as vscode.WebviewView;
}

type Result = Extract<HostToWebview, { type: 'sessionSearchResult' }>;
const results = (): Result[] =>
  posts.filter((msg): msg is Result => msg.type === 'sessionSearchResult');
const latestResult = (): Result | undefined => results().at(-1);
const errors = (): string[] =>
  posts
    .filter((msg): msg is Extract<HostToWebview, { type: 'error' }> => msg.type === 'error')
    .map((msg) => msg.message);

function conversation(
  id: string,
  title: string,
  updatedAt: number,
  messages: ChatMessage[],
): ConversationRuntime {
  return { id, title, createdAt: 1, updatedAt, messages };
}

function session(conversations: ConversationRuntime[], history: ConversationRuntime[] = []): SidebarRuntime {
  return {
    activeConversationId: conversations[0]?.id ?? '',
    conversations,
    history,
  };
}

/** An archive that never touches disk and answers each row as a session log. */
class StubArchive extends ArchivedSessions {
  constructor(
    private readonly rows: ArchivedSessionMeta[],
    private readonly prompts: Record<string, string>,
    private readonly delayMs = 0,
  ) {
    super(path.join(os.tmpdir(), 'session-content-search-unused'), 'unused-workspace', 'unused-logs');
  }
  override list(): ArchivedSessionMeta[] {
    return this.rows.map((row) => ({ ...row }));
  }
  override async readForSearch(row: ArchivedSessionMeta) {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const prompt = this.prompts[row.id];
    if (prompt === undefined) return { kind: 'unreadable', reason: 'no fixture text' };
    return {
      kind: 'log',
      rows: [
        { role: 'user', content: prompt },
        { role: 'system', content: 'a hidden system prompt about wobble' },
      ],
    };
  }
}

function makeSearch(
  sidebar: SidebarRuntime,
  options: {
    view?: vscode.WebviewView;
    overflow?: ArchivedSessions;
    passBudgetMs?: number;
    resumeMs?: number;
  } = {},
): SessionContentSearch {
  const bridge = new SessionContentSearch({
    getSidebar: () => sidebar,
    getView: () => options.view ?? view,
    ...(options.overflow ? { overflow: options.overflow } : {}),
    passBudgetMs: options.passBudgetMs ?? 1,
    resumeMs: options.resumeMs ?? 5,
  });
  search = bridge;
  return bridge;
}

function query(
  bridge: SessionContentSearch,
  over: Partial<SessionSearchQueryMsg> & { query: string },
): void {
  bridge.search({
    type: 'sessionSearchQuery',
    panelId: 1,
    requestId: 1,
    tab: 'archived',
    ...over,
  });
}

async function waitFor(check: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(detail);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

beforeEach(() => {
  posts = [];
  view = makeView(posts);
  search = undefined;
});

afterEach(() => {
  search?.dispose();
  search = undefined;
});

describe('what a search is allowed to match', () => {
  it('matches what a person typed and what the agent said back', () => {
    const text = transcriptSearchText([
      { role: 'user', content: 'rename the config folder' },
      { role: 'assistant', content: 'I renamed .forge/config.yaml.' },
    ]);
    expect(text.toLowerCase().includes('rename the config')).toBe(true);
    expect(text.toLowerCase().includes('config.yaml')).toBe(true);
  });

  it('leaves out tool output, hidden turns, system prompts and reasoning', () => {
    const text = transcriptSearchText([
      { role: 'tool', content: 'wobble appeared in this tool result', name: 'read_file' },
      { role: 'user', content: 'a hidden injected prompt about wobble', internal: true },
      { role: 'system', content: 'the system prompt mentions wobble' },
      // A tool-calling turn has no answer text of its own; its thinking does
      // carry the word, and the search must not match on it.
      { role: 'assistant', content: '', reasoning: 'wobble in the thinking block' },
    ]);
    expect(text).toBe('');
    // The same turn with an answer keeps the answer and still drops the thought:
    // what the person saw is what a search finds them in.
    expect(transcriptSearchText([{ role: 'assistant', content: 'the answer', reasoning: 'wobble' }])).toBe(
      'the answer',
    );
  });

  it('keeps the text of a prompt that also carried an attachment', () => {
    // A user turn with attachments has array content, and the persisted form
    // stores refs; the words a person typed are still the words they typed.
    const text = transcriptSearchText([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this screenshot' },
          { type: 'image_url', image_url: { url: 'file://x.png' } },
        ],
      },
    ]);
    expect(text).toBe('look at this screenshot');
  });

  it('applies the same rule to the session-log rows an archived chat was rebuilt from', () => {
    const text = sessionLogSearchText([
      { type: 'session_start', workspace_path: 'N:/x', timestamp_ms: 1 },
      { role: 'user', content: 'fix the flaky renderer test' },
      { role: 'assistant', content: 'the assertion was stale.' },
      { role: 'tool', content: 'wobble in a tool result' },
      { role: 'user', content: 'an injected turn', internal: true },
      { role: 'system', content: 'wobble in the system prompt' },
      { role: 'user', content: null },
    ]);
    expect(text).toBe('fix the flaky renderer test\nthe assertion was stale.');
  });
});

/** Three archived rows, read slowly enough that a walk can be cancelled mid-file. */
const rows: ArchivedSessionMeta[] = [
  { id: 'arch-1', title: 'archived one', createdAt: 1, updatedAt: 30, messageCount: 1 },
  { id: 'arch-2', title: 'archived two', createdAt: 1, updatedAt: 20, messageCount: 1 },
  { id: 'arch-3', title: 'archived three', createdAt: 1, updatedAt: 10, messageCount: 1 },
];
const prompts = {
  'arch-1': 'wobble is in this one',
  'arch-2': 'wobble is in this one too',
  'arch-3': 'nothing here',
};

describe('the in-memory half: open tabs and recent history', () => {
  const open = conversation('open-1', 'chat open-1', 300, [
    { role: 'user', content: 'clamp the panel before it overflows' },
  ]);
  const recent = conversation('old-1', 'chat old-1', 200, [
    { role: 'assistant', content: 'the renderer lives in HistoryTabContent.' },
  ]);

  it('matches an open chats text even though its title says nothing about it', async () => {
    const bridge = makeSearch(session([open]));
    query(bridge, { query: 'overflows', tab: 'chats' });
    await waitFor(() => latestResult()?.complete === true, 'the Chats search never finished');
    expect(latestResult()?.ids).toEqual(['open-1']);
  });

  it('does not let a Chats search reach a closed chat, which belongs to the Archived tab', async () => {
    const bridge = makeSearch(session([open], [recent]));
    query(bridge, { query: 'HistoryTabContent', tab: 'chats' });
    await waitFor(() => latestResult()?.complete === true, 'the Chats search never finished');
    expect(latestResult()?.ids).toEqual([]);
  });

  it('matches a closed chat in recent history on the Archived tab', async () => {
    const bridge = makeSearch(session([open], [recent]));
    query(bridge, { query: 'renderer', tab: 'archived' });
    await waitFor(() => latestResult()?.complete === true, 'the Archived search never finished');
    expect(latestResult()?.ids).toEqual(['old-1']);
  });

  it('still searches recent history when this window has no archive to walk', async () => {
    const bridge = makeSearch(session([], [recent]));
    query(bridge, { query: 'renderer' });
    await waitFor(() => latestResult()?.complete === true, 'the search never finished');
    expect(latestResult()?.ids).toEqual(['old-1']);
    expect(latestResult()?.unreadable).toBeUndefined();
  });

  it('trims the needle but echoes the query exactly as it arrived', async () => {
    const bridge = makeSearch(session([open]));
    query(bridge, { query: '  OVERFLOWS  ', tab: 'chats' });
    await waitFor(() => latestResult()?.complete === true, 'the search never finished');
    expect(latestResult()?.ids).toEqual(['open-1']);
    expect(latestResult()?.query).toBe('  OVERFLOWS  ');
  });
});

describe('an empty search box', () => {
  it('answers immediately and stops walking the archive', async () => {
    const slow = new StubArchive(
      [{ id: 'arch-1', title: 'archived', createdAt: 1, updatedAt: 10, messageCount: 1 }],
      { 'arch-1': 'clamp the panel' },
      30,
    );
    const bridge = makeSearch(session([]), { overflow: slow, passBudgetMs: 10_000 });
    query(bridge, { query: 'clamp' });
    query(bridge, { query: '   ', requestId: 2 });
    expect(results()).toHaveLength(1);
    expect(latestResult()?.ids).toEqual([]);
    expect(latestResult()?.complete).toBe(true);
    expect(latestResult()?.requestId).toBe(2);
    await sleep(120);
    // The walk started by the first query never published: an empty box has
    // nothing to find, so reading 400 MB for it would be work for nobody.
    expect(results()).toHaveLength(1);
  });
});

describe('what cancels a walk', () => {
  it('a newer query replaces the older one, and only the newer one publishes', async () => {
    const bridge = makeSearch(session([]), {
      overflow: new StubArchive(rows, prompts, 20),
      passBudgetMs: 10_000,
    });
    query(bridge, { query: 'wobble', requestId: 1 });
    query(bridge, { query: 'wobble too', requestId: 2 });
    await waitFor(() => latestResult()?.complete === true, 'the newer query never finished');
    // Every publish names the newer request: the older walk stopped at its next
    // check instead of racing it to the panel.
    expect(results().every((result) => result.requestId === 2)).toBe(true);
    expect(results().every((result) => result.query === 'wobble too')).toBe(true);
  });

  it('a close for the panel being walked stops it for good', async () => {
    const bridge = makeSearch(session([]), {
      overflow: new StubArchive(rows, prompts, 20),
      passBudgetMs: 10_000,
    });
    query(bridge, { query: 'wobble' });
    await waitFor(() => results().length > 0, 'the walk never published');
    bridge.closePanel(1);
    const published = results().length;
    await sleep(150);
    expect(results()).toHaveLength(published);
  });

  it('a window reload — a new view under the same generation — drops the old publishes', async () => {
    const bridge = makeSearch(session([]), {
      overflow: new StubArchive(rows, prompts, 20),
      passBudgetMs: 10_000,
    });
    query(bridge, { query: 'wobble' });
    await waitFor(() => results().length > 0, 'the walk never published');
    const reloaded = makeView(posts);
    view = reloaded;
    const published = results().length;
    await sleep(150);
    // Nothing arrived after the view changed, and nothing arrived in the new
    // view: a reply posted into a replaced webview would be lost anyway, so the
    // walk is stopped rather than allowed to keep reading.
    expect(results()).toHaveLength(published);
  });

  it('extension teardown stops whatever is walking', async () => {
    const bridge = makeSearch(session([]), {
      overflow: new StubArchive(rows, prompts, 20),
      passBudgetMs: 10_000,
    });
    query(bridge, { query: 'wobble' });
    await waitFor(() => results().length > 0, 'the walk never published');
    bridge.dispose();
    const published = results().length;
    await sleep(150);
    expect(results()).toHaveLength(published);
  });
});

describe('a request the panel could not have meant', () => {
  it('refuses a tab the panel does not have, rather than walking for it', async () => {
    const bridge = makeSearch(session([]), {
      overflow: new StubArchive(rows, prompts, 20),
      passBudgetMs: 10_000,
    });
    // The Jobs tab has its own list, filtered in the webview: it has no
    // transcripts to walk, and this message could not have come from the panel.
    bridge.search({
      type: 'sessionSearchQuery',
      panelId: 1,
      requestId: 1,
      tab: 'jobs' as 'chats',
      query: 'wobble',
    });
    await sleep(60);
    expect(results()).toHaveLength(0);
    expect(errors()).toHaveLength(1);
  });

  it('refuses a query longer than any search box holds, rather than matching a truncated needle', async () => {
    const bridge = makeSearch(session([]), {
      overflow: new StubArchive(rows, prompts, 20),
      passBudgetMs: 10_000,
    });
    const huge = 'w'.repeat(SESSION_SEARCH_QUERY_MAX_CHARS + 1);
    query(bridge, { query: huge });
    expect(results()).toHaveLength(0);
    expect(errors()[0]).toContain(`${SESSION_SEARCH_QUERY_MAX_CHARS}`);
    await sleep(60);
    expect(results()).toHaveLength(0);
  });

  it('refuses a panel generation that is not a number', async () => {
    const bridge = makeSearch(session([]), { overflow: new StubArchive(rows, prompts, 20) });
    bridge.search({
      type: 'sessionSearchQuery',
      panelId: Number.NaN,
      requestId: 1,
      tab: 'chats',
      query: 'wobble',
    });
    expect(results()).toHaveLength(0);
    expect(errors()).toHaveLength(1);
  });

  it('says nothing to a panel that is no longer there', () => {
    const gone = new SessionContentSearch({
      getSidebar: () => session([]),
      getView: () => undefined,
    });
    gone.search({
      type: 'sessionSearchQuery',
      panelId: 1,
      requestId: 1,
      tab: 'chats',
      query: 'wobble',
    });
    gone.dispose();
    expect(posts).toHaveLength(0);
  });
});
