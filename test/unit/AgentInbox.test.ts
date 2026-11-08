import { describe, expect, it, vi } from 'vitest';
import {
  AgentInbox,
  busTurnEndLine,
  deliveredPrompt,
  INBOX_CAP,
  STALE_NOTE_AFTER_MS,
  type BusTurnEnd,
  type InboxHost,
  type InboxMessageOptions,
} from '../../src/agentBus/agentInbox';
import { parseForgeInboundPrompt } from '../../src/agentBus/busContent';

const tick = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms));

function host(overrides: Partial<InboxHost> = {}): InboxHost & {
  submitted: string[];
  warnings: string[];
  busy: boolean;
  finish: (end?: BusTurnEnd) => void;
  finished: { from: string; durationMs: number }[];
  ends: BusTurnEnd[];
} {
  const state = {
    submitted: [] as string[],
    warnings: [] as string[],
    busy: false,
    release: [] as ((end: BusTurnEnd) => void)[],
    finished: [] as { from: string; durationMs: number }[],
    ends: [] as BusTurnEnd[],
  };
  return {
    get submitted() {
      return state.submitted;
    },
    get warnings() {
      return state.warnings;
    },
    get busy() {
      return state.busy;
    },
    set busy(v: boolean) {
      state.busy = v;
    },
    get finished() {
      return state.finished;
    },
    get ends() {
      return state.ends;
    },
    finish: (end: BusTurnEnd = { kind: 'completed' }) => state.release.shift()?.(end),
    // Every message of this fake belongs to one chat, so these tests keep the
    // one-turn-at-a-time behaviour they were written for.
    laneOf: () => 'chat',
    isBusy: () => state.busy,
    submit: (prompt) => {
      state.submitted.push(prompt);
      return new Promise<BusTurnEnd>((r) => state.release.push(r));
    },
    warn: (m) => state.warnings.push(m),
    onBusTurnFinished: (from, durationMs, end) => {
      state.finished.push({ from, durationMs });
      state.ends.push(end);
    },
    ...overrides,
  };
}

