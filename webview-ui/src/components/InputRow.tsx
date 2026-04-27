import React, { useState, useCallback, useRef, useEffect } from 'react';
import { vscode } from '../vscode';

interface Props {
  onSend: (text: string) => void;
  onCancel: () => void;
  streaming: boolean;
  backendReady: boolean;
  /** When this prop changes to a non-empty string the textarea is prefilled. */
  prefillText?: string;
  /** Called after prefill has been consumed so the parent can reset to ''. */
  onPrefillConsumed?: () => void;
}

export function InputRow({
  onSend,
  onCancel,
  streaming,
  backendReady,
  prefillText = '',
  onPrefillConsumed,
}: Props): React.ReactElement {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Inject prefill text whenever the prop changes to something non-empty.
  useEffect(() => {
    if (prefillText) {
      setText(prefillText);
      textareaRef.current?.focus();
      onPrefillConsumed?.();
    }
  }, [prefillText, onPrefillConsumed]);

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

  const handleUseSelection = useCallback(() => {
    vscode.postMessage({ type: 'sendSelection' });
  }, []);

  const selDisabled = streaming || !backendReady;

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
      <div id="input-btn-col">
        {streaming ? (
          <button onClick={onCancel}>Cancel</button>
        ) : (
          <button onClick={submit} disabled={!backendReady || !text.trim()}>
            Send
          </button>
        )}
        <button
          id="sel-btn"
          title="Prefill with active editor selection"
          disabled={selDisabled}
          onClick={handleUseSelection}
        >
          ⊕ Sel
        </button>
      </div>
    </div>
  );
}
