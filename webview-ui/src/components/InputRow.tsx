import React, { useState, useCallback, useRef } from 'react';

interface Props {
  onSend: (text: string) => void;
  onCancel: () => void;
  streaming: boolean;
  backendReady: boolean;
}

export function InputRow({ onSend, onCancel, streaming, backendReady }: Props): React.ReactElement {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    onSend(trimmed);
    setText('');
    textareaRef.current?.focus();
  }, [text, streaming, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }, [submit]);

  return (
    <div id="input-row">
      <textarea
        ref={textareaRef}
        id="prompt"
        value={text}
        placeholder={backendReady ? 'Ask anything… (Shift+Enter for newline)' : 'Backend starting…'}
        disabled={!backendReady || streaming}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {streaming ? (
        <button onClick={onCancel}>Cancel</button>
      ) : (
        <button onClick={submit} disabled={!backendReady || !text.trim()}>
          Send
        </button>
      )}
    </div>
  );
}
