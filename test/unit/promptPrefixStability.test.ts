/**
 * Prompt-prefix stability.
 *
 * llama-server reuses the longest common prefix between the incoming prompt
 * and the one its slot last held, and re-evaluates everything after the first
 * divergent token. Measured on b10430: an append-only turn re-evaluated 21
 * tokens in 618 ms, while changing ONE LINE near the head of the same 4.9K
 * prompt re-evaluated 4971 tokens in 7605 ms.
 *
 * So these tests assert on WHERE the model-facing copy diverges, not just on
 * what it contains. A change that keeps every assertion in
 * `test/unit/PlanTools.test.ts` green can still move a volatile field back to
 * the head and cost 12x on every turn, invisibly.
 *
 * See docs/plans/PROMPT_PREFIX_STABILITY_PLAN.md.
 */

import { describe, expect, it } from 'vitest';
import { injectTurnContext } from '../../src/sidebar/turnContext';
import { PLAN_GUIDANCE, renderPlan } from '../../src/tools/planTools';
import { applyCompactionWindow } from '../../src/sidebar/compactionWindow';
import type { ChatMessage } from '../../src/llm/types';
import type { ConversationPlan, PlanItem } from '../../src/sidebar/sessionTypes';

const ITEMS: PlanItem[] = [
  { text: 'inspect BackendPool', status: 'done' },
  { text: 'fix lease release', status: 'active' },
  { text: 'add regression tests', status: 'pending' },
];
const PLAN: ConversationPlan = { items: ITEMS, updatedAt: 1_000 };

const SYSTEM = 'You are Forge. Workspace root: /repo';

function conversation(): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'tool', content: 'read_file result', tool_call_id: 'a' },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'second request' },
  ];
}

/** Index of the first message that differs, or -1 when the two are identical. */
function firstDivergence(a: ChatMessage[], b: ChatMessage[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return i;
  }
  return -1;
}

describe('A - normal turn extension', () => {
  it('leaves every earlier message byte-identical and adds only at the tail', () => {
    const before = injectTurnContext(conversation(), { activeFile: '/repo/a.ts', plan: PLAN });
    const grown = injectTurnContext(
      [
        ...conversation(),
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'third request' },
      ],
      { activeFile: '/repo/a.ts', plan: PLAN },
    );

    // The turn-context block moves with the latest user message, so the old
    // one loses it — everything before that point must be untouched.
    expect(grown.slice(0, 5)).toEqual(before.slice(0, 5));
    expect(grown).toHaveLength(before.length + 2);
  });
});

describe('B - active file change', () => {
  it('does not touch the system message or any history', () => {
    const a = injectTurnContext(conversation(), { activeFile: '/repo/a.ts', plan: PLAN });
    const b = injectTurnContext(conversation(), { activeFile: '/repo/b.ts', plan: PLAN });

    expect(a[0]).toEqual({ role: 'system', content: SYSTEM });
    expect(b[0]).toEqual({ role: 'system', content: SYSTEM });
    // This is the whole point: divergence at the LAST message, not the first.
    expect(firstDivergence(a, b)).toBe(a.length - 1);
  });

  it('never renders the active file into the system prompt', () => {
    const out = injectTurnContext(conversation(), { activeFile: '/repo/secret.ts' });
    expect(out[0]?.content).not.toContain('secret.ts');
    expect(String(out[out.length - 1]?.content)).toContain('/repo/secret.ts');
  });
});

describe('C - plan unchanged, clock advanced', () => {
  it('produces a byte-identical prompt', () => {
    const stale: ConversationPlan = { items: ITEMS, updatedAt: 0 };
    const fresh: ConversationPlan = { items: ITEMS, updatedAt: 9_999_999 };
    expect(injectTurnContext(conversation(), { plan: stale })).toEqual(
      injectTurnContext(conversation(), { plan: fresh }),
    );
  });

  it('keeps updatedAt out of the model-facing text entirely', () => {
    const out = injectTurnContext(conversation(), { plan: PLAN });
    expect(JSON.stringify(out)).not.toContain('1000');
    expect(JSON.stringify(out)).not.toMatch(/ago|just now/);
  });
});

describe('D - plan changed', () => {
  it('diverges at the latest user message, not the first', () => {
    const before = injectTurnContext(conversation(), { plan: PLAN });
    const after = injectTurnContext(conversation(), {
      plan: { items: [...ITEMS, { text: 'ship it', status: 'pending' }], updatedAt: 2_000 },
    });

    expect(firstDivergence(before, after)).toBe(before.length - 1);
    // The first user message is history. It must not carry the plan any more.
    expect(String(before[1]?.content)).toBe('first request');
  });
});

describe('E/F/G/H - documented invalidation cases', () => {
  it('E: a changed system prompt legitimately changes the prefix', () => {
    const a = injectTurnContext(conversation(), { plan: PLAN });
    const withNewInstructions = conversation();
    withNewInstructions[0] = { role: 'system', content: `${SYSTEM}\nProject: be terse` };
    const b = injectTurnContext(withNewInstructions, { plan: PLAN });
    expect(firstDivergence(a, b)).toBe(0);
  });

  it('H: compaction legitimately rewrites the window', () => {
    const compacted = applyCompactionWindow(conversation(), {
      summary: 'we fixed the pool',
      fromIndex: 4,
    });
    expect(compacted[0]?.role).toBe('user');
    expect(String(compacted[1]?.content)).toContain('we fixed the pool');
  });
});