describe('AgentInbox', () => {
  it('a steer jumps the queue and runs as soon as the current turn ends', async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('running');
    await tick();
    inbox.accept('queued');
    expect(inbox.accept('steer', 'claude', true)?.position).toBe(1);
    h.finish();
    await tick();
    expect(h.submitted).toEqual(['running', 'steer']);
    inbox.dispose();
  });

  it('submits at once when idle, and one turn at a time', async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('one');
    inbox.accept('two');
    await tick();
    expect(h.submitted).toEqual(['one']);
    h.finish();
    await tick();
    expect(h.submitted).toEqual(['one', 'two']);
    inbox.dispose();
  });

  it('waits while the chat is busy', async () => {
    const h = host();
    h.busy = true;
    const inbox = new AgentInbox(h, 5);
    inbox.accept('later');
    await tick();
    expect(h.submitted).toEqual([]);
    h.busy = false;
    await tick();
    expect(h.submitted).toEqual(['later']);
    inbox.dispose();
  });

  it('treats a chat that is not up yet as busy', async () => {
    let ready = false;
    const h = host({
      isBusy: () => {
        if (!ready) throw new ReferenceError('sidebarProvider is not initialized');
        return false;
      },
    });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('early');
    await tick();
    expect(h.submitted).toEqual([]);
    ready = true;
    await tick();
    expect(h.submitted).toEqual(['early']);
    inbox.dispose();
  });

  it("cancel removes only the sender's own messages that have not started (F3)", async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('running', 'claude');
    await tick();
    const a = inbox.accept('a', 'claude');
    const b = inbox.accept('b', 'codex');
    inbox.accept('c', 'claude');
    expect(a?.id).toMatch(/^m[0-9a-f]{8}$/);
    expect(a?.id).not.toBe(b?.id);
    expect(inbox.cancel('codex', a?.id as string)).toBe(0); // not codex's
    expect(inbox.cancel('claude', a?.id as string)).toBe(1);
    expect(inbox.cancel('claude', a?.id as string)).toBe(0); // already gone
    expect(inbox.cancel('claude', 'all')).toBe(1); // 'c'; 'running' has started
    h.finish();
    await tick();
    expect(h.submitted).toEqual(['running', 'b']);
    inbox.dispose();
  });

  it('caps the queue', () => {
    const h = host();
    h.busy = true;
    const inbox = new AgentInbox(h, 1_000);
    for (let i = 0; i < INBOX_CAP; i++) expect(inbox.accept(`m${i}`)?.position).toBe(i + 1);
    expect(inbox.accept('overflow')).toBeUndefined();
    inbox.dispose();
    expect(inbox.pending).toBe(0);
  });

  it('counts queued messages for each sender', () => {
    const h = host();
    h.busy = true;
    const inbox = new AgentInbox(h, 1_000);
    inbox.accept('one', 'claude');
    inbox.accept('two', 'codex');
    inbox.accept('three', 'claude');
    expect(inbox.pendingFrom('claude')).toBe(2);
    expect(inbox.pendingFrom('codex')).toBe(1);
    expect(inbox.pendingFrom('unknown')).toBe(0);
    inbox.dispose();
  });

  it('names the chat the next queued message will run in, and none for --new (audit F3)', () => {
    const h = host();
    h.busy = true;
    const inbox = new AgentInbox(h, 1_000);
    inbox.accept('fresh', 'claude', false, { newChat: true });
    inbox.accept('routed', 'claude', false, { targetConversationId: 'c2' });
    inbox.accept('later', 'codex', false, { targetConversationId: 'c3' });
    // The queue's own order is the order Forge takes messages in, so the first
    // match is the chat that will next hold this sender's turn. A `--new`
    // message has no chat until it starts, so it reports none even when a
    // later message of the same sender names one.
    expect(inbox.queuedTargetConversation('claude')).toBeUndefined();
    expect(inbox.queuedTargetConversation('codex')).toBe('c3');
    expect(inbox.queuedTargetConversation('nobody')).toBeUndefined();
    inbox.dispose();
  });

  it('warns the user when a submit fails with no bus sender, then moves on', async () => {
    // No `from`, so there is no sender to notify — only the window is told.
    const h = host({ submit: () => Promise.reject(new Error('no model')) });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('a');
    inbox.accept('b');
    await tick();
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[0]).toContain('no model');
    expect(h.finished).toEqual([]);
    inbox.dispose();
  });

  it('fires the finished notice for a bus-started turn, once, at turn end (§9, P1)', async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('prompt', 'codex');
    await tick();
    expect(h.submitted).toEqual(['prompt']);
    expect(h.finished).toEqual([]); // not yet: the turn is still running
    h.finish();
    await tick();
    expect(h.finished).toEqual([{ from: 'codex', durationMs: expect.any(Number) }]);
    inbox.dispose();
  });

  it('passes a cancelled turn through, so the sender is not told it finished', async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('ping', 'claude');
    await tick();
    h.finish({ kind: 'cancelled' });
    await tick();
    expect(h.ends).toEqual([{ kind: 'cancelled' }]);
    inbox.dispose();
  });

  it('does not fire a finished notice for a turn with no bus sender', async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('typed-by-user'); // no `from`
    await tick();
    h.finish();
    await tick();
    expect(h.finished).toEqual([]);
    inbox.dispose();
  });

  it('fires a finished notice for each bus message, in order', async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('one', 'claude');
    inbox.accept('two', 'codex');
    await tick();
    h.finish();
    await tick();
    h.finish();
    await tick();
    expect(h.finished.map((f) => f.from)).toEqual(['claude', 'codex']);
    inbox.dispose();
  });

  it('tells the sender when the turn fails to submit, instead of dropping it', async () => {
    // A `--new` at the chat cap throws out of `submit`, so `onBusTurnFinished`
    // never ran on the success path. Without this notice the sender got a 202
    // and silence — the message vanished with only a window toast as evidence.
    const h = host({ submit: () => Promise.reject(new Error('no model')) });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('a', 'codex');
    await tick();
    expect(h.finished).toHaveLength(1);
    expect(h.ends).toEqual([{ kind: 'failed', error: 'no model' }]);
    expect(h.warnings).toHaveLength(1);
    // Reported, not replayed: a prompt re-queued after the user fixes the cap
    // is stale intent.
    expect(inbox.pending).toBe(0);
    inbox.dispose();
  });

  it('reports an undeliverable turn exactly once and never re-queues it', async () => {
    let attempts = 0;
    const h = host({
      submit: () => {
        attempts++;
        return Promise.reject(new Error('no open chat can be archived'));
      },
    });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('a', 'claude');
    await tick(40);
    expect(h.finished.filter((f) => f.from === 'claude')).toHaveLength(1);
    expect(attempts).toBe(1); // not retried
    expect(inbox.pending).toBe(0);
    inbox.dispose();
  });

  it('keeps a lost race with a typed prompt queued, and says nothing to the sender', async () => {
    // The other branch of the same catch: a chat that BECAME busy keeps its
    // place in line, so there is no failure to report yet.
    let first = true;
    const h = host({
      isBusy: () => !first,
      submit: () => {
        if (first) {
          first = false;
          return Promise.reject(new Error('someone typed first'));
        }
        return new Promise<BusTurnEnd>(() => undefined);
      },
    });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('a', 'codex');
    await tick();
    expect(h.finished).toEqual([]);
    expect(h.warnings).toEqual([]);
    expect(inbox.pending).toBe(1);
    inbox.dispose();
  });

  it('F-08: marks the bus turn started and clears the status file even when the turn fails', async () => {
    const started: string[] = [];
    const cleared: string[] = [];
    const h = host({
      submit: () => Promise.reject(new Error('no model')),
      onBusTurnStarted: (id) => started.push(id),
      onBusTurnStatusCleared: (id) => cleared.push(id),
    });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('a', 'codex');
    await tick();
    expect(started).toHaveLength(1);
    expect(cleared).toEqual(started); // cleared with the same turn id
    // The sender IS told it failed — a turn that never started still has a
    // sender waiting on an answer.
    expect(h.ends).toEqual([{ kind: 'failed', error: 'no model' }]);
    inbox.dispose();
  });

  it('F-08: clears the status file after a successful bus turn too', async () => {
    const started: string[] = [];
    const cleared: string[] = [];
    const h = host({
      onBusTurnStarted: (id) => started.push(id),
      onBusTurnStatusCleared: (id) => cleared.push(id),
    });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('a', 'codex');
    await tick();
    h.finish();
    await tick();
    expect(started).toHaveLength(1);
    expect(cleared).toEqual(started);
    expect(h.finished).toHaveLength(1); // notice fires on success
    inbox.dispose();
  });

  it("hands a busy chat's plain messages to its running turn, leaving the rest queued", async () => {
    const h = host();
    h.busy = true;
    const inbox = new AgentInbox(h, 5);
    inbox.accept('for A', 'claude');
    inbox.accept('for B', 'codex');
    inbox.accept('new chat', 'claude', false, { newChat: true });
    inbox.accept('switch model', 'claude', false, { model: 'm' });
    inbox.accept('steer', 'claude', true);
    inbox.accept('unattended', 'claude', false, { unattended: true });
    const target = (options?: { from?: string }): string =>
      options?.from === 'claude' ? 'A' : 'B';
    // A turn that never ends would starve these; the next tool-round gap takes them.
    expect(inbox.claimMidTurn('A', target)).toEqual([
      { content: 'for A', options: { from: 'claude' } },
    ]);
    expect(inbox.claimMidTurn('A', target)).toEqual([]);
    expect(inbox.pending).toBe(5);
    expect(inbox.claimMidTurn('B', target)).toEqual([
      { content: 'for B', options: { from: 'codex' } },
    ]);
    await tick();
    expect(h.submitted).toEqual([]); // claimed messages never also start a turn
    inbox.dispose();
  });

  it('claims a sender message with its host options for the reply lifecycle', () => {
    const h = host();
    h.busy = true;
    const inbox = new AgentInbox(h, 5);
    const sender = {
      kind: 'claude' as const,
      sessionId: '00000000-0000-4000-8000-000000000071',
      title: 'Claude task',
    };
    inbox.accept('**Claude says:**\n\nreview this', 'claude', false, {
      sender,
      targetConversationId: 'chat',
      pendingReplyId: 'reply-1',
    });

    expect(inbox.claimMidTurn('chat', () => 'chat')).toEqual([
      {
        content: '**Claude says:**\n\nreview this',
        options: { from: 'claude', sender, targetConversationId: 'chat', pendingReplyId: 'reply-1' },
      },
    ]);
    expect(inbox.pending).toBe(0);
    expect(inbox.pendingFrom('claude')).toBe(0);
    inbox.dispose();
  });

  it.each([
    ['steer', {}, true],
    ['--new', { newChat: true }, false],
    ['--model', { model: 'qwen' }, false],
    ['--unattended', { unattended: true }, false],
  ] as const)('does not claim a sender message marked %s', (_flag, special, steer) => {
    const h = host();
    h.busy = true;
    const inbox = new AgentInbox(h, 5);
    inbox.accept('reply owed', 'codex', steer, {
      ...special,
      sender: {
        kind: 'codex',
        sessionId: '00000000-0000-4000-8000-000000000072',
        title: 'Codex task',
      },
      targetConversationId: 'chat',
      pendingReplyId: 'reply-2',
    });

    expect(inbox.claimMidTurn('chat', () => 'chat')).toEqual([]);
    expect(inbox.pending).toBe(1);
    inbox.dispose();
  });
});

