/**
 * Regression check driven by REAL persisted data from the session where the
 * Thinking text ("the controls grid in index.html and README") disappeared
 * after the turn finished (2026-08-21, model qwen38-27b, conv 9cac0b12).
 *
 * The fixture is the verbatim `forge.conversations.v1` record extracted from
 * the workspace's state.vscdb. It proves the full display pipeline —
 * slim restore → displayPersistMessages → SESSION_SYNC merge → row folding —
 * keeps every persisted reasoning turn visible as a Thinking row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatMessagesFromSlim, displayPersistMessages } from '../../src/sidebar/sessionTypes';
import type { ConversationPersisted } from '../../src/sidebar/sessionTypes';
import { mergeSyncedMessages, type AppMessage } from '../../webview-ui/src/messageOps';
import { isReasoningOnly } from '../../webview-ui/src/components/ThinkingGroup';

const FIXTURE = join(__dirname, '..', 'fixtures', 'real-conv-9cac0b12.json');
const SENTENCE = 'the controls grid in both the start and pause overlays';

function loadConv(): ConversationPersisted {
  return JSON.parse(readFileSync(FIXTURE, 'utf-8')) as ConversationPersisted;
}

describe('real failing turn: Thinking rows survive session sync', () => {
  it('displayPersistMessages keeps every persisted reasoning turn', () => {
    const conv = loadConv();
    const messages = chatMessagesFromSlim(conv.messages);
    const reasoningTurns = messages.filter(
      (m) => m.role === 'assistant' && typeof m.reasoning === 'string' && m.reasoning.length > 0,
    );
    expect(reasoningTurns.length).toBe(28);

    const rows = displayPersistMessages(messages, []);
    const thinkingRows = rows.filter(
      (r) => r.role === 'assistant' && !r.content && 'reasoning' in r && r.reasoning,
    );
    // Every reasoning-bearing assistant turn must yield a Thinking display row.
    expect(thinkingRows.length).toBe(reasoningTurns.length);
    expect(thinkingRows.some((r) => 'reasoning' in r && r.reasoning!.includes(SENTENCE))).toBe(true);
  });

  it('the sentence is still a Thinking row after a post-turn SESSION_SYNC merge', () => {
    const conv = loadConv();
    const messages = chatMessagesFromSlim(conv.messages);
    const expected = messages.filter(
      (m) => m.role === 'assistant' && (m.reasoning ?? '').includes(SENTENCE),
    ).length;
    expect(expected).toBeGreaterThan(0);
    const rows = displayPersistMessages(messages, []);

    // Worst case: the webview's live state diverged and nothing matches.
    const mergedFresh = mergeSyncedMessages([], rows);
    expect(
      mergedFresh.filter((m) => isReasoningOnly(m) && m.reasoning!.includes(SENTENCE)),
    ).toHaveLength(expected);

    // Typical case: the live streamed Thinking row exists and matches the host.
    const local: AppMessage[] = mergedFresh.map((m) => ({ ...m }));
    const mergedAgain = mergeSyncedMessages(local, rows);
    expect(
      mergedAgain.filter((m) => isReasoningOnly(m) && m.reasoning!.includes(SENTENCE)),
    ).toHaveLength(expected);
  });
});
