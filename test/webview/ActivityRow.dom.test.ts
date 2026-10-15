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
    toolDetail: 'cd /workspace && npm test', toolResult: 'ok', toolResultTotal: 2,
    toolMs: 3_500, ...fields,
  };
}

/** Tool rounds as attempts with no reasoning before them. */
function rounds(...tools: AppMessage[][]): ActivityStep['attempts'] {
  return tools.map((round) => ({ thoughts: [], tools: round }));
}

function step(overrides: Partial<ActivityStep> = {}): ActivityStep {
  return {
    attempts: rounds([tool('call')]),
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
  act(() => container.querySelector<HTMLElement>('.activity-row-header')!.click());
}

describe('ActivityRow', () => {
  it('renders one call row and folds its result behind its own Output toggle', () => {
    render(step());
    expect(container.querySelector('.activity-row-body')).toBeNull();
    expect(container.querySelector('.activity-row-header')?.getAttribute('role')).toBe('button');
    expect(container.querySelector('.activity-row-header')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.tool-row-name')).toHaveLength(0);
    expect(container.textContent).not.toContain('result');
    expect(container.textContent).not.toContain('ok');

    toggle();
    expect(container.querySelector('.activity-row-body')).not.toBeNull();
    const output = container.querySelector<HTMLElement>('.tool-row-output-toggle')!;
    expect(output.textContent).toBe('▸ Output · 2 chars');
    expect(output.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.tool-row-output-body')).toBeNull();

    act(() => output.click());
    expect(output.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.tool-row-output-body')?.textContent).toContain('ok');
    expect(container.querySelectorAll('.tool-row-name')).toHaveLength(0);
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
    const pending = step({ attempts: rounds([tool('pending', { toolResult: undefined, toolResultTotal: undefined })]) });
    render(pending, true);
    toggle();
    expect(container.querySelector('.activity-row-body')).not.toBeNull();
    toggle();
    render(step({ attempts: rounds([tool('pending', { toolResult: 'done', toolResultTotal: 4 })]) }), false);
    expect(container.querySelector('.activity-row-body')).toBeNull();
  });

  it('shows tag, diff counts and time on the row and opens the existing diff disclosure', () => {
    const hunks: DiffHunk[] = [{ oldStart: 1, newStart: 1, lines: [
      { kind: 'added', text: 'new' }, { kind: 'removed', text: 'old' },
    ] }];
    render(step({ diffs: [diff('change', hunks)] }));
    expect(container.querySelector('.activity-row-tag')?.textContent).toBe('MODIFIED');
    expect(container.querySelector('.activity-row-diff-link')?.textContent).toBe('+1−1');
    expect(container.querySelector('.activity-row-time')?.textContent).toBe('3.5 s');
    expect(container.querySelector('.activity-row-edit')).toBeNull();

    const link = container.querySelector<HTMLButtonElement>('.activity-row-diff-link')!;
    act(() => link.click());
    expect(container.querySelector('.activity-row-header')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('.diff-line')).toHaveLength(2);
  });

  it('shows NEW for a new file and uses the word diff when counts are unavailable', () => {
    render(step({ diffs: [{ ...diff('new-file', null), diffIsNew: true }] }));
    expect(container.querySelector('.activity-row-tag')?.textContent).toBe('NEW');
    expect(container.querySelector('.activity-row-diff-link')?.textContent).toBe('diff');
  });

  it('opens with Enter and Space and keeps the diff as a separate focusable button', () => {
    render(step({ diffs: [diff('change', null)] }));
    const header = container.querySelector<HTMLElement>('.activity-row-header')!;
    expect(header.tabIndex).toBe(0);
    expect(container.querySelector('.activity-row-diff-link')?.tagName).toBe('BUTTON');

    act(() => header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(header.getAttribute('aria-expanded')).toBe('true');
    act(() => header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    expect(header.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows a failed call first line without opening and keeps the full error in its title', () => {
    const error = 'Error: permission denied\nAdditional diagnostic details';
    render(step({ attempts: rounds([tool('failed', {
      toolResult: error, toolIsError: true, toolResultTotal: 3, toolMs: 1_200,
    })]) }));
    const line = container.querySelector<HTMLElement>('.activity-row-error-line');
    expect(line?.textContent).toBe('Error: permission denied');
    expect(line?.title).toBe(error);
    expect(container.querySelector('.activity-row-body')).toBeNull();
    expect(container.querySelector('.activity-row-header')?.getAttribute('title')).toBe('1.2 s');
  });

  it('never shows the error line as the target of a failed call without one', () => {
    // Live rows carry the result label as content when no target was extracted.
    render(step({ attempts: rounds([tool('failed', {
      content: 'read_files → Error: paths must be an array',
      toolName: 'read_files', toolTarget: undefined, toolDetail: undefined,
      toolResult: 'Error: paths must be an array', toolIsError: true,
    })]) }));
    expect(container.querySelector('.activity-row-detail')).toBeNull();
    expect(container.querySelector('.activity-row-error-line')?.textContent)
      .toBe('Error: paths must be an array');
  });

  it('shows no retry chip on a step that ended red, and ×N without retries for a clean repeat', () => {
    const failed = (id: string): AppMessage => tool(id, { toolIsError: true, toolResult: 'Error: x' });
    render(step({ attempts: rounds([failed('a')], [failed('b')]) }));
    expect(container.querySelector('.activity-row-retry')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    render(step({ attempts: rounds([tool('c')], [tool('d')]) }));
    expect(container.querySelector('.activity-row-repeat')?.textContent).toBe('×2');
    expect(container.querySelector('.activity-row-retry')).toBeNull();
  });

  it('shows a retry count and compact lines for every attempt in order', () => {
    const earlier = tool('failed', { toolIsError: true, toolResult: 'Error: first', toolResultTotal: 3, toolMs: 1_200 });
    const final = tool('success', { toolCallId: 'second', toolResultTotal: 2, toolMs: 3_500 });
    render(step({ attempts: rounds([earlier], [final]) }));
    expect(container.querySelector('.activity-row-retry')?.textContent).toBe('1 retry');
    expect(container.querySelector('.activity-row.is-error')).toBeNull();
    toggle();
    expect([...container.querySelectorAll('.activity-row-attempt-name')].map((node) => node.textContent))
      .toEqual(['run_terminal', 'run_terminal']);
    expect(container.querySelectorAll('.activity-row-attempt')).toHaveLength(2);
    expect(container.querySelector('.activity-row-attempt-error')?.textContent).toBe('Error: first');
    expect(container.querySelector('.tool-row-output')?.textContent).toContain('Output');
  });

  it('renders one named compact line per parallel call', () => {
    const parallel = [
      tool('one', { toolName: 'read_file', toolTarget: 'src/a.ts', toolResult: 'a', toolResultTotal: 1 }),
      tool('two', { toolName: 'search_code', toolTarget: 'TODO', toolResult: 'b', toolResultTotal: 1 }),
    ];
    render(step({ attempts: rounds(parallel) }));
    expect(container.querySelector('.activity-row-parallel')?.textContent).toBe('+1 parallel');
    toggle();
    expect([...container.querySelectorAll('.activity-row-attempt-name')].map((node) => node.textContent))
      .toEqual(['read_file', 'search_code']);
    expect([...container.querySelectorAll('.activity-row-attempt-target')].map((node) => node.textContent))
      .toEqual(['src/a.ts', 'TODO']);
    expect(container.querySelectorAll('.tool-row-name')).toHaveLength(0);
  });

  it('shows Command only when the row target is cut short', () => {
    render(step());
    const target = container.querySelector<HTMLElement>('.activity-row-detail')!;
    Object.defineProperties(target, {
      scrollWidth: { configurable: true, value: 80 },
      clientWidth: { configurable: true, value: 80 },
    });
    toggle();
    expect(container.querySelector('.tool-row-command')).toBeNull();

    toggle();
    render(step());
    const clipped = container.querySelector<HTMLElement>('.activity-row-detail')!;
    Object.defineProperties(clipped, {
      scrollWidth: { configurable: true, value: 200 },
      clientWidth: { configurable: true, value: 80 },
    });
    toggle();
    expect(container.querySelector('.tool-row-command-label')?.textContent).toBe('Command');
    expect(container.querySelector('.tool-row-command code')?.textContent).toBe('cd /workspace && npm test');
    expect(container.querySelector('.tool-row-command-toggle')).toBeNull();
  });

  it('folds a multiline command to a cd-stripped first line and keeps its open choice across remount', () => {
    const command = 'cd "/workspace" && python - <<\'PY\'\nprint("one")\nprint("two")\nPY';
    const activity = step({
      attempts: rounds([tool('call', { toolTarget: 'run Python script', toolDetail: command })]),
    });
    render(activity);
    const setTargetWidth = (): void => {
      const target = container.querySelector<HTMLElement>('.activity-row-detail')!;
      Object.defineProperties(target, {
        scrollWidth: { configurable: true, value: 200 },
        clientWidth: { configurable: true, value: 80 },
      });
    };
    setTargetWidth();
    toggle();

    const commandToggle = container.querySelector<HTMLButtonElement>('.tool-row-command-toggle')!;
    expect(commandToggle.textContent).toBe('▸ Command · 4 lines python - <<\'PY\'');
    expect(commandToggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.tool-row-command code')).toBeNull();

    act(() => commandToggle.click());
    expect(container.querySelector('.tool-row-command code')?.textContent).toBe(command);

    act(() => root.unmount());
    root = createRoot(container);
    render(activity);
    toggle();
    setTargetWidth();
    toggle();
    expect(container.querySelector('.tool-row-command-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.tool-row-command code')?.textContent).toBe(command);
  });

  it('renders a multi-edit detail once and keeps its short result hidden until opened', () => {
    render(step({ attempts: rounds([tool('edit', {
      toolName: 'edit_file', toolTarget: 'src/a.ts · 2 edits', toolDetail: 'src/a.ts · 2 edits',
      toolResult: 'Replaced in src/a.ts', toolResultTotal: 21,
    })]) }));
    expect(container.textContent?.match(/2 edits/gu)).toHaveLength(1);
    expect(container.textContent).not.toContain('Replaced in src/a.ts');
    toggle();
    expect(container.textContent).not.toContain('Replaced in src/a.ts');
    act(() => container.querySelector<HTMLElement>('.tool-row-output-toggle')!.click());
    expect(container.textContent).toContain('Replaced in src/a.ts');
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

  it("renders each retry's reasoning before that attempt's compact line", () => {
    const first = tool('first', { toolIsError: true, toolResultTotal: 3 });
    const retry = tool('retry', { toolCallId: 'retry-id', toolResultTotal: 2 });
    const thought: AppMessage = { id: 'why', role: 'assistant', content: '', reasoning: 'fix it' };
    render(step({ attempts: [{ thoughts: [], tools: [first] }, { thoughts: [thought], tools: [retry] }] }));
    toggle();
    const body = container.querySelector('.activity-row-body')!;
    expect(body.children[0]?.classList.contains('activity-row-attempts')).toBe(true);
    expect(body.children[1]?.classList.contains('thinking-row')).toBe(true);
    expect(body.children[2]?.classList.contains('activity-row-attempts')).toBe(true);
  });
});
