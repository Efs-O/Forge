import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openQuickInputs, type FakeQuickItem } from '../support/vscode';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { normalizeQuestions, QUESTION_SKIP_TEXT } from '../../src/util/questionAnswers';

beforeEach(() => {
  openQuickInputs.length = 0;
});

describe('structured user questions', () => {
  it('rejects invalid indexes without settling and accepts a valid structured answer', async () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined, presentsLocally: () => true });
    const specs = normalizeQuestions({ prompt: 'Value?', options: ['10', '5', '3'] });
    const pending = service.ask({ prompt: 'Value?', specs, conversationId: 'chat-a' });
    const id = asked.mock.calls[0]![0].id as string;

    expect(service.pendingQuestions()).toMatchObject([{ id, conversationId: 'chat-a', specs }]);
    expect(service.answerStructured(id, { answers: [{ picks: [3] }] })).toBe(false);
    expect(service.hasPending('chat-a')).toBe(true);
    expect(
      service.answerStructured(id, { answers: [{ picks: [1], note: 'keep the old schema' }] }),
    ).toBe(true);
    expect(service.answer(id, '10')).toBe(false);
    await expect(pending).resolves.toBe('5\nNote: keep the old schema');
  });

  it('settles skip with the skip instruction and keeps dismiss as cancellation', async () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    const answered = vi.fn();
    service.addSink({ asked, answered, presentsLocally: () => true });
    const specs = normalizeQuestions({ prompt: 'Choose' });

    const skipped = service.ask({ prompt: 'Choose', specs });
    expect(service.skip(asked.mock.calls[0]![0].id as string)).toBe(true);
    await expect(skipped).resolves.toBe(QUESTION_SKIP_TEXT);
    expect(answered.mock.calls[0]![0].reason).toBe('answered');

    const dismissed = service.ask({ prompt: 'Choose', specs });
    expect(service.dismiss(asked.mock.calls[1]![0].id as string)).toBe(true);
    await expect(dismissed).resolves.toBeUndefined();
    expect(answered.mock.calls[1]![0].reason).toBe('cancelled');
  });

  it('uses a multi-pick quick pick and keeps the picks with a written note', async () => {
    const service = new UserQuestionService();
    const specs = normalizeQuestions({
      questions: [
        {
          prompt: 'Which stores?',
          multiSelect: true,
          options: ['Postgres', 'Redis'],
        },
      ],
    });
    const pending = service.ask({ prompt: 'Which stores?', specs });
    const picker = openQuickInputs[0]!;
    expect(picker.canSelectMany).toBe(true);
    expect(picker.items.map((item) => item.label)).toEqual([
      'Postgres',
      'Redis',
      'Write my own answer…',
    ]);
    picker.selectedItems = [
      { label: 'Postgres', questionKind: 'option', optionIndex: 0 },
      { label: 'Write my own answer…', questionKind: 'write' },
    ] satisfies FakeQuickItem[];
    picker.accept();

    const noteBox = openQuickInputs[1]!;
    noteBox.accept('keep the old schema');
    await expect(pending).resolves.toBe('Postgres\nNote: keep the old schema');
  });

  it('marks the recommended item in the quick pick and answers with the bare label', async () => {
    const service = new UserQuestionService();
    const specs = normalizeQuestions({
      prompt: 'Bump?',
      options: [{ label: 'Bump', recommended: true, description: 'new VSIX name' }, 'Keep'],
    });
    const pending = service.ask({ prompt: 'Bump?', specs });
    const picker = openQuickInputs[0]!;
    expect(picker.items.slice(0, 2)).toMatchObject([
      { label: 'Bump', description: 'Recommended · new VSIX name' },
      { label: 'Keep' },
    ]);
    expect(picker.items[1]!.description).toBeUndefined();
    picker.selectedItems = [{ label: 'Bump', questionKind: 'option', optionIndex: 0 }];
    picker.accept();
    await expect(pending).resolves.toBe('Bump');
  });

  it('lists every pending question with its conversation id', () => {
    const service = new UserQuestionService();
    service.addSink({
      asked: () => undefined,
      answered: () => undefined,
      presentsLocally: () => true,
    });
    const specs = normalizeQuestions({ prompt: 'Question?' });
    void service.ask({ prompt: 'First?', specs, conversationId: 'chat-a' });
    void service.ask({ prompt: 'Second?', specs, conversationId: 'chat-b' });
    expect(service.pendingQuestions().map((question) => question.conversationId)).toEqual([
      'chat-a',
      'chat-b',
    ]);
  });
});
