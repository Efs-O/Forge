// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useConversationDrafts } from '../../webview-ui/src/components/useConversationDrafts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('recovers a user prompt into its own tab while preserving both drafts', () => {
  const div = document.createElement('div');
  const root = createRoot(div);
  const openIds = new Set(['target', 'visible']);
  const report = vi.fn();
  const prune = vi.fn();
  let draft!: ReturnType<typeof useConversationDrafts>;
  function Composer({ id }: { id: string }): React.ReactElement {
    draft = useConversationDrafts({
      activeConversationId: id,
      retentionReady: true,
      openConversationIds: openIds,
      onDraftBearingConversationIds: report,
      attachmentDraftIds: [],
      pruneAttachments: prune,
    });
    return React.createElement('span', null, draft.text);
  }
  const show = (id: string) => act(() => root.render(React.createElement(Composer, { id })));
  try {
    show('target');
    act(() => draft.setText('target draft'));
    show('visible');
    act(() => draft.setText('visible draft'));
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'setInput', conversationId: 'target', text: 'genuine failed user prompt' },
        }),
      ),
    );
    expect(div.textContent).toBe('visible draft');
    show('target');
    expect(div.textContent).toBe('target draft\n\ngenuine failed user prompt');
    act(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'setInput', conversationId: 'target', text: 'genuine failed user prompt' },
        }),
      ),
    );
    expect(div.textContent).toBe('target draft\n\ngenuine failed user prompt');
    show('visible');
    expect(div.textContent).toBe('visible draft');
  } finally {
    act(() => root.unmount());
  }
});
