// @vitest-environment jsdom
// A streaming turn moves the same messages between components: a trailing
// thinking row folds into the next call's step, and a lone step is pulled into
// a group when a second one arrives. Each move remounts. The reader's
// open/closed choices must survive it (disclosureState.ts).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityGroupItem, ActivityStep } from '../../webview-ui/src/activityRows';
import type { AppMessage } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } })
  .acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { ActivityRow } = await import('../../webview-ui/src/components/ActivityRow');
const { ActivityGroup } = await import('../../webview-ui/src/components/ActivityGroup');
const { ThinkingGroup } = await import('../../webview-ui/src/components/ThinkingGroup');
const React = await import('react');
const { resetDisclosures } = await import('../../webview-ui/src/disclosureState');

const thought: AppMessage = {
  id: 'thought', role: 'assistant', content: '', reasoning: 'check the file first', reasoningMs: 2_000,
};

function tool(id: string, extra: Partial<AppMessage> = {}): AppMessage {
  return {
    id, role: 'tool', content: 'edit_file → src/a.ts', toolName: 'edit_file',
    toolTarget: 'src/a.ts', toolResult: 'ok', toolResultTotal: 2, ...extra,
  };
}

function edit(id: string, thoughts: AppMessage[] = []): ActivityStep {
  return {
    attempts: [{ thoughts, tools: [tool(`${id}-call`)] }],
    diffs: [{
      id: `${id}-diff`, role: 'diff', content: 'src/a.ts', diffIsNew: false, diffIsDeleted: false,
      diffHunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'added', text: 'x' }] }],
    }],
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

function show(element: React.ReactElement): void {
  act(() => root.render(element));
}

function click(selector: string): void {
  act(() => container.querySelector<HTMLButtonElement>(selector)!.click());
}

describe('open/closed choices across remounts', () => {
  it('keeps an opened reasoning bubble open when it folds into the next call', () => {
    show(React.createElement(ThinkingGroup, { steps: [thought] }));
    click('.thinking-row-toggle');
    expect(container.querySelector('.thinking-content')).not.toBeNull();

    show(React.createElement(ActivityRow, { step: edit('a', [thought]), streaming: true }));
    expect(container.querySelector('.activity-row-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.thinking-content')?.textContent).toBe('check the file first');
  });

  it('does not open a step for a reasoning bubble the reader never opened', () => {
    show(React.createElement(ThinkingGroup, { steps: [thought] }));
    show(React.createElement(ActivityRow, { step: edit('a', [thought]), streaming: true }));
    expect(container.querySelector('.activity-row-body')).toBeNull();
  });

  it('keeps an opened step and its opened diff when the step joins a group', () => {
    const first = edit('a');
    show(React.createElement(ActivityRow, { step: first, streaming: true }));
    click('.activity-row-header');
    click('.diff-toggle');
    expect(container.querySelectorAll('.diff-line')).toHaveLength(1);

    const items: ActivityGroupItem[] = [{ kind: 'step', step: first }, { kind: 'step', step: edit('b') }];
    show(React.createElement(ActivityGroup, { items, live: true, streaming: true }));
    const rows = container.querySelectorAll('.activity-row-header');
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(rows[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.diff-line')).toHaveLength(1);
  });

  it('lets the reader collapse a step that a running call forced open', () => {
    const running = edit('a');
    running.attempts[0]!.tools[0] = tool('a-call', { toolResult: undefined, toolResultTotal: undefined });
    show(React.createElement(ActivityRow, { step: running, streaming: true }));
    expect(container.querySelector('.activity-row-body')).not.toBeNull();
    click('.activity-row-header');
    expect(container.querySelector('.activity-row-body')).toBeNull();
  });

  it('keeps an automatically opened call visible when completed calls fold into a run', () => {
    const completed = (id: string): ActivityStep => ({
      attempts: [{ thoughts: [], tools: [tool(id, { toolResult: 'done', toolResultTotal: 4 })] }],
      diffs: [],
    });
    const running: ActivityStep = {
      attempts: [{ thoughts: [], tools: [tool('second', { toolResult: undefined, toolResultTotal: undefined })] }],
      diffs: [],
    };
    show(React.createElement(ActivityRow, { step: running, streaming: true }));
    expect(container.querySelector('.activity-row-body')).not.toBeNull();

    const items: ActivityGroupItem[] = [
      { kind: 'step', step: completed('first') },
      { kind: 'step', step: completed('second') },
    ];
    show(React.createElement(ActivityGroup, { items, live: false, streaming: false }));
    expect(container.querySelector('.activity-run .activity-row-header')?.getAttribute('aria-expanded')).toBe('true');
    const steps = container.querySelectorAll('.activity-run .activity-row-body .activity-row-header');
    expect(steps[1]?.getAttribute('aria-expanded')).toBe('true');
  });
});
