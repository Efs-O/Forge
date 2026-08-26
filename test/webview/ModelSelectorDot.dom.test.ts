// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelEntry } from '../../src/sidebar/messageBridge';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ModelSelector } = await import('../../webview-ui/src/components/ModelSelector');
const React = await import('react');

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

function render(models: ModelEntry[], activeModel: string | null = null): void {
  act(() => {
    root.render(
      React.createElement(ModelSelector, {
        models,
        activeModel,
        onModelChange: vi.fn(),
        disabled: false,
      }),
    );
  });
}

const openPanel = (): void => {
  act(() => {
    container
      .querySelector<HTMLButtonElement>('.ms-trigger')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const dotClasses = (): string[] =>
  Array.from(container.querySelectorAll('.ms-dot')).map((el) => el.className);

describe('ModelSelector residency dot', () => {
  it('renders one dot per state in the panel', () => {
    render([
      { name: 'ready-model', provider: 'llama.cpp', residency: 'ready' },
      { name: 'loading-model', provider: 'llama.cpp', residency: 'loading' },
      { name: 'cold-model', provider: 'llama.cpp', residency: 'cold' },
    ]);
    openPanel();

    // The panel sorts entries, so assert the set rather than the input order.
    expect(dotClasses().sort()).toEqual([
      'ms-dot ms-dot--cold',
      'ms-dot ms-dot--loading',
      'ms-dot ms-dot--ready',
    ]);
  });

  it('renders no dot for a model the host gave no residency', () => {
    // Remote routes hold no VRAM here; absence is the honest rendering.
    render([{ name: 'grok-4', provider: 'xai' }]);
    openPanel();

    expect(dotClasses()).toEqual([]);
  });

  it('shows the active model dot on the closed trigger', () => {
    render(
      [{ name: 'ready-model', provider: 'llama.cpp', residency: 'ready' }],
      'ready-model',
    );

    expect(container.querySelector('.ms-trigger .ms-dot')?.className).toBe(
      'ms-dot ms-dot--ready',
    );
  });

  it('gives every dot a text label rather than relying on colour', () => {
    render([{ name: 'cold-model', provider: 'llama.cpp', residency: 'cold' }], 'cold-model');

    const dot = container.querySelector<HTMLElement>('.ms-trigger .ms-dot')!;
    expect(dot.getAttribute('aria-label')).toMatch(/not loaded/i);
    expect(dot.title).toMatch(/loads this model first/i);
  });

  it('shows no dot when nothing is selected', () => {
    render([{ name: 'ready-model', provider: 'llama.cpp', residency: 'ready' }], null);

    expect(container.querySelector('.ms-trigger .ms-dot')).toBeNull();
  });
});
