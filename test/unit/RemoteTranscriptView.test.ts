import { describe, expect, it } from 'vitest';
import { FakeRemoteChannel } from '../../src/remote/FakeRemoteChannel';
import {
  MAX_VIEW_COUNT,
  parseViewCount,
  renderExchange,
  sendTranscriptView,
} from '../../src/remote/RemoteTranscriptView';
import { forgeInboundPrompt, parseForgeInboundPrompt } from '../../src/agentBus/busContent';
import { recentExchanges } from '../../src/sidebar/sessionProjections';
import type { ChatMessage } from '../../src/llm/types';

const signal = new AbortController().signal;

describe('parseViewCount', () => {
  it('defaults to three', () => {
    expect(parseViewCount(undefined)).toEqual({ kind: 'ok', count: 3, clamped: false });
  });

  it('clamps rather than refusing a number over the maximum', () => {
    expect(parseViewCount('50')).toEqual({ kind: 'ok', count: MAX_VIEW_COUNT, clamped: true });
  });

  it('rejects what has no honest reading', () => {
    expect(parseViewCount('abc').kind).toBe('invalid');
    expect(parseViewCount('0').kind).toBe('invalid');
    expect(parseViewCount('-2').kind).toBe('invalid');
    expect(parseViewCount('2.5').kind).toBe('invalid');
  });
});

describe('renderExchange', () => {
  it('heads each answer with its position and the prompt that asked for it', () => {
    const text = renderExchange({ prompt: 'resume', answer: 'Done.' }, 2, 3);
    expect(text).toBe('[2/3] You: resume\n\nDone.');
  });

  it('labels an agent-bus prompt by its sender, without the reply hint', () => {
    const prompt = forgeInboundPrompt('claude', 'New three-way task');
    const text = renderExchange({ prompt, answer: 'On it.' }, 1, 1);
    expect(text).toBe('[1/1] claude: New three-way task\n\nOn it.');
    expect(parseForgeInboundPrompt('plain prompt')).toBeUndefined();
  });

  it('keeps the header on one line however long the prompt was', () => {
    const text = renderExchange(
      { prompt: `first line\nsecond line ${'x'.repeat(300)}`, answer: 'ok' },
      1,
      1,
    );
    const header = text.split('\n')[0] ?? '';
    expect(header.startsWith('[1/1] You: first line second line')).toBe(true);
    expect(header.endsWith('…')).toBe(true);
    expect(header.length).toBeLessThanOrEqual(140);
  });

  it('collapses the blank-line pile-up that makes a phone scroll', () => {
    const text = renderExchange({ prompt: 'p', answer: 'one\n\n\n\n\ntwo   \n\n\n' }, 1, 1);
    expect(text).toBe('[1/1] You: p\n\none\n\ntwo');
  });

  it('cuts a long answer with a marker rather than splitting it', () => {
    const text = renderExchange({ prompt: 'p', answer: 'y'.repeat(9_000) }, 1, 1);
    expect(text).toContain('… (cut; see the Forge window)');
    expect(text.length).toBeLessThan(4_096);
  });
});

describe('sendTranscriptView', () => {
  it('sends one message per exchange, oldest first', async () => {
    const channel = new FakeRemoteChannel();
    channel.declareHtmlSupport();
    await sendTranscriptView(
      channel,
      'chat-1',
      [
        { prompt: 'one', answer: 'first' },
        { prompt: 'two', answer: 'second' },
      ],
      { clamped: false, signal },
    );
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[0]?.text).toContain('[1/2]');
    expect(channel.sent[0]?.text).toContain('first');
    expect(channel.sent[1]?.text).toContain('[2/2]');
  });

  it('bolds the header on a transport that parses HTML, and nowhere else', async () => {
    const rich = new FakeRemoteChannel();
    rich.declareHtmlSupport();
    await sendTranscriptView(rich, 'chat-1', [{ prompt: 'p', answer: 'a' }], {
      clamped: false,
      signal,
    });
    expect(rich.sent[0]?.text).toContain('<b>[1/1] You: p</b>');

    const plain = new FakeRemoteChannel();
    await sendTranscriptView(plain, 'chat-1', [{ prompt: 'p', answer: 'a' }], {
      clamped: false,
      signal,
    });
    expect(plain.sent[0]?.text).toBe('[1/1] You: p\n\na');
  });

  it('says once when it clamped, on the first message only', async () => {
    const channel = new FakeRemoteChannel();
    await sendTranscriptView(
      channel,
      'chat-1',
      [
        { prompt: 'one', answer: 'first' },
        { prompt: 'two', answer: 'second' },
      ],
      { clamped: true, signal },
    );
    expect(channel.sent[0]?.text).toContain('showing the last 10');
    expect(channel.sent[1]?.text).not.toContain('showing the last 10');
  });

  it('answers once when there is nothing to replay', async () => {
    const channel = new FakeRemoteChannel();
    await sendTranscriptView(channel, 'chat-1', [], { clamped: false, signal });
    expect(channel.sent).toEqual([
      { chatId: 'chat-1', text: 'Forge: this conversation has no answers yet.' },
    ]);
  });
});

describe('recentExchanges', () => {
  const user = (content: string): ChatMessage => ({ role: 'user', content });
  const assistant = (content: string): ChatMessage => ({ role: 'assistant', content });

  it('pairs each answer with the prompt that asked for it, oldest first', () => {
    expect(
      recentExchanges([user('one'), assistant('first'), user('two'), assistant('second')], 5),
    ).toEqual([
      { prompt: 'one', answer: 'first' },
      { prompt: 'two', answer: 'second' },
    ]);
  });

  it('keeps only the last answer of an agentic turn, not every fragment', () => {
    // The shape that prompted the command: narration, tool rounds, then the
    // outcome. Three messages, one turn, one exchange.
    const turn: ChatMessage[] = [
      user('inspect the repo'),
      assistant('I have strong evidence on several issues.'),
      assistant('Let me firm up the remaining candidates.'),
      assistant('Ten issues, ranked.'),
    ];
    expect(recentExchanges(turn, 5)).toEqual([
      { prompt: 'inspect the repo', answer: 'Ten issues, ranked.' },
    ]);
  });

  it('returns the newest when there are more than asked for', () => {
    const messages = [1, 2, 3, 4].flatMap((n) => [
      user(`p${String(n)}`),
      assistant(`a${String(n)}`),
    ]);
    expect(recentExchanges(messages, 2)).toEqual([
      { prompt: 'p3', answer: 'a3' },
      { prompt: 'p4', answer: 'a4' },
    ]);
  });

  it('skips a turn that only called tools', () => {
    const messages: ChatMessage[] = [
      user('build it'),
      { role: 'assistant', content: '', tool_calls: [] },
      { role: 'tool', content: 'ok', tool_call_id: 't1', name: 'run_build' },
    ];
    expect(recentExchanges(messages, 5)).toEqual([]);
  });
});
