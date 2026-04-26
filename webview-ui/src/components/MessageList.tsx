import React, { useEffect, useRef } from 'react';
import type { AppMessage } from '../App';
import { Message } from './Message';

interface Props {
  messages: AppMessage[];
}

export function MessageList({ messages }: Props): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div id="messages">
      {messages.map((msg) => (
        <Message key={msg.id} {...msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
