// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppMessage } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: () => {} });

const { ToolGroup } = await import('../../webview-ui/src/components/ToolGroup');
const React = await import('react');
const { resetDisclosures } = await import('../../webview-ui/src/disclosureState');

const tools: AppMessage[] = [
  { id: 'one', role: 'tool', content: 'read_file → src/a.ts', toolName: 'read_file' },
  { id: 'two', role: 'tool', content: 'search_code → TODO', toolName: 'search_code' },
  { id: 'three', role: 'tool', content: 'read_file → src/b.ts', toolName: 'read_file' },
];

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

describe('ToolGroup', () => {
  it('collapses adjacent calls and shows each original row in order when expanded', () => {
    act(() => {
      root.render(React.createElement(ToolGroup, { tools }));
    });

    expect(container.textContent).toContain('3 tool calls');
    expect(container.querySelector('.tool-group-body')).toBeNull();

    act(() => {
      container.querySelector<HTMLButtonElement>('.tool-group-toggle')!.click();
    });

    expect(
      [...container.querySelectorAll('.tool-row-name')].map((node) => node.textContent),
    ).toEqual(['read_file', 'search_code', 'read_file']);
  });

  it('keeps a manually opened tool group visible across a remount', () => {
    act(() => root.render(React.createElement(ToolGroup, { tools })));
    act(() => container.querySelector<HTMLButtonElement>('.tool-group-toggle')!.click());
    act(() => root.render(React.createElement('div')));
    act(() => root.render(React.createElement(ToolGroup, { tools })));
    expect(container.querySelector('.tool-group-body')).not.toBeNull();
  });

  it('shows nested rows without auto-expanding a long shell result', () => {
    const nestedTools: AppMessage[] = [
      {
        id: 'shell',
        role: 'tool',
        content: 'run_command → npm test',
        toolName: 'run_command',
        toolResult: 'test output '.repeat(20),
      },
      { id: 'short', role: 'tool', content: 'read_file → src/a.ts', toolResult: 'ok' },
    ];
    act(() => root.render(React.createElement(ToolGroup, { tools: nestedTools, nested: true })));

    expect(container.querySelector('.tool-group-body')).not.toBeNull();
    expect(container.querySelectorAll('.tool-row-body')).toHaveLength(1);
    expect(container.querySelector('.tool-row-body')?.textContent).toBe('ok');
  });
});
