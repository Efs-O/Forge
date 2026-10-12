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

describe('assistant answer layout', () => {
  const lead = 'Confirmed against git status — my ownership and yours, exactly:';

  it('renders the saved colon lead and bold label as separate paragraphs', () => {
    act(() => {
      root.render(
        React.createElement(Message, {
          role: 'assistant',
          content: `${lead}\n**Mine:**\n- The renderer now separates the lead.`,
        }),
      );
    });

    const paragraphs = container.querySelectorAll('.msg.assistant p');
    expect(paragraphs[0]?.textContent).toBe(lead);
    expect(paragraphs[1]?.querySelector('strong')?.textContent).toBe('Mine:');
    expect(container.querySelector('.msg.assistant ul')?.textContent).toContain(
      'The renderer now separates the lead.',
    );
  });

  it('applies the same colon lead separation while the message is streaming', () => {
    act(() => {
      root.render(
        React.createElement(Message, {
          role: 'assistant',
          streaming: true,
          content: `${lead}\n**Mine:**\n\n- The renderer now separates the lead.`,
        }),
      );
    });

    expect(container.querySelector('.msg.assistant p')?.textContent).toBe(lead);
    expect(container.querySelector('.msg.assistant strong')?.textContent).toBe('Mine:');
    expect(container.querySelector('.streaming-tail')?.textContent).toContain(
      'The renderer now separates the lead.',
    );
  });

  it('keeps ordinary assistant prose and code fences in their usual rendering', () => {
    act(() => {
      root.render(
        React.createElement(Message, {
          role: 'assistant',
          content: 'The fix is ready.\nIt handles saved messages too.\n\n```text\n**Mine:**\n```',
        }),
      );
    });

    expect(container.querySelectorAll('.msg.assistant p')).toHaveLength(1);
    expect(container.querySelector('.msg.assistant p')?.textContent).toBe(
      'The fix is ready.\nIt handles saved messages too.',
    );
    expect(container.querySelector('.forge-code-block code')?.textContent).toBe('**Mine:**\n');
  });

  it('keeps consecutive list items in one Markdown list', () => {
    act(() => {
      root.render(
        React.createElement(Message, {
          role: 'assistant',
          content: '- First item.\n- Second item',
        }),
      );
    });

    expect(container.querySelectorAll('.msg.assistant ul')).toHaveLength(1);
    expect(container.querySelectorAll('.msg.assistant li')).toHaveLength(2);
  });
});
