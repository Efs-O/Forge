/**
 * The elapsed-time note: one internal mid-turn tell per task, from whichever
 * timer is running — the model's own `set_checkin` estimate, or phase 1's
 * `elapsed_time_note.after_minutes` fallback. Fake clock throughout; the drain
 * is called the way `MidTurnTellDrain` calls a source.
 */

import { describe, expect, it, vi } from 'vitest';
import { ElapsedTimeNote } from '../../src/agent/elapsedTimeNote';
import { runCompactionWithPolicy } from '../../src/sidebar/compactionAttemptPolicy';
import type { CompactionDeps, CompactionOutcome } from '../../src/sidebar/CompactionService';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import { ForgeConfigSchema } from '../../src/config/schema';

const MINUTE = 60_000;

/** A note source on a clock the test drives, with the setting under `after`. */
function harness(after: () => number | undefined) {
  let nowMs = 0;
  const note = new ElapsedTimeNote(after, () => nowMs);
  return {
    note,
    advance: (minutes: number) => {
      nowMs = minutes * MINUTE;
    },
    drain: (conversationId = 'c1') => note.source(conversationId),
    text: async (conversationId = 'c1') => {
      const drained = await note.source(conversationId);
      return drained.messages.length ? String(drained.messages[0].content) : undefined;
    },
  };
}

const off = () => undefined;
const after30 = () => 30;

describe('ElapsedTimeNote fallback (no check-in)', () => {
  it('never fires when the setting is absent, even after 10 hours', async () => {
    const h = harness(off);
    h.note.taskStarted('c1');
    h.advance(600);
    expect(await h.drain()).toEqual({ messages: [] });
  });

  it('fires once at the threshold, and never again for that task', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.advance(29 + 59 / 60);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(30);
    const fired = await h.drain();
    expect(fired.messages).toHaveLength(1);
    h.advance(31);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(300);
    expect(await h.drain()).toEqual({ messages: [] });
  });

  it('restarts the clock when a new task starts, so it can fire again', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.advance(30);
    expect((await h.drain()).messages).toHaveLength(1);
    h.note.taskStarted('c1');
    h.advance(59);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(60);
    expect((await h.drain()).messages).toHaveLength(1);
  });

  it('keeps a separate clock per conversation', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.advance(20);
    h.note.taskStarted('c2');
    h.advance(30);
    expect((await h.drain('c1')).messages).toHaveLength(1);
    expect(await h.drain('c2')).toEqual({ messages: [] });
    h.advance(50);
    expect((await h.drain('c2')).messages).toHaveLength(1);
  });

  it('never fires for a conversation whose task never started', async () => {
    const h = harness(after30);
    h.advance(600);
    expect(await h.drain('c1')).toEqual({ messages: [] });
  });

  it('reads the setting live: turned on at 40 min, it fires at the next drain', async () => {
    let after: number | undefined = undefined;
    const h = harness(() => after);
    h.note.taskStarted('c1');
    h.advance(20);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(40);
    expect(await h.drain()).toEqual({ messages: [] });
    after = 30;
    const fired = await h.drain();
    expect(fired.messages).toHaveLength(1);
    expect(String(fired.messages[0].content)).toContain('40 minutes');
  });

  it('is an internal mid-turn user message naming the real elapsed minutes', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.advance(45);
    const [message] = (await h.drain()).messages;
    expect(message.role).toBe('user');
    expect(message.internal).toBe(true);
    expect(message.midTurn).toBe(true);
    const text = String(message.content);
    expect(text).toContain('[Forge]');
    expect(text).toContain('45 minutes');
    expect(text).toContain('do not skip checks, tests or verification');
  });
});

