import { describe, expect, it } from 'vitest';
import {
  parseQuestionGroups,
  renderQuestionAsText,
  resolveAnswerText,
  type QuestionGroup,
} from '../../src/util/questionAnswers';

const groups: QuestionGroup[] = [
  { prompt: 'Version', options: ['bump', 'keep'] },
  { prompt: 'Install', options: ['open', 'skip'] },
];

describe('renderQuestionAsText', () => {
  it('tells a sub-question asker they may also reply in free text', () => {
    const text = renderQuestionAsText('Two decisions:', undefined, groups);
    // The number contract and its example are still there...
    expect(text).toContain('Reply with one number per question, in order');
    expect(text).toContain('e.g. "1 1"');
    // ...and so is the free-text route the sidebar exposes as Other…
    expect(text).toContain('or send free text instead');
  });

  it('keeps the flat-options and no-options footers unchanged', () => {
    expect(renderQuestionAsText('Which backend?', ['llama.cpp', 'ollama'], undefined)).toBe(
      'Which backend?\n1. llama.cpp\n2. ollama\n\nReply with the number or the text.',
    );
    expect(renderQuestionAsText('Which file?')).toBe('Which file?\n\nReply with your answer.');
  });

  it('does not repeat a preamble that is one of the sub-questions', () => {
    // A call with no shared preamble is headed by the first sub-question, so
    // printing the header again above "1) Version" reads as two questions.
    const text = renderQuestionAsText('Version', undefined, groups);
    expect(text.match(/Version/g)).toHaveLength(1);
    expect(text).toContain('1) Version');
    expect(text).toContain('2) Install');
    // ...but a preamble that is NOT one of the questions still heads the list:
    // dropping the header always would also satisfy the assertions above.
    const headed = renderQuestionAsText('Two decisions:', undefined, groups);
    expect(headed.startsWith('Two decisions:\n\n1) Version')).toBe(true);
  });
});

describe('resolveAnswerText (sub-questions)', () => {
  it('resolves an exact per-question index reply to the labelled group answer', () => {
    expect(resolveAnswerText('2 1', undefined, groups)).toBe('Version: keep\nInstall: open');
  });

  it('passes a prose reply through verbatim rather than coercing it', () => {
    expect(resolveAnswerText('bump it but do not install', undefined, groups)).toBe(
      'bump it but do not install',
    );
  });
});

describe('parseQuestionGroups', () => {
  it('rejects a group without options', () => {
    expect(parseQuestionGroups([{ prompt: 'Version' }])).toBeUndefined();
    expect(parseQuestionGroups([{ prompt: 'Version', options: [] }])).toBeUndefined();
  });
});