describe('busTurnEndLine', () => {
  it('only a completed turn says finished; the others say what happened', () => {
    expect(busTurnEndLine({ kind: 'completed' }, 60_000)).toMatch(/^finished · 1 min/);
    expect(busTurnEndLine({ kind: 'completed' }, 14_200)).toMatch(/^finished · 14 s ·/);
    expect(busTurnEndLine({ kind: 'failed', error: 'fetch failed' }, 120_000)).toBe(
      'failed · 2 min · the turn you started ended with an error: fetch failed',
    );
    expect(busTurnEndLine({ kind: 'cancelled' }, 60_000)).toMatch(
      /^cancelled · 1 min · .*before it answered/,
    );
    expect(busTurnEndLine({ kind: 'interrupted' }, 60_000)).toMatch(/^interrupted · /);
  });
});

describe('deliveredPrompt', () => {
  const prompt = '**claude says:**\n\nredo 70K\n\n_(Agent-bus message. To answer, ...)_';

  it('leaves a promptly delivered message untouched', () => {
    const item = { prompt, from: 'claude', queuedAt: 1_000 };
    expect(deliveredPrompt(item, 1_000 + STALE_NOTE_AFTER_MS - 1)).toBe(prompt);
  });

  it('says how long a message waited and that later words from its sender win', () => {
    const item = { prompt, from: 'claude', queuedAt: 1_000 };
    const out = deliveredPrompt(item, 1_000 + 12 * 60_000);
    expect(out.startsWith(prompt)).toBe(true);
    expect(out).toContain('Queued: claude wrote this at');
    expect(out).toContain('12 min before it reached you');
    expect(out).toContain('including an answer to your question, is newer and overrides it');
    expect(parseForgeInboundPrompt(out)?.text).toBe('redo 70K');
  });

  it('never annotates a message with no bus sender', () => {
    expect(deliveredPrompt({ prompt: 'typed', queuedAt: 0 }, 10 * 60_000)).toBe('typed');
  });
});

