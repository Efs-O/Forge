import React, { useEffect, useRef } from 'react';
import type { AppMessage } from '../App';
import { Message } from './Message';

interface Props {
  messages: AppMessage[];
  streaming: boolean;
  generating: boolean;
}

const SCROLL_THRESHOLD = 80; // px from bottom — within this, auto-scroll is active

export function MessageList({ messages, streaming, generating }: Props): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

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
    if (!userScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

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
