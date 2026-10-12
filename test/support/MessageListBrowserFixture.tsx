import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MessageList } from '../../webview-ui/src/components/MessageList';
import type { AppMessage } from '../../webview-ui/src/messageOps';

declare global {
  interface Window {
    setTranscriptMessage(id: string, content: string): void;
  }
}

function initialMessages(): AppMessage[] {
  return Array.from({ length: 100 }, (_, index) => ({
    id: `history-${index}`,
    role: 'assistant' as const,
    content: `Historical reply ${index}: this answer contains a sentence that wraps in the transcript and gives the long conversation enough content to scroll.`,
  }));
}

function Fixture(): React.ReactElement {
  const [messages, setMessages] = useState(initialMessages);
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
        streaming
        conversationId="browser-scroll-regression"
        active
        activityView="full"
      />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('browser fixture root was not found');
createRoot(root).render(<Fixture />);