/**
 * A host with two chats, X and Y. Each is busy only while its own turn runs,
 * the way `isBusy` works in the real wiring (`streamingConversationIds` per
 * conversation), so a message addressed to Y has no reason to wait on X.
 * `failChats` makes those chats' `submit` reject, as a chat cap or a missing
 * model does.
 */
function laneHost(failChats: string[] = []): {
  host: InboxHost;
  turns: { prompt: string; chat: string; finish: (end?: BusTurnEnd) => void }[];
  notices: { from: string; end: BusTurnEnd }[];
  finishChat: (chat: string, end?: BusTurnEnd) => void;
} {
  const turns: { prompt: string; chat: string; finish: (end?: BusTurnEnd) => void }[] = [];
  const notices: { from: string; end: BusTurnEnd }[] = [];
  /** The turn each chat has running now, so `finishChat` ends the right one. */
  const running = new Map<string, (end?: BusTurnEnd) => void>();
  const streaming = new Set<string>();
  let created = 0;
  const chatOf = (options?: InboxMessageOptions): string | undefined =>
    options?.newChat ? undefined : options?.targetConversationId ?? 'X';
  const host: InboxHost = {
    laneOf: (options) => chatOf(options),
    isBusy: (options) => {
      const chat = chatOf(options);
      return chat !== undefined && streaming.has(chat);
    },
    submit: (prompt, options) => {
      const chat = options?.newChat ? `new-${++created}` : (chatOf(options) as string);
      let settle: (end: BusTurnEnd) => void = () => {};
      const finish = (end: BusTurnEnd = { kind: 'completed' }): void => {
        if (running.get(chat) === finish) running.delete(chat);
        streaming.delete(chat);
        settle(end);
      };
      turns.push({ prompt, chat, finish });
      running.set(chat, finish);
      if (failChats.includes(chat)) {
        running.delete(chat);
        return Promise.reject(new Error('no model'));
      }
      streaming.add(chat);
      return new Promise<BusTurnEnd>((resolve) => {
        settle = resolve;
      });
    },
    warn: () => {},
    onBusTurnFinished: (from, _durationMs, end) => {
      notices.push({ from, end });
    },
  };
  return {
    host,
    turns,
    notices,
    finishChat: (chat, end) => {
      const finish = running.get(chat);
      if (!finish) throw new Error(`no turn is running in chat ${chat}`);
      finish(end);
    },
  };
}

