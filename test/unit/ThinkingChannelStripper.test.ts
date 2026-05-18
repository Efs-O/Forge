import { describe, expect, it } from 'vitest';
import { ThinkingChannelStripper, stripThinkingFromFullText } from '../../src/llm/ThinkingChannelStripper';

describe('ThinkingChannelStripper', () => {
  it('strips inline thinking segments from a full response', () => {
    const text = 'Visible<think>hidden</think> tail';
    expect(stripThinkingFromFullText(text)).toBe('Visible tail');
  });

  it('handles channel markers split across streamed chunks', () => {
    const stripper = new ThinkingChannelStripper();
    const chunks = ['Hello<thi', 'nk>secret</t', 'hink> world'];
    const visible = chunks.map((chunk) => stripper.push(chunk)).join('');
    expect(visible).toBe('Hello world');
  });

  it('drops thought channel markers without removing visible text after them', () => {
    const stripper = new ThinkingChannelStripper();
    const chunks = ['A thought<|cha', 'nnel>hidden<channel|>B'];
    const visible = chunks.map((chunk) => stripper.push(chunk)).join('');
    expect(visible).toBe('A B');
  });
});
