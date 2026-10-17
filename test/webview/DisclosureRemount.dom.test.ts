// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityGroupItem, ActivityStep } from '../../webview-ui/src/activityRows';
import type { AppMessage } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { ActivityRow } = await import('../../webview-ui/src/components/ActivityRow');
const { ActivityGroup } = await import('../../webview-ui/src/components/ActivityGroup');
const React = await import('react');
const { resetDisclosures } = await import('../../webview-ui/src/disclosureState');

function tool(id: string, extra: Partial<AppMessage> = {}): AppMessage {
  return {
    id,
    role: 'tool',
    content: 'edit_file → src/a.ts',
    toolName: 'edit_file',
    toolTarget: 'src/a.ts',
    toolResult: 'ok',
    toolResultTotal: 2,
    ...extra,
  };
}

function edit(id: string): ActivityStep {
  return {
    attempts: [{ tools: [tool(`${id}-call`)] }],
    diffs: [
      {
        id: `${id}-diff`,
        role: 'diff',
        content: 'src/a.ts',
        diffIsNew: false,
        diffIsDeleted: false,
        diffHunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'added', text: 'x' }] }],
      },
    ],
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

describe('tool disclosure choices across remounts', () => {
  it('keeps an opened step and its opened diff when the step joins a group', () => {
    const first = edit('a');
    show(React.createElement(ActivityRow, { step: first }));
    click('.activity-row-header');
    click('.diff-toggle');
    expect(container.querySelectorAll('.diff-line')).toHaveLength(1);

    const items: ActivityGroupItem[] = [{ kind: 'step', step: first }, { kind: 'step', step: edit('b') }];
    show(React.createElement(ActivityGroup, { items, live: true }));
    const rows = container.querySelectorAll('.activity-row-header');
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(rows[1]?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.diff-line')).toHaveLength(1);
  });

  it('keeps a running step closed until the reader opens it', () => {
    const running = edit('a');
    running.attempts[0]!.tools[0] = tool('a-call', {
      toolResult: undefined,
      toolResultTotal: undefined,
    });
    show(React.createElement(ActivityRow, { step: running }));
    expect(container.querySelector('.activity-row-body')).toBeNull();
    click('.activity-row-header');
    expect(container.querySelector('.activity-row-body')).not.toBeNull();
    click('.activity-row-header');
    expect(container.querySelector('.activity-row-body')).toBeNull();
  });

  it('keeps a live group closed and reveals its calls directly on request', () => {
    const completed = (id: string): ActivityStep => ({
      attempts: [{ tools: [tool(id, { toolResult: 'done', toolResultTotal: 4 })] }],
      diffs: [],
    });
    const items: ActivityGroupItem[] = [
      { kind: 'step', step: completed('first') },
      { kind: 'step', step: completed('second') },
    ];
    show(React.createElement(ActivityGroup, { items, live: true }));
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe('false');
    click('.activity-group-toggle');
    expect(container.querySelectorAll('.activity-group-body > .activity-row')).toHaveLength(2);
    expect(container.querySelector('.activity-run')).toBeNull();
  });
});
