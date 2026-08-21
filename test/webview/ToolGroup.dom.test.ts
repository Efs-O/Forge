// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppMessage } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } })
  .acquireVsCodeApi = () => ({ postMessage: () => {} });

const { ToolGroup } = await import('../../webview-ui/src/components/ToolGroup');
const React = await import('react');

const tools: AppMessage[] = [
  { id: 'one', role: 'tool', content: 'read_file → src/a.ts', toolName: 'read_file' },
  { id: 'two', role: 'tool', content: 'search_code → TODO', toolName: 'search_code' },
  { id: 'three', role: 'tool', content: 'read_file → src/b.ts', toolName: 'read_file' },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
});
