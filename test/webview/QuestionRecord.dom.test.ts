// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAskUserTool } from '../../src/tools/askUserTool';
import { persistedToRuntime, runtimeToPersisted } from '../../src/sidebar/sessionPersistence';
import { createDefaultSession, sidebarSessionPersistedSchema } from '../../src/sidebar/sessionTypes';
import { displayTranscriptRows } from '../../src/sidebar/sessionProjections';
import { UserQuestionService } from '../../src/sidebar/UserQuestionService';
import { mergeSyncedMessages } from '../../webview-ui/src/messageOps';
import { resetDisclosures } from '../../webview-ui/src/disclosureState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const posted: unknown[] = [];
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } })
  .acquireVsCodeApi = () => ({ postMessage: (msg: unknown) => posted.push(msg) });

const React = await import('react');
const { ToolRow } = await import('../../webview-ui/src/components/ToolRow');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  posted.length = 0;
  resetDisclosures();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetDisclosures();
});

describe('answered question transcript record', () => {
  it('persists a card answer and skip, then renders the read-only summaries collapsed by default', async () => {
    const service = new UserQuestionService();
    const asked = vi.fn();
    service.addSink({ asked, answered: () => undefined, presentsLocally: () => true });
    const tool = makeAskUserTool(service);

    const answerPending = tool.handler(
      {
        questions: [
          { prompt: 'Which database?', options: ['SQLite', 'Postgres'] },
          { prompt: 'Which cache?', options: ['None', 'Redis'] },
        ],
      },
      { beforeMutate: () => undefined, conversationId: 'chat-1' },
    );
    const answerId = asked.mock.calls[0]![0].id as string;
    expect(
      service.answerStructured(answerId, {
        answers: [
          { picks: [1], note: 'Use the managed instance.' },
          { picks: [1] },
        ],
      }),
    ).toBe(true);
    const answerResult = await answerPending;
    if (typeof answerResult === 'string' || !('questionRecord' in answerResult)) {
      throw new Error('ask_user did not return its structured answer record');
    }

    const skipPending = tool.handler(
      { prompt: 'Choose a deployment window', options: ['Morning', 'Evening'] },
      { beforeMutate: () => undefined, conversationId: 'chat-1' },
    );
    const skipId = asked.mock.calls[1]![0].id as string;
    expect(service.skip(skipId)).toBe(true);
    const skipResult = await skipPending;
    if (typeof skipResult === 'string' || !('questionRecord' in skipResult)) {
      throw new Error('ask_user did not return its skipped record');
    }

    const session = createDefaultSession();
    const conversation = session.conversations[0]!;
    conversation.messages = [
      { role: 'tool', name: 'ask_user', tool_call_id: 'call-answer', content: answerResult.text },
      { role: 'tool', name: 'ask_user', tool_call_id: 'call-skip', content: skipResult.text },
    ];
    conversation.displayQuestionRecords = [
      { toolCallId: 'call-answer', record: answerResult.questionRecord },
      { toolCallId: 'call-skip', record: skipResult.questionRecord },
    ];

    const saved = sidebarSessionPersistedSchema.parse(runtimeToPersisted(session));
    expect(saved.conversations[0]?.display_question_records).toHaveLength(2);
    expect(saved.conversations[0]?.messages.every((message) => !('questionRecord' in message))).toBe(
      true,
    );
    const restored = persistedToRuntime(saved.conversations[0]!);
    expect(restored.messages[0]?.content).toBe(answerResult.text);
    const displayRows = displayTranscriptRows(
      restored.messages,
      restored.displayDiffs,
      undefined,
      restored.displayQuestionRecords,
    );
    expect(displayRows.filter((row) => row.role === 'tool')).toMatchObject([
      { toolCallId: 'call-answer', questionRecord: answerResult.questionRecord },
      { toolCallId: 'call-skip', questionRecord: skipResult.questionRecord },
    ]);

    const messages = mergeSyncedMessages([], displayRows);
    const tools = messages.filter((message) => message.role === 'tool');
    act(() => root.render(React.createElement('div', null, ...tools.map((message) =>
      React.createElement(ToolRow, { key: message.id, message }),
    ))));

    const toggles = Array.from(container.querySelectorAll<HTMLButtonElement>('.tool-row-toggle'));
    expect(toggles).toHaveLength(2);
    expect(toggles.every((toggle) => toggle.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(container.querySelector('.question-review')).toBeNull();

    act(() => toggles[0]!.click());
    expect(container.textContent).toContain('Which database?');
    expect(container.textContent).toContain('Postgres');
    expect(container.textContent).toContain('Use the managed instance.');
    expect(container.textContent).toContain('Which cache?');
    expect(container.textContent).toContain('Redis');
    expect(container.querySelector('.question-review-row')?.tagName).toBe('DIV');

    act(() => toggles[1]!.click());
    expect(container.textContent).toContain('Choose a deployment window');
    expect(container.textContent).toContain('Skipped');
  });
});
