import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import {
  collectLastReply,
  LAST_REPLY_MAX_CHARS,
  renderLastReplyBlock,
  toolActivityFollowedLastReply,
} from '../../src/sidebar/compactionLastReply';

describe('compaction last reply', () => {
  it('takes the agent’s closing words, not the tool-call turn that followed them', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: 'Command is pasted — press Enter.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
    ];

    expect(collectLastReply(messages)).toBe('Command is pasted — press Enter.');
  });

  it('skips assistant turns that said nothing', () => {
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'the real answer' },
      { role: 'assistant', content: '   ' },
      { role: 'tool', content: 'ok' },
    ];

    expect(collectLastReply(messages)).toBe('the real answer');
  });

  it('returns nothing when the agent never spoke', () => {
    expect(collectLastReply([{ role: 'user', content: 'hi' }])).toBeUndefined();
    expect(collectLastReply([])).toBeUndefined();
  });

  it('keeps the ending of a long reply, where the next step lives', () => {
    // Keeping only the head threw away the part that matters: a long reply
    // states its next action, open question or handover at the end.
    const long = `START${'x'.repeat(LAST_REPLY_MAX_CHARS + 500)}Next: run npm run ci.`;
    const reply = collectLastReply([{ role: 'assistant', content: long }]) ?? '';

    expect(reply.endsWith('Next: run npm run ci.')).toBe(true);
    expect(reply.startsWith('START')).toBe(true);
    expect(reply).toContain('[middle omitted]');
    expect(reply.length).toBeLessThanOrEqual(LAST_REPLY_MAX_CHARS);
  });

  it('renders nothing at all when there is no reply to carry', () => {
    expect(renderLastReplyBlock(undefined)).toBe('');
  });

  it('says nothing ran after the message only when nothing did', () => {
    const block = renderLastReplyBlock('Command is pasted — press Enter.');

    expect(block).toContain('Command is pasted — press Enter.');
    expect(block).toContain('no tool ran after it');
  });

  it('does not claim nothing happened when tools ran after the message', () => {
    // The flat assertion outranked the recorded tool outcomes, which are the
    // authoritative account of what actually executed.
    const block = renderLastReplyBlock('Starting the build now.', true);

    expect(block).toContain('Tool calls ran after it');
    expect(block).not.toContain('no tool ran after it');
  });

  it('detects whether tool activity followed the last spoken reply', () => {
    expect(
      toolActivityFollowedLastReply([
        { role: 'assistant', content: 'Starting the build now.' },
        { role: 'assistant', content: null, tool_calls: [
          { id: 'a', type: 'function', function: { name: 'run_build', arguments: '{}' } },
        ] },
        { role: 'tool', content: '[exit code: 0]', tool_call_id: 'a' },
      ]),
    ).toBe(true);
    expect(
      toolActivityFollowedLastReply([
        { role: 'assistant', content: null, tool_calls: [
          { id: 'a', type: 'function', function: { name: 'run_build', arguments: '{}' } },
        ] },
        { role: 'tool', content: '[exit code: 0]', tool_call_id: 'a' },
        { role: 'assistant', content: 'Build is green.' },
      ]),
    ).toBe(false);
  });
});