describe('AgentInbox runs different chats at once (INBOX_PARALLEL_CHATS_PLAN)', () => {
  it('starts messages for two chats before either finishes', async () => {
    // The measured bug: two `say` messages 8 s apart to two chats on a model
    // that serves two requests at once ran back to back — lane A 30 min, lane
    // B starting only when A ended and finishing at 61 min.
    const { host, turns } = laneHost();
    const inbox = new AgentInbox(host, 5);
    inbox.accept('for X', 'claude', false, { targetConversationId: 'X' });
    inbox.accept('for Y', 'codex', false, { targetConversationId: 'Y' });
    await tick();
    expect(turns.map((turn) => turn.chat)).toEqual(['X', 'Y']);
    expect(turns.map((turn) => turn.prompt)).toEqual(['for X', 'for Y']);
    inbox.dispose();
  });

  it('keeps one chat strictly in order, one turn at a time', async () => {
    const { host, turns, finishChat } = laneHost();
    const inbox = new AgentInbox(host, 5);
    inbox.accept('one X', 'claude', false, { targetConversationId: 'X' });
    inbox.accept('two X', 'codex', false, { targetConversationId: 'X' });
    await tick();
    expect(turns.map((turn) => turn.prompt)).toEqual(['one X']);
    finishChat('X');
    await tick();
    expect(turns.map((turn) => turn.prompt)).toEqual(['one X', 'two X']);
    inbox.dispose();
  });

  it('a steer jumps its own chat line and leaves the other chat running', async () => {
    const { host, turns, finishChat } = laneHost();
    const inbox = new AgentInbox(host, 5);
    inbox.accept('running X', 'claude', false, { targetConversationId: 'X' });
    await tick(); // X is mid-turn; its later messages queue behind it
    inbox.accept('next X', 'claude', false, { targetConversationId: 'X' });
    inbox.accept('steer X', 'claude', true, { targetConversationId: 'X' });
    inbox.accept('for Y', 'codex', false, { targetConversationId: 'Y' });
    await tick();
    // Y starts now: two messages for X are waiting, and that is X's business.
    expect(turns.map((turn) => turn.chat)).toEqual(['X', 'Y']);
    finishChat('X');
    await tick();
    expect(turns.map((turn) => turn.prompt)).toEqual(['running X', 'for Y', 'steer X']);
    finishChat('X');
    await tick();
    expect(turns.map((turn) => turn.prompt)).toEqual([
      'running X',
      'for Y',
      'steer X',
      'next X',
    ]);
    inbox.dispose();
  });

  it('two --new messages get two chats and neither waits on the other', async () => {
    const { host, turns } = laneHost();
    const inbox = new AgentInbox(host, 5);
    inbox.accept('new a', 'claude', false, { newChat: true });
    inbox.accept('new b', 'codex', false, { newChat: true });
    await tick();
    // Nothing has been finished, so neither turn ended: a --new message cannot
    // be blocked by another --new, and the two chats are distinct.
    expect(turns.map((turn) => turn.chat)).toEqual(['new-1', 'new-2']);
    expect(new Set(turns.map((turn) => turn.chat)).size).toBe(2);
    inbox.dispose();
  });

  it('a failure in one chat does not stop another, and tells its sender once', async () => {
    const { host, turns, notices } = laneHost(['X']);
    const inbox = new AgentInbox(host, 5);
    inbox.accept('for X', 'claude', false, { targetConversationId: 'X' });
    inbox.accept('for Y', 'codex', false, { targetConversationId: 'Y' });
    await tick();
    expect(turns.map((turn) => turn.chat)).toEqual(['X', 'Y']);
    expect(notices).toEqual([{ from: 'claude', end: { kind: 'failed', error: 'no model' } }]);
    expect(inbox.pending).toBe(0); // reported, not replayed
    inbox.dispose();
  });

  it('F-08: two turns from one sender in the same millisecond get different ids', async () => {
    const started: string[] = [];
    const cleared: string[] = [];
    const { host, turns } = laneHost();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const inbox = new AgentInbox(
      {
        ...host,
        onBusTurnStarted: (id) => started.push(id),
        onBusTurnStatusCleared: (id) => cleared.push(id),
      },
      5,
    );
    inbox.accept('for X', 'claude', false, { targetConversationId: 'X' });
    inbox.accept('for Y', 'claude', false, { targetConversationId: 'Y' });
    await tick();
    // `bus-<from>-<startedAt>` alone was the same record for both, and the
    // second turn's clear would have erased the first one's still-running file.
    expect(started).toHaveLength(2);
    expect(new Set(started).size).toBe(2);
    expect(started[0]).toMatch(/^bus-claude-1700000000000-m[0-9a-f]{8}$/);
    expect(cleared).toEqual([]); // both still running
    turns[0]!.finish();
    turns[1]!.finish();
    await tick();
    expect([...cleared].sort()).toEqual([...started].sort());
    vi.restoreAllMocks();
    inbox.dispose();
  });
});

