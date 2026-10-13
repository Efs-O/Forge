/**
 * The elapsed-time note: one internal mid-turn tell per task, once the task has
 * run `elapsed_time_note.after_minutes` minutes. Fake clock throughout; the
 * drain is called the way `MidTurnTellDrain` calls a source.
 */

import { describe, expect, it } from 'vitest';
import { ElapsedTimeNote } from '../../src/agent/elapsedTimeNote';
import { attachCurrentTaskReasoning } from '../../src/agent/preserveThinking';
import { ForgeConfigSchema } from '../../src/config/schema';
import type { ChatMessage } from '../../src/llm/types';

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
  };
}

const off = () => undefined;
const after30 = () => 30;

describe('ElapsedTimeNote', () => {
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

  it('does not end the task for preserve_thinking', async () => {
    const h = harness(after30);
    h.note.taskStarted('c1');
    h.advance(30);
    const [note] = (await h.drain()).messages;
    const transcript: ChatMessage[] = [
      { role: 'user', content: 'hunt the bugs' },
      { role: 'assistant', content: 'reading', reasoning: 'plan: read one more file' },
      note,
      { role: 'assistant', content: 'still reading', reasoning: 'found three so far' },
    ];
    const sent = attachCurrentTaskReasoning(transcript);
    expect(sent[1].reasoning_content).toBe('plan: read one more file');
    expect(sent[3].reasoning_content).toBe('found three so far');
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
