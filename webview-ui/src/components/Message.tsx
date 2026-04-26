import React from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppMessage } from '../App';

export function Message({ role, content }: AppMessage): React.ReactElement {
  if (role === 'assistant') {
    return (
      <div className={`msg ${role}`}>
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    );
  }

  return <div className={`msg ${role}`}>{content}</div>;
}
