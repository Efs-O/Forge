import { describe, expect, it } from 'vitest';
import { AgentInbox, busTurnEndLine, INBOX_CAP, type BusTurnEnd, type InboxHost } from '../../src/agentBus/agentInbox';

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

  it('warns the user when a submit fails, then moves on', async () => {
    const h = host({ submit: () => Promise.reject(new Error('no model')) });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('a');
    inbox.accept('b');
    await tick();
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[0]).toContain('no model');
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

  it('does not fire a finished notice when the turn fails to submit', async () => {
    const h = host({ submit: () => Promise.reject(new Error('no model')) });
    const inbox = new AgentInbox(h, 5);
    inbox.accept('a', 'codex');
    await tick();
    expect(h.finished).toEqual([]);
    expect(h.warnings).toHaveLength(1);
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
    expect(h.finished).toEqual([]); // no notice on failure
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
});

describe('busTurnEndLine', () => {
  it('only a completed turn says finished; the others say what happened', () => {
    expect(busTurnEndLine({ kind: 'completed' }, 1)).toMatch(/^finished · 1 min/);
    expect(busTurnEndLine({ kind: 'failed', error: 'fetch failed' }, 2)).toBe(
      'failed · 2 min · the turn you started ended with an error: fetch failed',
    );
    expect(busTurnEndLine({ kind: 'cancelled' }, 1)).toMatch(/^cancelled · 1 min · .*before it answered/);
    expect(busTurnEndLine({ kind: 'interrupted' }, 1)).toMatch(/^interrupted · /);
  });
});