describe('a held message', () => {
  it('never starts until released, even once its lane is free', async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('running');
    await tick();
    const steer = inbox.accept('steer', 'claude', true, { hold: true });
    expect(steer?.position).toBe(1);
    h.finish(); // the lane frees while the steer's guard is still deciding
    await tick();
    expect(h.submitted).toEqual(['running']); // the drain skipped the held steer
    expect(inbox.release(steer!.id)).toBe(true);
    await tick();
    expect(h.submitted).toEqual(['running', 'steer']);
    inbox.dispose();
  });

  it('holds its lane so nothing queued later slips into the chat first', async () => {
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('running');
    await tick();
    const steer = inbox.accept('steer', 'claude', true, { hold: true });
    inbox.accept('follow-up', 'sara');
    h.finish();
    await tick();
    expect(h.submitted).toEqual(['running']); // the follow-up waits behind the held steer
    inbox.release(steer!.id);
    await tick();
    expect(h.submitted).toEqual(['running', 'steer']);
    h.finish();
    await tick();
    expect(h.submitted).toEqual(['running', 'steer', 'follow-up']);
    inbox.dispose();
  });

  it('a refused steer can be cancelled while it is still held', () => {
    const h = host();
    h.busy = true; // the lane stays busy: nothing starts either way
    const inbox = new AgentInbox(h, 5);
    const steer = inbox.accept('steer', 'claude', true, { hold: true });
    expect(inbox.pending).toBe(1);
    expect(inbox.cancel('claude', steer!.id)).toBe(1);
    expect(inbox.pending).toBe(0);
    expect(inbox.release(steer!.id)).toBe(false);
    inbox.dispose();
  });

  it('cancelling a held steer resumes the follow-up that waited behind it', async () => {
    // The regression: the removal scheduled no pass, so the follow-up sat on
    // a free lane until some unrelated event woke the queue.
    const h = host();
    const inbox = new AgentInbox(h, 5);
    inbox.accept('running');
    await tick();
    const steer = inbox.accept('steer', 'claude', true, { hold: true });
    inbox.accept('follow-up', 'sara');
    h.finish();
    await tick();
    expect(h.submitted).toEqual(['running']); // the follow-up waits behind the held steer
    inbox.cancel('claude', steer!.id);
    await tick();
    expect(h.submitted).toEqual(['running', 'follow-up']); // the removal itself wakes the queue
    inbox.dispose();
  });
});
