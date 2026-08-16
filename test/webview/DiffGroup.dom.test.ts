// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DiffHunk } from '../../src/sidebar/messageBridge';

/**
 * DOM tests for the per-turn diff summary card. Follows the ModelManager DOM
 * test pattern: stub `acquireVsCodeApi` before importing the component (the
 * webview `vscode.ts` singleton calls it at module scope), mount with
 * `createRoot`, drive with real DOM events — no @testing-library dependency.
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

const { DiffGroup } = await import('../../webview-ui/src/components/DiffGroup');
const React = await import('react');

function hunk(added: number, removed: number): DiffHunk[] {
  const lines = [
    ...Array.from({ length: added }, (_, i) => ({ kind: 'added' as const, text: `add ${i}` })),
    ...Array.from({ length: removed }, (_, i) => ({ kind: 'removed' as const, text: `del ${i}` })),
  ];
  return [{ oldStart: 1, newStart: 1, lines }];
}

function diffMessage(id: string, filePath: string, added: number, removed: number) {
  return {
    id,
    role: 'diff' as const,
    content: filePath,
    diffHunks: hunk(added, removed),
    diffIsNew: false,
    diffIsDeleted: false,
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

function render(diffs: ReturnType<typeof diffMessage>[]): void {
  act(() => {
    root.render(React.createElement(DiffGroup, { diffs }));
  });
}

describe('DiffGroup', () => {
  it('summarises several files into one collapsed header', () => {
    render([
      diffMessage('a', 'src/one.ts', 10, 2),
      diffMessage('b', 'src/two.ts', 5, 4),
      diffMessage('c', 'src/three.ts', 1, 0),
    ]);

    const header = container.querySelector('.diff-group-header');
    expect(header?.textContent).toContain('Edited 3 files');
    expect(header?.textContent).toContain('+16');
    expect(header?.textContent).toContain('−6');
    // Collapsed by default: no per-file rows and no diff lines are rendered.
    expect(container.querySelectorAll('.diff-block')).toHaveLength(0);
    expect(container.querySelectorAll('.diff-line')).toHaveLength(0);
  });

  it('expands to one collapsed row per file', () => {
    render([diffMessage('a', 'src/one.ts', 10, 2), diffMessage('b', 'src/two.ts', 5, 4)]);

    act(() => {
      container.querySelector<HTMLButtonElement>('.diff-group-header')!.click();
    });

    expect(container.querySelectorAll('.diff-block')).toHaveLength(2);
    // Rows inside a group start closed regardless of size.
    expect(container.querySelectorAll('.diff-line')).toHaveLength(0);

    act(() => {
      container.querySelectorAll<HTMLButtonElement>('.diff-toggle')[0]!.click();
    });
    expect(container.querySelectorAll('.diff-line').length).toBe(12);
  });

  it('renders a single edited file as a plain block with no group header', () => {
    render([diffMessage('a', 'src/only.ts', 3, 1)]);

    expect(container.querySelector('.diff-group-header')).toBeNull();
    expect(container.querySelectorAll('.diff-block')).toHaveLength(1);
  });

  it('opens the file when its path is clicked', () => {
    render([diffMessage('a', 'src/only.ts', 3, 1)]);

    act(() => {
      container.querySelector<HTMLButtonElement>('.diff-filepath-link')!.click();
    });

    expect(posted).toEqual([{ type: 'openFile', path: 'src/only.ts' }]);
  });
});
