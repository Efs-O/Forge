import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageList } from '../../webview-ui/src/components/MessageList';
import type { AppMessage } from '../../webview-ui/src/messageOps';

declare global {
  interface Window {
    setTranscriptMessage(id: string, content: string): void;
    resetTranscript(count: number): void;
  }
}

function initialMessages(count = 100): AppMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `history-${index}`,
    role: 'assistant' as const,
    content: `Historical reply ${index}: this answer contains a sentence that wraps in the transcript and gives the long conversation enough content to scroll.`,
  }));
}

function Fixture(): React.ReactElement {
  const [messages, setMessages] = useState(() => initialMessages());
  window.resetTranscript = (count) => setMessages(initialMessages(count));
  window.setTranscriptMessage = (id, content) => {
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, content } : message)),
    );
  };

  return (
    <div id="forge-root">
      <MessageList
        messages={messages}
        queuedPrompts={[]}
        onCancelQueuedPrompt={() => undefined}
        onSendQueuedPromptNow={() => undefined}
        streaming
        conversationId="browser-scroll-regression"
        active
        activityView="full"
        thinkingDisplay="preview"
      />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('browser fixture root was not found');
createRoot(root).render(<Fixture />);