describe('strict chat-template safety', () => {
  it('never creates two consecutive user turns', () => {
    const out = injectTurnContext(conversation(), { activeFile: '/repo/a.ts', plan: PLAN });
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i]?.role === 'user' && out[i - 1]?.role === 'user').toBe(false);
    }
  });

  it('never lands between an assistant tool_calls turn and its tool result', () => {
    // A user message there is exactly the shape gemma-family templates reject.
    const out = injectTurnContext(conversation(), { plan: PLAN });
    const roles = out.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
  });

  it('folds into a compaction preamble rather than inserting beside it', () => {
    // After a compaction the only user message may be the preamble itself.
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'Compacted replacement context.' },
      { role: 'assistant', content: 'Goal: ship it.' },
    ];
    const out = injectTurnContext(messages, { plan: PLAN });
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(String(out[1]?.content)).toContain('Compacted replacement context.');
  });

  it('stands alone only when there is no user message to fold into', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      { role: 'assistant', content: 'resuming' },
    ];
    const out = injectTurnContext(messages, { plan: PLAN });
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(out[1]?.internal).toBe(true);
  });

  it('preserves multimodal content parts on an attachment-bearing prompt', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this screenshot.' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
    ];
    const out = injectTurnContext(messages, { activeFile: '/repo/a.ts' });
    const content = out[1]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect(Array.isArray(content) && content[0]).toEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('/repo/a.ts') }),
    );
    expect(Array.isArray(content) && content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc' },
    });
  });
});

describe('a turn held across tool rounds', () => {
  // The block folds into the last USER message, which on round N of a tool loop
  // is the request that OPENED the turn -- close to the head. So the state must
  // be snapshotted at turn start; rebuilding it from live state each round
  // rewrites the prompt near the head and invalidates the turn's own rounds.
  // Measured before the fix: reuse 76% -> 39%, 15401 tokens re-evaluated on a
  // round that grew the prompt by 186.
  const round = (n: number): ChatMessage[] => {
    const out = conversation();
    for (let i = 0; i < n; i += 1) {
      out.push({ role: 'assistant', content: null, tool_calls: [] });
      out.push({ role: 'tool', content: `result ${i}`, tool_call_id: `t${i}` });
    }
    return out;
  };

  it('keeps every round byte-identical up to the new tool turns', () => {
    const state = { activeFile: '/repo/a.ts', plan: PLAN };
    const r1 = injectTurnContext(round(1), state);
    const r3 = injectTurnContext(round(3), state);
    // r1 is a strict prefix of r3: the rounds only appended.
    expect(r3.slice(0, r1.length)).toEqual(r1);
  });

  it('diverges near the HEAD when the plan is re-read mid-turn', () => {
    // This is the failure the snapshot prevents, asserted so a regression is
    // visible as a divergence index rather than as a slow agent.
    const before = injectTurnContext(round(3), { plan: PLAN });
    const after = injectTurnContext(round(3), {
      plan: { items: [...ITEMS, { text: 'and this', status: 'pending' }], updatedAt: 2_000 },
    });
    const idx = firstDivergence(before, after);
    // Divergence lands on the turn's opening request -- the last user message,
    // with this turn's tool rounds appended after it.
    expect(idx).toBe(before.map((m) => m.role).lastIndexOf('user'));
    // And everything from there to the tail is this turn's rounds, all of which
    // the server would have to re-evaluate. That is the cost being avoided.
    expect(before.length - idx).toBeGreaterThan(6);
  });
});

describe('the stored transcript', () => {
  it('is never mutated — only the model-facing copy changes', () => {
    const stored = conversation();
    const snapshot = JSON.stringify(stored);
    injectTurnContext(stored, { activeFile: '/repo/a.ts', plan: PLAN });
    expect(JSON.stringify(stored)).toBe(snapshot);
  });

  it('adds nothing at all when there is no volatile state', () => {
    const messages = conversation();
    expect(injectTurnContext(messages, {})).toBe(messages);
    expect(injectTurnContext(messages, { plan: { items: [], updatedAt: 0 } })).toBe(messages);
  });

  it('emits exactly one context block however often it runs', () => {
    const once = injectTurnContext(conversation(), { activeFile: '/a.ts', plan: PLAN });
    const twice = injectTurnContext(conversation(), { activeFile: '/a.ts', plan: PLAN });
    expect(twice).toEqual(once);
    const blocks = JSON.stringify(once).split('[Forge turn context]').length - 1;
    expect(blocks).toBe(1);
  });

  it('carries both the active file and the plan in one block', () => {
    const tail = String(
      injectTurnContext(conversation(), { activeFile: '/repo/a.ts', plan: PLAN }).at(-1)?.content,
    );
    expect(tail).toContain('Active file: /repo/a.ts');
    expect(tail).toContain(renderPlan(ITEMS));
    expect(tail).toContain('second request');
  });

  // The guidance moved out of FORGE.md (and so out of the system prompt) to
  // ride with the plan. Two things must hold: it arrives WITH a plan, and it
  // costs nothing at all when there is none.
  it('delivers the plan guidance with the plan, and not without one', () => {
    const withPlan = String(
      injectTurnContext(conversation(), { activeFile: '/repo/a.ts', plan: PLAN }).at(-1)?.content,
    );
    expect(withPlan).toContain(PLAN_GUIDANCE);

    const noPlan = JSON.stringify(injectTurnContext(conversation(), { activeFile: '/repo/a.ts' }));
    expect(noPlan).not.toContain('authoritative specification');
  });

  // It rides in the tail block, never the system message: content that appears
  // at the head when update_plan first fires invalidates the whole KV cache.
  it('keeps the guidance out of the system prompt', () => {
    const messages = injectTurnContext(conversation(), { plan: PLAN });
    const system = messages.filter((message) => message.role === 'system');
    expect(JSON.stringify(system)).not.toContain('authoritative specification');
  });
});
