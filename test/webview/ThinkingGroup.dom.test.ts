// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppMessage } from '../../webview-ui/src/messageOps';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(
  globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (msg: unknown) => void } }
).acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { ThinkingGroup } = await import('../../webview-ui/src/components/ThinkingGroup');
const { isReasoningOnly } = await import('../../webview-ui/src/activityRows');
const React = await import('react');
const { resetDisclosures } = await import('../../webview-ui/src/disclosureState');

function thought(id: string, reasoning: string, extra: Partial<AppMessage> = {}): AppMessage {
  return { id, role: 'assistant', content: '', reasoning, ...extra };
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
  steps: AppMessage[],
  displayMode: 'preview' | 'open' | 'collapsed' = 'preview',
  streaming = false,
): void {
  act(() => {
    root.render(React.createElement(ThinkingGroup, { steps, displayMode, streaming }));
  });
}

describe('isReasoningOnly', () => {
  it('matches assistant messages carrying reasoning without reply text', () => {
    expect(isReasoningOnly(thought('a', 'pondering'))).toBe(true);
    expect(isReasoningOnly({ ...thought('b', 'x'), content: 'done' })).toBe(false);
    expect(isReasoningOnly({ id: 'c', role: 'assistant', content: '' })).toBe(false);
    expect(isReasoningOnly({ id: 'd', role: 'tool', content: 'read_file' })).toBe(false);
  });
});

describe('top-level thinking blocks', () => {
  it('renders each reasoning block independently and keeps short preview blocks open', () => {
    render([thought('first', 'check the file'), thought('second', 'run the tests', { reasoningMs: 2_000 })]);

    expect(container.querySelectorAll('.thinking-block')).toHaveLength(2);
    expect(container.querySelectorAll('.thinking-block-title')[1]?.textContent).toContain(
      '◔ Thinking · 2.0 s',
    );
    expect(container.querySelectorAll('.folded-content-body')).toHaveLength(2);
    expect(container.textContent).toContain('check the file');
    expect(container.textContent).toContain('run the tests');
    expect(container.querySelector('.folded-content-toggle')).toBeNull();
  });

  it('streams fully open text with a pulsing label and a collapse link', () => {
    const live = thought('live', 'first live line', { reasoningStartedAt: 1_000 });
    render([live], 'preview', true);

    expect(container.querySelector('.folded-content-body')?.textContent).toBe('first live line');
    expect(container.querySelector('.thinking-pulse')).not.toBeNull();
    expect(container.querySelector('.thinking-block-title')?.textContent).toContain('Thinking…');
    expect(container.querySelector('.folded-content-toggle')).toBeNull();
    expect(container.querySelector('.thinking-block-collapse')?.textContent).toBe('Collapse');
    expect(container.textContent).not.toContain('Stop');

    render([{ ...live, reasoning: 'first live line\nnew live line' }], 'preview', true);
    expect(container.querySelector('.folded-content-body')?.textContent).toContain('new live line');

    render([{ ...live, reasoning: 'first live line\nnew live line', reasoningMs: 3_000 }], 'preview', true);
    expect(container.querySelector('.thinking-pulse')).toBeNull();
    expect(container.querySelector('.thinking-block-title')?.textContent).toContain('Thinking · 3.0 s');
  });

  it('folds long finished preview blocks to their tail with show all and show less', () => {
    const body = Array.from({ length: 7 }, (_, index) => `line ${index + 1}`).join('\n');
    render([thought('long', body, { reasoningMs: 3_200 })]);

    const preview = container.querySelector('.folded-content-body')!;
    expect(preview.classList.contains('is-tail-preview')).toBe(true);
    expect(preview.textContent).toContain('line 4');
    expect(preview.textContent).toContain('line 7');
    expect(preview.textContent).not.toContain('line 3');
    const toggle = container.querySelector<HTMLButtonElement>('.folded-content-toggle')!;
    expect(toggle.textContent).toBe('Show all');

    act(() => toggle.click());
    expect(container.querySelector('.folded-content-body')?.textContent).toBe(body);
    expect(container.querySelector('.folded-content-toggle')?.textContent).toBe('Show less');
    act(() => container.querySelector<HTMLButtonElement>('.folded-content-toggle')!.click());
    expect(container.querySelector('.folded-content-body')?.textContent).not.toContain('line 3');
  });

  it('keeps show-all and collapse choices across content updates and chat changes', () => {
    const lines = Array.from({ length: 7 }, (_, index) => `saved ${index + 1}`).join('\n');
    render([thought('saved', lines)]);
    act(() => container.querySelector<HTMLButtonElement>('.folded-content-toggle')!.click());

    const updated = `${lines}\nnew line`;
    render([thought('other', 'other chat')]);
    render([thought('saved', updated)]);
    expect(container.querySelector('.folded-content-body')?.textContent).toBe(updated);

    act(() => container.querySelector<HTMLButtonElement>('.thinking-block-collapse')!.click());
    render([thought('saved', `${updated}\nnewer line`)]);
    expect(container.querySelector('.folded-content-body')).toBeNull();
    expect(container.querySelector('.thinking-block-collapse')?.textContent).toBe('Expand');
  });

  it('supports preview, open, and collapsed setting values', () => {
    const lines = Array.from({ length: 7 }, (_, index) => `setting ${index + 1}`).join('\n');
    render([thought('preview', lines)], 'preview');
    expect(container.querySelector('.folded-content-body')?.textContent).not.toContain('setting 1');

    render([thought('open', lines)], 'open');
    expect(container.querySelector('.folded-content-body')?.textContent).toBe(lines);
    expect(container.querySelector('.folded-content-toggle')).toBeNull();

    render([thought('collapsed', lines)], 'collapsed');
    expect(container.querySelector('.folded-content-body')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('.thinking-block-collapse')!.click());
    expect(container.querySelector('.folded-content-body')?.textContent).toBe(lines);
  });
});
