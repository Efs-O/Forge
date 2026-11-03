// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ChatHeader } = await import('../../webview-ui/src/components/ChatHeader');
const { Header } = await import('../../webview-ui/src/components/Header');
import type { AgentLinks } from '../../src/agentLinks/chatAgentLinks';
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

function render(onRename?: (title: string) => void, agentLinks?: AgentLinks): void {
  act(() => {
    root.render(
      React.createElement(ChatHeader, {
        title: 'hello man',
        historyExpanded: false,
        onNew: vi.fn(),
        onToggleHistory: vi.fn(),
        onUnlinkAgent: vi.fn(),
        agentLinks,
        onRename,
      }),
    );
  });
}

const title = (): HTMLElement | null => container.querySelector('#chat-header-title');
const input = (): HTMLInputElement | null =>
  container.querySelector<HTMLInputElement>('#chat-header-title-input');

function link(kind: 'claude' | 'codex' | 'copilot', sessionId: string, title: string) {
  return {
    kind,
    sessionId,
    cwd: 'C:/repo',
    title,
    linkedAt: 1,
    lastUsedAt: 1,
    origin: 'forge-created' as const,
  };
}

function edit(value: string, key: string): void {
  act(() => title()!.click());
  act(() => {
    input()!.value = value;
    input()!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('ChatHeader title rename', () => {
  it('renames the chat when the clicked title is edited and Enter pressed', () => {
    const onRename = vi.fn();
    render(onRename);
    edit('Renamed chat', 'Enter');
    expect(onRename).toHaveBeenCalledWith('Renamed chat');
    expect(input()).toBeNull();
  });

  it.each([
    ['Escape', 'discarded'],
    ['Enter', '   '],
    ['Enter', 'hello man'],
  ])('does not rename on %s with %j', (key, value) => {
    const onRename = vi.fn();
    render(onRename);
    edit(value, key);
    expect(onRename).not.toHaveBeenCalled();
    expect(input()).toBeNull();
  });

  it('is plain text when there is no conversation to rename', () => {
    render(undefined);
    expect(title()!.tagName).toBe('SPAN');
    act(() => title()!.click());
    expect(input()).toBeNull();
  });

  it('has no Link button in the toolbar and hides the link strip until a session exists', () => {
    render(undefined);
    expect(container.querySelector('#agent-link-toolbar-btn')).toBeNull();
    expect(container.querySelector('#agent-links-strip')).toBeNull();
  });

  it('shows compact linked state and a direct Unlink action without a duplicated title strip', () => {
    render(undefined, {
      claude: link('claude', '11111111-1111-4111-8111-111111111111', 'Forge · hello man'),
    });
    const group = container.querySelector<HTMLElement>('.agent-link-group')!;
    expect(group.textContent).toContain('Claude');
    expect(group.textContent).toContain('Linked');
    expect(group.textContent).not.toContain('Forge · hello man');
    expect(group.textContent).not.toContain('Last used');
    expect(group.title).toContain('Forge · hello man');
    expect(group.title).toContain('Last used');
    const unlink = container.querySelector<HTMLButtonElement>('.agent-link-group button')!;
    expect(unlink.textContent).toBe('Unlink');
    expect(unlink.getAttribute('aria-label')).toBe('Unlink Claude');
  });

  it('keeps linked agent groups side by side and unlinks only the selected kind', () => {
    const onUnlink = vi.fn();
    act(() => {
      root.render(
        React.createElement(ChatHeader, {
          title: 'hello man',
          historyExpanded: false,
          onNew: vi.fn(),
          onToggleHistory: vi.fn(),
          onUnlinkAgent: onUnlink,
          agentLinks: {
            codex: link('codex', '22222222-2222-4222-8222-222222222222', 'Codex task'),
            claude: link('claude', '11111111-1111-4111-8111-111111111111', 'Claude task'),
          },
        }),
      );
    });
    const groups = Array.from(container.querySelectorAll('.agent-link-group'));
    expect(groups).toHaveLength(2);
    act(() => groups[0]!.querySelector('button')!.click());
    expect(onUnlink).toHaveBeenCalledTimes(1);
    expect(onUnlink).toHaveBeenCalledWith('codex');
  });

  it('uses the actual Forge icon asset and the agreed compact type sizes on the owned header', () => {
    act(() =>
      root.render(
        React.createElement(Header, {
          tokenUsed: 1,
          tokenMax: 32,
          workspace: {
            name: 'Forge',
            path: 'C:/repo',
            extraRoots: 0,
            stale: false,
            forgeIconUri: 'vscode-webview://forge-icon.svg',
          },
        }),
      ),
    );
    const mark = container.querySelector<HTMLElement>('#forge-mark');
    expect(mark?.style.maskImage).toContain('forge-icon.svg');
    expect(mark?.style.webkitMaskImage).toContain('forge-icon.svg');
    expect(container.querySelector('#forge-wordmark')?.textContent).toBe('Forge');
    const css = readFileSync('webview-ui/styles/layout.css', 'utf8');
    expect(css).toContain('width: 24px;');
    expect(css).toContain('font-size: 16px;');
    expect(container.querySelector('#workspace-root-name')?.textContent).toBe('');
    const chatCss = readFileSync('webview-ui/styles/chat-header.css', 'utf8');
    expect(chatCss).toContain('min-height: 36px;');
    expect(chatCss).toContain('font-size: 14px;');
  });
});

describe('Header compaction forecast hint', () => {
  it('shows the threshold tick and explains the next-request forecast in the title', () => {
    act(() =>
      root.render(
        React.createElement(Header, { tokenUsed: 12_000, tokenMax: 32_768, compactAt: 0.85 }),
      ),
    );

    const budget = container.querySelector<HTMLElement>('#token-budget');
    const tick = container.querySelector<HTMLElement>('#token-budget-compact-at');
    expect(tick).not.toBeNull();
    expect(tick?.style.left).toBe('85%');
    expect(budget?.title).toBe(
      `${(12_000).toLocaleString()} / ${(32_768).toLocaleString()} tokens in the last request. ` +
        `Auto-compact runs when the next request is forecast at ≥ ${(27_853).toLocaleString()} ` +
        `(85%) — that forecast includes the newest reply and tool results, so it can fire while this bar reads lower.`,
    );

    act(() => root.render(React.createElement(Header, { tokenUsed: 12_000, tokenMax: 32_768 })));
    expect(container.querySelector('#token-budget-compact-at')).toBeNull();
    expect(container.querySelector<HTMLElement>('#token-budget')?.title).toBe(
      `${(12_000).toLocaleString()} / ${(32_768).toLocaleString()} tokens used`,
    );
  });
});
