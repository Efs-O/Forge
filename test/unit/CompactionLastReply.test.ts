import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';
import {
  collectLastReply,
  LAST_REPLY_MAX_CHARS,
  renderLastReplyBlock,
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

  it('truncates a long reply rather than dropping it', () => {
    const long = 'x'.repeat(LAST_REPLY_MAX_CHARS + 500);
    const reply = collectLastReply([{ role: 'assistant', content: long }]);

    expect(reply).toMatch(/…\[truncated\]$/);
    expect(reply!.length).toBeLessThan(LAST_REPLY_MAX_CHARS + 20);
  });

  it('renders nothing at all when there is no reply to carry', () => {
    expect(renderLastReplyBlock(undefined)).toBe('');
  });

  it('states that nothing has happened since the message was sent', () => {
    const block = renderLastReplyBlock('Command is pasted — press Enter.');

    expect(block).toContain('Command is pasted — press Enter.');
    expect(block).toContain('Nothing has happened since it was sent');
  });
});
