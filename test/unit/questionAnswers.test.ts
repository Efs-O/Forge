import { describe, expect, it } from 'vitest';
import {
  formatGroupAnswer,
  formatStructuredAnswer,
  normalizeQuestions,
  parseQuestionGroups,
  QUESTION_SKIP_TEXT,
  renderQuestionAsText,
  resolveAnswerText,
  type QuestionGroup,
  type QuestionSpec,
} from '../../src/util/questionAnswers';

const groups: QuestionGroup[] = [
  { prompt: 'Version', options: ['bump', 'keep'] },
  { prompt: 'Install', options: ['open', 'skip'] },
];

describe('normalizeQuestions', () => {
  it('normalizes flat string options into one single-select spec', () => {
    expect(normalizeQuestions({ prompt: 'Backend?', options: ['llama.cpp', 'ollama'] })).toEqual([
      {
        prompt: 'Backend?',
        multiSelect: false,
        options: [{ label: 'llama.cpp' }, { label: 'ollama' }],
      },
    ]);
  });

  it('normalizes object and mixed options without dropping their metadata', () => {
    expect(
      normalizeQuestions({
        prompt: 'Stores?',
        questions: [
          {
            prompt: 'Which stores?',
            header: 'Database',
            multiSelect: true,
            options: [
              'Postgres',
              { label: 'Redis', description: 'cache only' },
              { label: 'None', exclusive: true },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        prompt: 'Which stores?',
        header: 'Database',
        multiSelect: true,
        options: [
          { label: 'Postgres' },
          { label: 'Redis', description: 'cache only' },
          { label: 'None', exclusive: true },
        ],
      },
    ]);
  });

  it('uses one spec per question and supports an empty question', () => {
    expect(
      normalizeQuestions({
        questions: [
          { prompt: 'Version?', options: ['bump', 'keep'] },
          { prompt: 'Install?', options: ['open', 'skip'], multiSelect: true },
        ],
      }),
    ).toHaveLength(2);
    expect(normalizeQuestions({ prompt: 'Write freely' })).toEqual([
      { prompt: 'Write freely', multiSelect: false, options: [] },
    ]);
  });
});

describe('formatStructuredAnswer', () => {
  const one: QuestionSpec[] = [
    {
      prompt: 'Which stores?',
      multiSelect: true,
      options: [{ label: 'Postgres' }, { label: 'Redis' }, { label: 'SQLite' }],
    },
  ];

  it.each([
    { answer: { answers: [{ picks: [0] }] }, expected: 'Postgres' },
    { answer: { answers: [{ picks: [2, 0] }] }, expected: 'Postgres, SQLite' },
    {
      answer: { answers: [{ picks: [0], note: 'keep the old schema' }] },
      expected: 'Postgres\nNote: keep the old schema',
    },
    {
      answer: { answers: [{ picks: [], note: 'keep the old schema' }] },
      expected: 'keep the old schema',
    },
  ])('formats one question as $expected', ({ answer, expected }) => {
    expect(formatStructuredAnswer(one, answer)).toBe(expected);
  });

  it('formats several questions with prompt labels and an indented note', () => {
    const specs = normalizeQuestions({
      questions: [
        { prompt: 'Which stores?', options: ['Postgres', 'Redis'] },
        { prompt: 'Migration?', options: ['now', 'later'] },
      ],
    });
    expect(
      formatStructuredAnswer(specs, {
        answers: [{ picks: [0, 1] }, { picks: [1], note: 'after the release' }],
      }),
    ).toBe('Which stores?: Postgres, Redis\nMigration?: later\n  Note: after the release');
  });

  it('uses the documented skip response and rejects invalid indexes', () => {
    expect(formatStructuredAnswer(one, { skipped: true, answers: [] })).toBe(QUESTION_SKIP_TEXT);
    expect(() => formatStructuredAnswer(one, { answers: [{ picks: [3] }] })).toThrow(
      'invalid option index',
    );
    expect(() => formatStructuredAnswer(one, { answers: [] })).toThrow('count must match');
  });

  it('keeps the grouped compatibility formatter on the shared formatter', () => {
    expect(formatGroupAnswer(groups, ['keep', 'open'])).toBe('Version: keep\nInstall: open');
  });
});

describe('resolveAnswerText', () => {
  it('prefers an exact numeric label over treating it as an index', () => {
    const spec = normalizeQuestions({
      prompt: 'Value?',
      options: ['10', '5', '3'],
    })[0]!;
    expect(resolveAnswerText('5', spec)).toBe('5');
    expect(resolveAnswerText('2', spec)).toBe('5');
  });

  it('resolves the multi-select numeric forms and leaves out-of-range text alone', () => {
    const spec = normalizeQuestions({
      prompt: 'Stores?',
      questions: [{ prompt: 'Stores?', multiSelect: true, options: ['A', 'B', 'C'] }],
    })[0]!;
    expect(resolveAnswerText('1,3', spec)).toBe('A, C');
    expect(resolveAnswerText('1+3', spec)).toBe('A, C');
    expect(resolveAnswerText('1 3', spec)).toBe('A, C');
    expect(resolveAnswerText('4', spec)).toBe('4');
  });

  it('resolves grouped numeric replies and preserves prose', () => {
    expect(resolveAnswerText('2 1', undefined, groups)).toBe('Version: keep\nInstall: open');
    expect(resolveAnswerText('bump it but do not install', undefined, groups)).toBe(
      'bump it but do not install',
    );
  });
});

describe('renderQuestionAsText', () => {
  it('shows numbered questions, descriptions and the free-text route', () => {
    const specs = normalizeQuestions({
      questions: [
        {
          prompt: 'Stores?',
          multiSelect: true,
          options: [{ label: 'Postgres', description: 'relational' }, 'Redis'],
        },
      ],
    });
    const text = renderQuestionAsText('Stores?', undefined, specs);
    expect(text).toContain('1) Stores?');
    expect(text).toContain('1. Postgres — relational');
    expect(text).toContain('or send free text instead');
  });

  it('tags the recommended option on every text path, but answers with the bare label', () => {
    const [spec] = normalizeQuestions({
      prompt: 'Which backend?',
      options: ['ollama', { label: 'llama.cpp', recommended: true, description: 'fastest here' }],
    });
    expect(renderQuestionAsText('Which backend?', spec!)).toContain(
      '2. llama.cpp (Recommended) — fastest here',
    );
    expect(
      renderQuestionAsText('Which backend?', [{ label: 'llama.cpp', recommended: true }, 'x']),
    ).toContain('1. llama.cpp (Recommended)');
    expect(renderQuestionAsText('Which backend?', undefined, [spec!])).toContain(
      '   2. llama.cpp (Recommended) — fastest here',
    );
    expect(formatStructuredAnswer([spec!], { answers: [{ picks: [1] }] })).toBe('llama.cpp');
    expect(resolveAnswerText('llama.cpp', spec!)).toBe('llama.cpp');
  });

  it('keeps flat string and legacy grouped renderings', () => {
    expect(renderQuestionAsText('Which backend?', ['llama.cpp', 'ollama'])).toBe(
      'Which backend?\n1. llama.cpp\n2. ollama\n\nReply with the number or the text.',
    );
    expect(renderQuestionAsText('Which file?')).toBe('Which file?\n\nReply with your answer.');
    const text = renderQuestionAsText('Version', undefined, groups);
    expect(text.match(/Version/g)).toHaveLength(1);
    expect(text).toContain('1) Version');
    expect(text).toContain('2) Install');
  });
});

describe('parseQuestionGroups compatibility', () => {
  it('rejects a group without nonempty string options', () => {
    expect(parseQuestionGroups([{ prompt: 'Version' }])).toBeUndefined();
    expect(parseQuestionGroups([{ prompt: 'Version', options: [] }])).toBeUndefined();
  });
});
