// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppMessage } from '../../webview-ui/src/messageOps';

/**
 * DOM tests for the tool row. The behaviour under test is the one that used to
 * be impossible: a long result (a delegated agent's report) stays readable and
 * collapsible instead of being flattened to a 600-char single-line preview.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let posted: unknown[] = [];

(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({
  postMessage: (msg: unknown) => {
    posted.push(msg);
  },
});

const { ToolRow } = await import('../../webview-ui/src/components/ToolRow');
const React = await import('react');

const LONG_REPORT = ['# Report', '', 'First paragraph.', '', 'Second paragraph.'].join('\n') +
  '\n'.padEnd(400, 'x');

function toolMessage(extra: Partial<AppMessage> = {}): AppMessage {
  return {
    id: 't1',
    role: 'tool',
    content: 'codex → Summary line',
    toolName: 'codex',
    ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  posted = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(message: AppMessage): void {
  act(() => {
    root.render(React.createElement(ToolRow, { message }));
  });
}

describe('ToolRow', () => {
  it('renders a short result as a plain one-line row', () => {
    render(toolMessage({ toolResult: 'ok', toolResultTotal: 2 }));

    expect(container.querySelector('.tool-row-toggle')).toBeNull();
    expect(container.querySelector('.tool-row-body')).toBeNull();
    expect(container.querySelector('.tool-row-name')?.textContent).toBe('codex');
    expect(container.querySelector('.tool-row-detail')?.textContent).toBe('Summary line');
  });

  it('collapses a long result behind a toggle and reports its size', () => {
    render(toolMessage({ toolResult: LONG_REPORT, toolResultTotal: 3100 }));

    expect(container.querySelector('.tool-row-body')).toBeNull();
    expect(container.querySelector('.tool-row-size')?.textContent).toBe('3.1k chars');
  });

  it('expands to the full report with its structure intact', () => {
    render(toolMessage({ toolResult: LONG_REPORT, toolResultTotal: 3100 }));

    act(() => {
      container.querySelector<HTMLButtonElement>('.tool-row-toggle')!.click();
    });

    const body = container.querySelector('.tool-row-body')!;
    // Markdown, not a flattened single line: the heading and both paragraphs survive.
    expect(body.querySelector('h1')?.textContent).toBe('Report');
    expect(body.querySelectorAll('p').length).toBeGreaterThanOrEqual(2);
    expect(body.textContent).toContain('Second paragraph.');
  });

  it('marks a failed call', () => {
    render(toolMessage({ toolResult: 'Error: nope', toolIsError: true }));
    expect(container.querySelector('.msg-tool-row-error')).not.toBeNull();
  });

  it('offers an open link for a touched file and passes ctrl-click through', () => {
    render(toolMessage({ toolResult: 'written', toolFilePath: 'C:/repo/src/a.ts' }));

    const open = container.querySelector<HTMLButtonElement>('.tool-row-open')!;
    act(() => open.click());
    expect(posted).toEqual([{ type: 'openFile', path: 'C:/repo/src/a.ts' }]);

    posted = [];
    act(() => {
      open.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    });
    expect(posted).toEqual([{ type: 'openFile', path: 'C:/repo/src/a.ts', beside: true }]);
  });

  it('renders an activity row that has no result yet', () => {
    render(toolMessage());
    expect(container.querySelector('.tool-row-name')?.textContent).toBe('codex');
    expect(container.querySelector('.tool-row-body')).toBeNull();
  });
});
