// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityGroupItem } from '../../webview-ui/src/activityRows';
import type { AppMessage } from '../../webview-ui/src/messageOps';
import type { PendingToolCall } from '../../webview-ui/src/pendingToolCalls';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { ActivityGroup } = await import('../../webview-ui/src/components/ActivityGroup');
const React = await import('react');
const { resetDisclosures } = await import('../../webview-ui/src/disclosureState');

function tool(id: string, extra: Partial<AppMessage> = {}): AppMessage {
  return {
    id,
    role: 'tool',
    content: 'edit_file',
    toolName: 'edit_file',
    toolResultTotal: 10,
    ...extra,
  };
}

function activityItems(options: { failed?: boolean; pending?: boolean } = {}): ActivityGroupItem[] {
  const first: AppMessage = {
    id: 'thought',
    role: 'assistant',
    content: '',
    reasoning: 'planning',
    reasoningMs: 1_000,
  };
  const finalTool = options.pending
    ? tool('pending', { toolResultTotal: undefined })
    : tool('completed', options.failed ? { toolIsError: true } : {});
  return [
    { kind: 'step', step: { attempts: [{ thoughts: [first], tools: [finalTool] }], diffs: [] } },
    {
      kind: 'step',
      step: {
        attempts: [
          {
            thoughts: [],
            tools: [tool('second', { content: 'read_file', toolName: 'read_file' })],
          },
        ],
        diffs: [],
      },
    },
  ];
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

function render(
  items: ActivityGroupItem[],
  live: boolean,
  streaming: boolean,
  pendingCalls?: readonly PendingToolCall[],
): void {
  act(() =>
    root.render(React.createElement(ActivityGroup, { items, live, streaming, pendingCalls })),
  );
}

function toggle(): void {
  act(() => container.querySelector<HTMLButtonElement>('.activity-group-toggle')!.click());
}

describe('ActivityGroup', () => {
  it('reveals individual calls directly when Details is opened', () => {
    const shell = (id: string, command: string): ActivityGroupItem => ({
      kind: 'step',
      step: {
        attempts: [
          {
            thoughts: [],
            tools: [
              tool(id, { content: `shell → ${command}`, toolName: 'shell', toolTarget: command }),
            ],
          },
        ],
        diffs: [],
      },
    });
    render(
      [
        shell('s1', 'cd "n:/a b" && grep -n x f'),
        shell('s2', 'sed -n 1p f'),
        shell('s3', 'grep y f'),
      ],
      false,
      false,
    );
    toggle();
    expect(container.querySelectorAll('.activity-group-body > .activity-row')).toHaveLength(3);
    expect(container.querySelector('.activity-run')).toBeNull();
  });

  it('starts closed while live and shows the working header', () => {
    render(activityItems(), true, true);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(container.textContent).toContain('●Working · 2 calls');
    expect(container.querySelectorAll('.activity-row')).toHaveLength(0);
  });

  it('starts collapsed for completed history loaded later', () => {
    render(activityItems(), false, false);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(container.querySelector('.activity-group-body')).toBeNull();
  });

  it('stays closed when live ends if the reader did not toggle it', () => {
    const items = activityItems();
    render(items, true, true);
    render(items, false, false);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(container.querySelectorAll('.activity-row')).toHaveLength(0);
  });

  it('keeps a manual toggle across the live-to-not-live transition', () => {
    const items = activityItems();
    render(items, true, true);
    toggle(); // Explicitly open the live group.
    render(items, false, false);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(container.querySelectorAll('.activity-group-body > .activity-row')).toHaveLength(2);
  });

  it('shows an unrecovered failure in the closed summary', () => {
    render(activityItems({ failed: true }), false, false);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(container.querySelector('.activity-group-failed')?.textContent).toBe('[1 failed]');
    expect(container.querySelector('.activity-group-status')?.textContent).toBe('✕');
  });

  it('shows one concise pending call below a closed group', () => {
    render(activityItems({ pending: true }), true, true);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(container.querySelector('.activity-group-status')?.textContent).toBe('●');
    expect(container.querySelector('.activity-group-pending')?.textContent).toContain('edit_file');
    expect(container.querySelectorAll('.activity-row')).toHaveLength(0);
    render(activityItems(), false, false);
    expect(container.querySelector('.activity-group-pending')).toBeNull();
  });

  it('keeps a live call line as calls move from writing to recorded and then accumulate', () => {
    const writing: PendingToolCall = {
      index: 0,
      toolCallId: 'call-1',
      toolName: 'shell',
      target: 'rg -n x src',
      tokens: 12,
      startedAt: 1,
    };
    render([], true, true, [writing]);
    expect(container.textContent).toContain('Working · 1 call');
    expect(container.querySelector<HTMLButtonElement>('.activity-group-toggle')?.disabled).toBe(
      true,
    );
    expect(container.querySelector('.activity-group-details')).toBeNull();
    expect(container.querySelector('.activity-group-pending')?.textContent).toContain('shell');
    expect(container.querySelector('.activity-group-pending .is-pending')?.textContent).toBe('○');

    const first: ActivityGroupItem = {
      kind: 'step',
      step: {
        attempts: [
          {
            thoughts: [],
            tools: [
              tool('first', {
                content: 'shell → rg -n x src',
                toolName: 'shell',
                toolTarget: 'rg -n x src',
                toolCallId: 'call-1',
                toolResultTotal: undefined,
              }),
            ],
          },
        ],
        diffs: [],
      },
    };
    render([first], true, true);
    expect(container.textContent).toContain('Working · 1 call');
    expect(container.querySelector('.activity-group-pending')?.textContent).toContain('shell');

    const second: ActivityGroupItem = {
      kind: 'step',
      step: {
        attempts: [
          {
            thoughts: [],
            tools: [
              tool('second', {
                content: 'read_file → src/app.ts',
                toolName: 'read_file',
                toolTarget: 'src/app.ts',
                toolResultTotal: 10,
              }),
            ],
          },
        ],
        diffs: [],
      },
    };
    const completedFirst: ActivityGroupItem = {
      kind: 'step',
      step: {
        attempts: [
          {
            thoughts: [],
            tools: [
              tool('first', {
                content: 'shell → rg -n x src',
                toolName: 'shell',
                toolTarget: 'rg -n x src',
                toolCallId: 'call-1',
              }),
            ],
          },
        ],
        diffs: [],
      },
    };
    render([completedFirst, second], true, true);
    expect(container.textContent).toContain('Working · 2 calls');
    expect(container.querySelector('.activity-group-pending')?.textContent).toContain('read_file');
    expect(container.querySelector('.activity-group-pending .is-ok')?.textContent).toBe('✓');
  });

  it('does not call a historical incomplete step running during a later turn', () => {
    render(activityItems({ pending: true }), false, true);
    expect(container.querySelector('.activity-group-status')?.textContent).toBe('○');
    expect(container.querySelector('.activity-group-pending')).toBeNull();
  });

  it('keeps live edit totals in the closed summary', () => {
    const items = activityItems();
    if (items[0]?.kind !== 'step') throw new Error('expected a step');
    items[0].step.diffs.push({
      id: 'diff',
      role: 'diff',
      content: 'serve/server.py',
      diffHunks: [{ oldStart: 1, newStart: 1, lines: [{ kind: 'added', text: 'new' }] }],
    });
    render(items, true, true);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(container.querySelector('.activity-group-edit-stats')?.textContent).toContain('✎ 1 +1');
    expect(container.querySelector('.activity-group-edits')?.textContent).toBe('to server.py');
  });

  it('opens a full command and result after Details and one call click', () => {
    const command = 'cd /workspace && grep -n max_context serve/server.py';
    const items: ActivityGroupItem[] = [
      {
        kind: 'step',
        step: {
          attempts: [
            {
              thoughts: [],
              tools: [
                tool('shell', {
                  content: `shell → ${command}`,
                  toolName: 'shell',
                  toolTarget: command,
                  toolDetail: command,
                  toolResult: 'match at line 42',
                  toolResultTotal: 16,
                }),
              ],
            },
          ],
          diffs: [],
        },
      },
    ];
    render(items, false, false);
    toggle();
    expect(container.querySelectorAll('.activity-group-body > .activity-row')).toHaveLength(1);
    act(() => container.querySelector<HTMLButtonElement>('.activity-row-header')!.click());
    expect(container.querySelector('.tool-row-command code')?.textContent).toBe(command);
    expect(container.querySelector('.tool-row-verbatim')?.textContent).toBe('match at line 42');
  });

  it('counts recovered retries with the right plural', () => {
    const failedTry = (id: string) => ({ thoughts: [], tools: [tool(id, { toolIsError: true })] });
    const recovered = (n: number): ActivityGroupItem => ({
      kind: 'step',
      step: {
        attempts: [
          ...Array.from({ length: n }, (_, i) => failedTry(`f${n}-${i}`)),
          { thoughts: [], tools: [tool(`ok${n}`)] },
        ],
        diffs: [],
      },
    });
    render(
      [
        recovered(1),
        { kind: 'step', step: { attempts: [{ thoughts: [], tools: [tool('x')] }], diffs: [] } },
      ],
      false,
      false,
    );
    expect(container.querySelector('.activity-group-retry')?.textContent).toBe('[1 retry]');
    render([recovered(1), recovered(2)], false, false);
    expect(container.querySelector('.activity-group-retry')?.textContent).toBe('[3 retries]');
  });
});
