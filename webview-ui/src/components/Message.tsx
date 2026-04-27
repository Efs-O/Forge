import React, { useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AppMessage } from '../App';
import { vscode } from '../vscode';

export function Message({ role, content }: AppMessage): React.ReactElement {
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).catch(() => {
      // clipboard API may be unavailable in some webview contexts — silently ignore
    });
  }, [content]);

  const handleInsert = useCallback(() => {
    vscode.postMessage({ type: 'insertAtCursor', text: content });
  }, [content]);

  const handleReplace = useCallback(() => {
    vscode.postMessage({ type: 'replaceSelection', text: content });
  }, [content]);

  if (role === 'assistant') {
    return (
      <div className={`msg ${role}`}>
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        <div className="msg-actions">
          <button className="btn-action" title="Copy to clipboard" onClick={handleCopy}>Copy</button>
          <button className="btn-action" title="Insert at cursor" onClick={handleInsert}>Insert</button>
          <button className="btn-action" title="Replace selection" onClick={handleReplace}>Replace</button>
        </div>
      </div>
    );
  }

  return <div className={`msg ${role}`}>{content}</div>;
}
