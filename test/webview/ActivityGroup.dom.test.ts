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
const { WorkspaceRootUriContext } = await import('../../webview-ui/src/workspaceRootUri');
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
  it('reveals individual calls directly when the group is opened', () => {
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

  it('keeps the grouped action wording separate from its muted count', () => {
    render(activityItems(), false, false);
    const button = container.querySelector<HTMLButtonElement>('.activity-group-toggle')!;
    expect(container.querySelector('.activity-group-count')?.textContent).toBe('2');
    expect(container.querySelector('.activity-group-word')?.textContent).toBe('tool calls');
    expect(button.textContent).toContain('2 tool calls');
    expect(button.hasAttribute('aria-label')).toBe(false);
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
    expect(container.querySelector('.activity-group-failed')?.textContent).toBe('1 failed');
    expect(container.querySelector('.activity-group-status')?.textContent).toBe('✕');
  });

  it('shows recovered failures in amber after the count with a successful status', () => {
    const items: ActivityGroupItem[] = [
      {
        kind: 'step',
        step: {
          attempts: [{
            thoughts: [],
            tools: [tool('failed-call', {
              toolName: 'edit_file',
              toolTarget: 'src/a.ts',
              toolIsError: true,
            })],
          }],
          diffs: [],
        },
      },
      {
        kind: 'step',
        step: {
          attempts: [{
            thoughts: [],
            tools: [tool('successful-retry', {
              toolName: 'edit_file',
              toolTarget: 'src/a.ts',
            })],
          }],
          diffs: [],
        },
      },
    ];
    render(items, false, false);
    expect(container.querySelector('.activity-group-status')?.textContent).toBe('✓');
    const failed = container.querySelector('.activity-group-failed')!;
    expect(failed.textContent).toBe('1 failed, recovered');
    expect(failed.classList.contains('is-recovered')).toBe(true);
    expect(container.querySelector('.activity-group-label')?.nextElementSibling).toBe(failed);
    expect(container.querySelector('.activity-group-toggle')?.textContent).not.toContain('Details');
  });

  it('opens a 40-call group with its six-call tail and one earlier-calls gap', () => {
    const items: ActivityGroupItem[] = Array.from({ length: 40 }, (_, index) => ({
      kind: 'step',
      step: {
        attempts: [{
          thoughts: [],
          tools: [tool(`tail-call-${index}`, {
            toolName: 'read_file',
            toolTarget: `src/${index}.ts`,
          })],
        }],
        diffs: [],
      },
    }));
    render(items, false, false);
    toggle();
    expect(container.querySelectorAll('.activity-group-body > .activity-row')).toHaveLength(6);
    expect(container.querySelector('.activity-group-gap')?.textContent).toBe(
      '▴ Show 34 earlier calls',
    );
  });

  it('keeps only the tail and unrecovered failures, and remembers a gap reveal on remount', () => {
    const items: ActivityGroupItem[] = Array.from({ length: 40 }, (_, index) => ({
      kind: 'step',
      step: {
        attempts: [{
          thoughts: [],
          tools: [tool(`call-${index}`, {
            toolName: 'read_file',
            toolTarget: `src/${index}.ts`,
            toolResultTotal: index === 20 ? undefined : 1,
            ...(index === 20 ? { toolIsError: true } : {}),
          })],
        }],
        diffs: [],
      },
    }));
    render(items, false, false);
    toggle();
    expect(container.querySelectorAll('.activity-group-body > .activity-row')).toHaveLength(7);
    const gaps = container.querySelectorAll<HTMLButtonElement>('.activity-group-gap');
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.textContent).toBe('▴ Show 20 earlier calls');
    expect(gaps[1]?.textContent).toBe('⋯ Show 13 more calls');

    act(() => gaps[0]!.click());
    expect(container.querySelectorAll('.activity-group-body > .activity-row')).toHaveLength(27);
    expect(container.querySelectorAll('.activity-group-gap')).toHaveLength(1);

    act(() => root.unmount());
    root = createRoot(container);
    render(items, false, false);
    expect(container.querySelectorAll('.activity-group-body > .activity-row')).toHaveLength(27);
    expect(container.querySelectorAll('.activity-group-gap')).toHaveLength(1);
    act(() => container.querySelector<HTMLButtonElement>('.activity-group-gap')!.click());
    expect(container.querySelectorAll('.activity-group-body > .activity-row')).toHaveLength(40);
    expect(container.querySelectorAll('.activity-group-gap')).toHaveLength(0);
  });

  it('shows one concise pending call below a closed group', () => {
    render(activityItems({ pending: true }), true, true);
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(container.querySelector('.activity-group-status')?.textContent).toBe('●');
    const liveLabel = container.querySelector('.activity-group-label')!;
    expect(liveLabel.textContent).toMatch(/^Working · \d+ calls?$/);
    expect(liveLabel.querySelector('.activity-group-count')?.textContent).toMatch(/^\d+$/);
    expect(liveLabel.querySelector('.activity-group-word')?.textContent).toMatch(/^calls?$/);
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
    expect(container.querySelector('.tool-row-command')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.tool-row-toggle')!.click());
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

  it('shows every folded image, caps the strip, and opens the group from +N more', () => {
    const imagePaths = Array.from(
      { length: 7 },
      (_, index) => `.forge/image-search/c1/${index + 1}.png`,
    );
    const item: ActivityGroupItem = {
      kind: 'step',
      step: {
        attempts: [
          {
            thoughts: [],
            tools: [
              tool('search', {
                content: 'image_search',
                toolName: 'image_search',
                toolResult:
                  'Search complete.\nThumbnails saved and shown to the user (view_image can open them): ' +
                  imagePaths.join(', '),
                toolResultTotal: 200,
              }),
            ],
          },
        ],
        diffs: [],
      },
    };
    act(() => {
      root.render(
        React.createElement(
          WorkspaceRootUriContext.Provider,
          { value: 'https://file.vscode-resource/ws' },
          React.createElement(ActivityGroup, { items: [item], live: false, streaming: false }),
        ),
      );
    });

    expect(container.querySelector('.activity-group-images')?.textContent).toBe('· 7 images');
    expect(container.querySelectorAll('.group-image-strip .tool-row-thumb')).toHaveLength(5);
    const more = container.querySelector<HTMLButtonElement>('.group-image-more')!;
    expect(more.textContent).toBe('+2 more');
    act(() => more.click());
    expect(container.querySelector('.activity-group-toggle')?.getAttribute('aria-expanded')).toBe(
      'true',
    );
  });
});
