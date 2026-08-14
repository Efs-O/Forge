import React, { useEffect, useRef } from 'react';
import type { AppMessage } from '../App';
import { Message } from './Message';

interface Props {
  messages: AppMessage[];
  streaming: boolean;
  generating: boolean;
  /** Active conversation/tab id. A change means the user switched sessions, which
   *  must jump to the bottom instantly instead of smooth-scrolling the whole
   *  (different) conversation top-to-bottom. */
  conversationId: string;
}

const SCROLL_THRESHOLD = 80; // px from bottom — within this, auto-scroll is active

export function MessageList({
  messages,
  streaming,
  generating,
  conversationId,
}: Props): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);
  const shownConversation = useRef<string | undefined>(undefined);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      userScrolledUp.current = distFromBottom > SCROLL_THRESHOLD;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    // Session switch: jump straight to the bottom with no animation and reset the
    // "user scrolled up" flag for the freshly shown conversation. Smooth-scrolling
    // here would animate through the entire (different) conversation.
    if (shownConversation.current !== conversationId) {
      shownConversation.current = conversationId;
      userScrolledUp.current = false;
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
      return;
    }
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, conversationId]);

  return (
    <div id="messages" ref={containerRef}>
      {messages.map((msg, index) => (
        <Message
          key={msg.id}
          {...msg}
          streaming={streaming && index === messages.length - 1 && msg.role === 'assistant'}
        />
      ))}
      {generating && messages[messages.length - 1]?.role !== 'assistant' && (
        <div className="forge-thinking-row" aria-label="Forge is thinking">
          <span className="forge-thinking-dot" />
          <span className="forge-thinking-dot" />
          <span className="forge-thinking-dot" />
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
