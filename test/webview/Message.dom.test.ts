// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

(globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } })
  .acquireVsCodeApi = () => ({ postMessage: () => undefined });

const { Message } = await import('../../webview-ui/src/components/Message');
const React = await import('react');

let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  writeText.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Message code blocks', () => {
  it('renders a copy button inside each fenced code block', () => {
    act(() => {
      root.render(
        React.createElement(Message, {
          role: 'assistant',
          content: 'Before\n\n```powershell\nGet-ChildItem\n```\n\nAfter',
        }),
      );
    });

    const codeBlock = container.querySelector('.forge-code-block');
    expect(codeBlock).not.toBeNull();
    expect(codeBlock?.querySelector('.forge-code-copy')).not.toBeNull();
    expect(codeBlock?.querySelector('code')?.textContent).toBe('Get-ChildItem\n');
  });

  it('copies only the code content and shows the copied state', async () => {
    act(() => {
      root.render(
        React.createElement(Message, {
          role: 'assistant',
          content: '```js\nconst answer = 42;\n```',
        }),
      );
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.forge-code-copy')!.click();
    });

    expect(writeText).toHaveBeenCalledWith('const answer = 42;\n');
    expect(container.querySelector('.forge-code-copy')?.getAttribute('aria-label')).toBe('Copied');
  });
});
