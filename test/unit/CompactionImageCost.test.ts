/**
 * Image cost in compaction, and image-bearing messages reaching the summarizer.
 *
 * Every image here is synthetic: a fixed-length fake base64 payload. The shape
 * reproduces the refusals seen in a photo-heavy conversation, where base64 was
 * measured as text and the floor check refused with no model call. See
 * docs/plans/IMAGE_COMPACTION_AND_THINKING_FOLD_PLAN.md.
 */

import { describe, expect, it } from 'vitest';
import { runCompaction, type CompactionDeps } from '../../src/sidebar/CompactionService';
import {
  applyCompactionWindow,
  compactionWindowChars,
  messageCostChars,
} from '../../src/sidebar/compactionWindow';
import { retainedTailCost, selectCompactionSplit } from '../../src/sidebar/compactionSplit';
import { COMPACTION_CHARS_PER_TOKEN } from '../../src/sidebar/compactionBudget';
import { contentPartCostChars, IMAGE_PART_TOKENS } from '../../src/util/contextBudget';
import type { ChatMessage, ContentPart } from '../../src/llm/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { HostToWebview } from '../../src/sidebar/messageBridge';

const PAYLOAD_CHARS = 400_000;

function fakeImage(seed: number): ContentPart {
  const payload = String.fromCharCode(65 + (seed % 26)).repeat(PAYLOAD_CHARS);
  return { type: 'image_url', image_url: { url: `data:image/png;base64,${payload}` } };
}

const SUMMARY = `Goal: sort the photos.
State: recorded. ${'detail. '.repeat(30)}
Next: continue.
Files: none.
Constraints: none recorded.
Errors: none recorded.
Reference: none recorded.`;

/** Earlier text history, then a last exchange carrying 20 images. */
function photoConversation(): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: 'user', content: `step ${i} ` + 'a'.repeat(1500) });
    messages.push({ role: 'assistant', content: `done ${i} ` + 'b'.repeat(1500) });
  }
  const attached: ContentPart[] = [{ type: 'text', text: 'compare these ten photos' }];
  for (let i = 0; i < 10; i++) attached.push(fakeImage(i));
  messages.push({ role: 'user', content: attached });
  messages.push({
    role: 'assistant',
    content: null,
    tool_calls: Array.from({ length: 10 }, (_, i) => ({
      id: `v${i}`,
      type: 'function' as const,
      function: { name: 'view_image', arguments: JSON.stringify({ path: `out/${i}.png` }) },
    })),
  });
  for (let i = 0; i < 10; i++) {
    messages.push({
      role: 'tool',
      tool_call_id: `v${i}`,
      content: [{ type: 'text', text: `out/${i}.png` }, fakeImage(10 + i)],
    });
  }
  messages.push({ role: 'assistant', content: 'The third photo is the sharpest.' });
  return messages;
}

function deps(conv: ConversationRuntime, prompts: string[], posted: HostToWebview[]): CompactionDeps {
  return {
    post: (msg) => posted.push(msg),
    getConversation: (id) => (id === conv.id ? conv : undefined),
    persistSession: () => undefined,
    postSessionSync: () => undefined,
    invalidateExactTokenBudget: () => undefined,
    postTokenBudget: () => undefined,
    isStreaming: () => false,
    beginCompaction: () => () => undefined,
    runPromptToMarkdown: async (text) => {
      prompts.push(text);
      return SUMMARY;
    },
    currentLocalTime: () => 'test local time',
    compactionMetrics: () => ({ max: 200_000 }),
  };
}

function conversation(messages: ChatMessage[]): ConversationRuntime {
  const conv = { id: 'c1', title: 't', messages, createdAt: 0, updatedAt: 0 } as ConversationRuntime;
  conv.last_input_tokens = 144_000;
  return conv;
}

describe('image cost single owner', () => {
  const image = fakeImage(0);
  const expected = Math.ceil(IMAGE_PART_TOKENS * COMPACTION_CHARS_PER_TOKEN);

  it('costs an image at its token ceiling, not its payload', () => {
    expect(contentPartCostChars(image, COMPACTION_CHARS_PER_TOKEN)).toBe(expected);
    expect(contentPartCostChars({ type: 'text', text: 'abc' }, COMPACTION_CHARS_PER_TOKEN)).toBe(3);
  });

  it('prices an image identically in the window measurement and the tail cost', () => {
    // Pins both sites to the one function: reverting either to 0 (the old tail
    // cost) or to the base64 length (the old window cost) fails here.
    const message: ChatMessage = { role: 'user', content: [image] };
    expect(retainedTailCost(message)).toBe(expected);
    expect(messageCostChars(message) - message.role.length).toBe(expected);
    expect(retainedTailCost(message)).not.toBe(0);
    expect(messageCostChars(message)).toBeLessThan(PAYLOAD_CHARS);
  });
});

describe('photo-heavy compaction', () => {
  it('measures 20 photos far below their base64 size', () => {
    const messages = photoConversation();
    // Before the fix this exceeded 8M characters (20 × 400K of base64).
    expect(compactionWindowChars(messages, undefined)).toBeLessThan(200_000);
  });

  it('no longer refuses at the floor check, and summarizes the photo exchange', async () => {
    const conv = conversation(photoConversation());
    const prompts: string[] = [];
    const posted: HostToWebview[] = [];

    await expect(runCompaction(deps(conv, prompts, posted), conv.id, { auto: true })).resolves.toBe(
      'compacted',
    );
    expect(
      posted.some((msg) => msg.type === 'notice' && msg.message.includes('no summary could shrink')),
    ).toBe(false);
    // The photos cost more than the tail cap, so the whole exchange is summarized.
    expect(conv.compaction?.fromIndex).toBe(conv.messages.length);
  });

  it('hands the summarizer the text around each image, with a note per image and no payload', async () => {
    const conv = conversation(photoConversation());
    const prompts: string[] = [];
    await runCompaction(deps(conv, prompts, []), conv.id, { auto: true });

    const prompt = prompts[0] ?? '';
    expect(prompt).toContain('compare these ten photos');
    expect(prompt).toContain('[image attached by the user; not shown to the summarizer');
    expect(prompt).toContain('[image returned by this tool call; not shown to the summarizer');
    expect(prompt).not.toContain('A'.repeat(1000));
    // The stored transcript keeps its real images for the sidebar.
    expect(conv.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))).toBe(true);
  });

  it('keeps a mid-turn window valid when the photos leave no tail', async () => {
    // Mid-turn, the in-flight exchange is the one carrying the photos. With an
    // empty tail the window must still open on the summary, never on a tool row
    // whose call was summarized away.
    const messages = photoConversation();
    messages.pop(); // the turn is still running: it ends on tool results
    const conv = conversation(messages);
    expect(selectCompactionSplit(messages, 5_400)?.tailStart).toBe(messages.length);

    await expect(
      runCompaction(deps(conv, [], []), conv.id, { auto: true, midTurn: true }),
    ).resolves.toBe('compacted');
    const window = applyCompactionWindow(conv.messages, conv.compaction);
    expect(window.some((m) => m.role === 'tool')).toBe(false);
    expect(window.at(-1)?.role).not.toBe('tool');
  });
});