describe('ElapsedTimeNote check-in (set by the model)', () => {
  it('fires once at the model estimate, naming its own stage', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.note.setCheckin('c1', 20, 'writing');
    h.advance(19 + 59 / 60);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(20);
    const text = await h.text();
    expect(text).toContain('Check-in: 20 minutes ago');
    expect(text).toContain('writing the code or the report');
    expect(await h.drain()).toEqual({ messages: [] });
  });

  it('a check-in overrides the fallback: nothing at 30, the note at 60', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.note.setCheckin('c1', 60, 'testing');
    h.advance(30);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(60);
    const text = await h.text();
    expect(text).toContain('Check-in: 60 minutes ago');
    expect(text).toContain('running tests');
  });

  it('re-arming after a firing gives a second note one estimate later', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.note.setCheckin('c1', 20, 'writing');
    h.advance(20);
    expect((await h.drain()).messages).toHaveLength(1);
    h.note.setCheckin('c1', 15, 'done');
    h.advance(30);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(35);
    const text = await h.text();
    expect(text).toContain('Check-in: 15 minutes ago');
    expect(text).toContain('finished');
  });

  it('re-arming before it fires replaces the timer', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.note.setCheckin('c1', 20, 'writing');
    h.advance(10);
    h.note.setCheckin('c1', 40, 'testing');
    h.advance(20);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(50);
    const text = await h.text();
    expect(text).toContain('Check-in: 40 minutes ago');
  });

  it('a compaction after the note restarts the same check-in clock', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.note.setCheckin('c1', 20, 'writing');
    h.advance(20);
    expect((await h.drain()).messages).toHaveLength(1);
    h.advance(25);
    h.note.compacted('c1');
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(40);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(45);
    const text = await h.text();
    // The trigger restarted at the compaction; the minutes still count from the estimate.
    expect(text).toContain('Check-in: 45 minutes ago');
    expect(text).toContain('writing the code or the report');
  });

  it('a compaction with no check-in restarts the fallback clock', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.advance(20);
    h.note.compacted('c1');
    h.advance(40);
    expect(await h.drain()).toEqual({ messages: [] });
    h.advance(50);
    const text = await h.text();
    expect(text).toContain('running for 50 minutes');
  });

  it('a new user-typed task clears the check-in, so the fallback applies again', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.note.setCheckin('c1', 60, 'writing');
    h.advance(40);
    h.note.taskStarted('c1');
    h.advance(70);
    const text = await h.text();
    expect(text).toContain('running for 30 minutes');
    expect(text).not.toContain('Check-in:');
  });

  it('with the block absent, a check-in never fires', async () => {
    const h = harness(off);
    h.note.taskStarted('c1');
    expect(h.note.setCheckin('c1', 10, 'writing').dueAt).toBe(10 * MINUTE);
    h.advance(600);
    expect(await h.drain()).toEqual({ messages: [] });
  });

  it('a check-in for an untracked conversation still gets a clock', async () => {
    const h = harness(after30);
    h.note.setCheckin('c9', 20, 'done');
    h.advance(20);
    const text = await h.text('c9');
    expect(text).toContain('Check-in: 20 minutes ago');
    expect(text).toContain('finished');
  });

  it('the check-in note is internal and mid-turn like the fallback', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.note.setCheckin('c1', 30, 'testing');
    h.advance(30);
    const [message] = (await h.drain()).messages;
    expect(message.role).toBe('user');
    expect(message.internal).toBe(true);
    expect(message.midTurn).toBe(true);
    expect(String(message.content)).toContain('call set_checkin again');
  });
});

describe('the compaction commit point', () => {
  const conv = { id: 'c1', messages: [] } as unknown as ConversationRuntime;
  const depsFor = (onCompacted: (conversationId: string) => void): CompactionDeps =>
    ({ getConversation: () => conv, onCompacted }) as unknown as CompactionDeps;
  const run = (
    deps: CompactionDeps,
    outcome: CompactionOutcome,
  ): Promise<CompactionOutcome> =>
    runCompactionWithPolicy(deps, 'c1', { auto: false }, async () => outcome);

  it('re-arms the clock when a compaction commits', async () => {
    const seen = vi.fn();
    expect(await run(depsFor(seen), 'compacted')).toBe('compacted');
    expect(seen).toHaveBeenCalledWith('c1');
  });

  it('does not call onCompacted for a skipped or failed compaction', async () => {
    for (const outcome of ['skipped', 'failed'] as const) {
      const seen = vi.fn();
      expect(await run(depsFor(seen), outcome)).toBe(outcome);
      expect(seen).not.toHaveBeenCalled();
    }
  });

  it('a hook that throws cannot turn a committed compaction into a failure', async () => {
    const deps = depsFor(() => {
      throw new Error('hook blew up');
    });
    expect(await run(deps, 'compacted')).toBe('compacted');
  });
});

describe('elapsed_time_note config schema', () => {
  const base = () => ({
    active_model: 'm',
    models: [{ name: 'm', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' }],
  });
  const parse = (after: unknown) =>
    ForgeConfigSchema.safeParse({ ...base(), elapsed_time_note: { after_minutes: after } });

  it('rejects values outside 5-240 and non-integers', () => {
    for (const bad of [4, 241, 12.5, '30']) expect(parse(bad).success, `${bad}`).toBe(false);
  });

  it('accepts the bounds, and no block at all', () => {
    expect(parse(5).success).toBe(true);
    expect(parse(240).success).toBe(true);
    const absent = ForgeConfigSchema.safeParse(base());
    expect(absent.success).toBe(true);
    expect(absent.success && absent.data.elapsed_time_note).toBeUndefined();
  });
});
