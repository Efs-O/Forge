// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityStep } from '../../webview-ui/src/activityRows';
import type { AppMessage } from '../../webview-ui/src/messageOps';
import type { DiffHunk } from '../../src/sidebar/messageBridge';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } })
  .acquireVsCodeApi = () => ({ postMessage: () => {} });

const { ActivityRow } = await import('../../webview-ui/src/components/ActivityRow');
const React = await import('react');
const { resetDisclosures } = await import('../../webview-ui/src/disclosureState');

function tool(id: string, fields: Partial<AppMessage> = {}): AppMessage {
  return {
    id, role: 'tool', content: 'run_terminal → cd /workspace && npm test',
    toolName: 'run_terminal', toolTarget: 'cd /workspace && npm test',
    toolDetail: 'cd /workspace && npm test', ...fields,
  };
}

/** Tool rounds as attempts with no reasoning before them. */
function rounds(...tools: AppMessage[][]): ActivityStep['attempts'] {
  return tools.map((round) => ({ thoughts: [], tools: round }));
}

function step(overrides: Partial<ActivityStep> = {}): ActivityStep {
  return {
    attempts: rounds([tool('call', { toolResult: 'ok', toolResultTotal: 2 })]),
    diffs: [],
    ...overrides,
  };
}

function diff(id: string, hunks: DiffHunk[] | null): AppMessage {
  return {
    id, role: 'diff', content: 'src/a.ts', diffHunks: hunks,
    diffIsNew: false, diffIsDeleted: false,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  resetDisclosures();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(activity: ActivityStep, streaming = false): void {
  act(() => root.render(React.createElement(ActivityRow, { step: activity, streaming })));
}

function toggle(): void {
  act(() => container.querySelector<HTMLButtonElement>('.activity-row-header')!.click());
}

describe('ActivityRow', () => {
  it('names the tool once when a single-call step is opened', () => {
    render(step());
    toggle();
    expect(container.querySelectorAll('.activity-row-body .tool-row-name')[0]?.textContent).toBe('result');
    expect(container.querySelector('.activity-row-body .tool-row-detail')).toBeNull();
    expect(container.textContent?.match(/run_terminal/gu)).toHaveLength(1);
  });

  it('keeps a running step closed after it completes unless the reader opens it', () => {
    const pending = step({ attempts: rounds([tool('pending', { toolResult: undefined, toolResultTotal: undefined })]) });
    render(pending, true);
    expect(container.querySelector('.activity-row-body')).toBeNull();
    expect(container.querySelector('.tool-row-status')?.textContent).toBe('○');
    const completed = step({ attempts: rounds([tool('pending', { toolResult: 'done', toolResultTotal: 4 })]) });
    render(completed, false);
    expect(container.querySelector('.activity-row-body')).toBeNull();
    expect(container.querySelector('.tool-row-status')?.textContent).toBe('✓');
  });

  it('honours a manual open and close of a running step after completion', () => {
    const pending = step({ attempts: rounds([tool('pending')]) });
    render(pending, true);
    toggle();
    expect(container.querySelector('.activity-row-body')).not.toBeNull();
    toggle();
    render(step({ attempts: rounds([tool('pending', { toolResult: 'done', toolResultTotal: 4 })]) }), false);
    expect(container.querySelector('.activity-row-body')).toBeNull();
  });

  it('shows diff counts and keeps the hunks collapsed until the diff is opened', () => {
    const hunks: DiffHunk[] = [{ oldStart: 1, newStart: 1, lines: [
      { kind: 'added', text: 'new' }, { kind: 'removed', text: 'old' },
    ] }];
    render(step({ diffs: [diff('change', hunks)] }));
    expect(container.querySelector('.activity-row-edit')?.textContent).toContain('+1 −1');
    toggle();
    expect(container.querySelector('.diff-block')).not.toBeNull();
    expect(container.querySelectorAll('.diff-line')).toHaveLength(0);
    act(() => container.querySelector<HTMLButtonElement>('.diff-toggle')!.click());
    expect(container.querySelectorAll('.diff-line')).toHaveLength(2);
  });

  it('shows the edit glyph without zero counts when hunks are unavailable', () => {
    render(step({ diffs: [diff('unknown', null)] }));
    expect(container.querySelector('.activity-row-edit')?.textContent).toBe('✎');
  });

  it('shows an amber retry chip and keeps an unrecovered final failure red', () => {
    const earlier = tool('failed', { toolIsError: true, toolResultTotal: 3 });
    const final = tool('success', { toolCallId: 'second', toolResultTotal: 2 });
    render(step({ attempts: rounds([earlier], [final]) }));
    expect(container.querySelector('.activity-row-retry')?.textContent).toBe('1 retry');
    expect(container.querySelector('.activity-row.is-error')).toBeNull();

    render(step({ attempts: rounds([earlier]) }));
    expect(container.querySelector('.activity-row.is-error')).not.toBeNull();
    expect(container.querySelector('.tool-row-status')?.textContent).toBe('✕');

    const again = tool('again', { toolCallId: 'third', toolIsError: true, toolResultTotal: 1 });
    render(step({ attempts: rounds([earlier], [again]) }));
    expect(container.querySelector('.activity-row.is-error')).not.toBeNull();
    expect(container.querySelector('.activity-row-retry')).toBeNull();
    expect(container.querySelector('.activity-row-repeat')).toBeNull();
  });

  it('shortens only the header detail and keeps the full command in the body', () => {
    const command = `cd /workspace && ${'npm test --run-in-band '.repeat(8)}`;
    render(step({ attempts: rounds([tool('call', {
      content: `run_terminal → ${command}`, toolTarget: command, toolDetail: command,
    })]) }));
    expect(container.querySelector('.activity-row-detail')?.textContent)
      .toBe('npm test --run-in-band '.repeat(8));
    toggle();
    expect(container.querySelector('.tool-row-command code')?.textContent).toBe(command);
  });

  it('keeps a manual expand choice when a retry appends to the step', () => {
    const first = tool('first', { toolIsError: true, toolResultTotal: 3 });
    render(step({ attempts: rounds([first]) }));
    toggle();
    expect(container.querySelector('.activity-row-body')).not.toBeNull();

    const retry = tool('retry', { toolCallId: 'retry-id', toolResultTotal: 2 });
    render(step({ attempts: rounds([first], [retry]) }));
    expect(container.querySelector('.activity-row-body')).not.toBeNull();
    expect(container.querySelector('.activity-row-retry')?.textContent).toBe('1 retry');
  });

  it("renders each retry's reasoning just before that retry in the body", () => {
    const first = tool('first', { toolIsError: true, toolResultTotal: 3 });
    const retry = tool('retry', { toolCallId: 'retry-id', toolResultTotal: 2 });
    const thought: AppMessage = { id: 'why', role: 'assistant', content: '', reasoning: 'fix it' };
    render(step({ attempts: [{ thoughts: [], tools: [first] }, { thoughts: [thought], tools: [retry] }] }));
    toggle();
    const body = container.querySelector('.activity-row-body')!;
    const kinds = [...body.children].map((el) => (el.className.includes('thinking') ? 'thought' : 'tool'));
    expect(kinds).toEqual(['tool', 'thought', 'tool']);
  });
});
