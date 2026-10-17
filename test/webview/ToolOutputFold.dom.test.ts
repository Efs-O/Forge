// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppMessage } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { ToolResultContent } = await import('../../webview-ui/src/components/ToolRow');
const React = await import('react');
const { resetDisclosures } = await import('../../webview-ui/src/disclosureState');

function tool(id: string, toolResult: string, extra: Partial<AppMessage> = {}): AppMessage {
  return {
    id,
    role: 'tool',
    content: 'edit_file',
    toolName: 'edit_file',
    toolResult,
    toolResultTotal: toolResult.length,
    ...extra,
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

function render(message: AppMessage): void {
  act(() => root.render(React.createElement(ToolResultContent, { message })));
}

describe('tool output folding', () => {
  it('renders short output inline without an output header or toggle', () => {
    render(tool('short', 'Written src/a.ts'));

    expect(container.textContent).toContain('Written src/a.ts');
    expect(container.querySelector('.tool-row-output-label')).toBeNull();
    expect(container.querySelector('.folded-content-toggle')).toBeNull();
  });

  it('preserves leading and trailing whitespace in short output', () => {
    const output = '  Written src/a.ts  \n';
    render(tool('whitespace', output));

    expect(container.querySelector('.tool-row-verbatim')?.textContent).toBe(output);
  });

  it('previews long output at its tail and remembers show all across updates and remounts', () => {
    const content = Array.from({ length: 7 }, (_, index) => `output ${index + 1}`).join('\n');
    render(tool('long', content));

    const preview = container.querySelector('.folded-content-body')!;
    expect(preview.classList.contains('is-tail-preview')).toBe(true);
    expect(preview.textContent).toContain('output 4');
    expect(preview.textContent).toContain('output 7');
    expect(preview.textContent).not.toContain('output 3');
    act(() => container.querySelector<HTMLButtonElement>('.folded-content-toggle')!.click());

    const updated = `${content}\nnew output`;
    render(tool('long', updated));
    expect(container.querySelector('.folded-content-body')?.textContent).toBe(updated);
    expect(container.querySelector('.folded-content-toggle')?.textContent).toBe('Show less');
    act(() => container.querySelector<HTMLButtonElement>('.folded-content-toggle')!.click());
    expect(container.querySelector('.folded-content-body')?.textContent).not.toContain('output 3');
    act(() => container.querySelector<HTMLButtonElement>('.folded-content-toggle')!.click());

    act(() => root.unmount());
    root = createRoot(container);
    render(tool('other', 'another result'));
    render(tool('long', updated));
    expect(container.querySelector('.folded-content-body')?.textContent).toBe(updated);
  });

  it('keeps the existing error class while using the same folded preview', () => {
    const error = Array.from({ length: 6 }, (_, index) => `error ${index + 1}`).join('\n');
    render(tool('error', error, { toolIsError: true }));

    expect(container.querySelector('.tool-row-output.is-error')).not.toBeNull();
    expect(container.querySelector('.folded-content-body')?.textContent).toContain('error 6');
    expect(container.querySelector('.folded-content-toggle')?.textContent).toBe('Show all');
  });
});
