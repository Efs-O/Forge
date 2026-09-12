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
