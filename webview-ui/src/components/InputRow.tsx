import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { SlashCommand } from '../slashCommands';
import type { AttachmentData } from '../../../src/sidebar/messageBridge';

interface Props {
  onSend: (text: string, attachments: AttachmentData[]) => void;
  onCancel: () => void;
  streaming: boolean;
  backendReady: boolean;
  slashCommands: SlashCommand[];
  onRunSlashCommand: (commandId: SlashCommand['id']) => void;
  prefillText: string | null;
  onPrefillConsumed: () => void;
}

const SendIcon = (): React.ReactElement => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M15.854.146a.5.5 0 0 1 .11.54l-5.819 14.547a.75.75 0 0 1-1.329.124l-3.178-4.995L.643 7.184a.75.75 0 0 1 .124-1.33L15.314.037a.5.5 0 0 1 .54.11z" />
  </svg>
);

const StopIcon = (): React.ReactElement => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="currentColor" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" rx="1.5" />
  </svg>
);

const PaperclipIcon = (): React.ReactElement => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M4.5 3a2.5 2.5 0 0 1 5 0v9a1.5 1.5 0 0 1-3 0V5a.5.5 0 0 1 1 0v7a.5.5 0 0 0 1 0V3a1.5 1.5 0 1 0-3 0v9a2.5 2.5 0 0 0 5 0V5a.5.5 0 0 1 1 0v7a3.5 3.5 0 1 1-7 0z" />
  </svg>
);

export function InputRow({
  onSend,
  onCancel,
  streaming,
  backendReady,
  slashCommands,
  onRunSlashCommand,
  prefillText,
  onPrefillConsumed,
}: Props): React.ReactElement {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentData[]>([]);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const slashQuery = text.startsWith('/') ? text.slice(1).trim().toLowerCase() : '';
  const slashMatches = !text.startsWith('/')
    ? []
    : !slashQuery
      ? slashCommands
      : slashCommands.filter((cmd) =>
          cmd.trigger.includes(slashQuery) || cmd.title.toLowerCase().includes(slashQuery),
        );
  const showSlashMenu = !streaming && slashMatches.length > 0 && text.startsWith('/');

  useEffect(() => { setSelectedCommandIndex(0); }, [text]);

  useEffect(() => {
    if (prefillText === null) return;
    setText(prefillText);
    onPrefillConsumed();
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [onPrefillConsumed, prefillText]);

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || streaming) return;
    onSend(trimmed, attachments);
    setText('');
    setAttachments([]);
    textareaRef.current?.focus();
  }, [text, attachments, streaming, onSend]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    files.forEach((file) => {
      const reader = new FileReader();
      const isImage = file.type.startsWith('image/');
      reader.onload = () => {
        const raw = reader.result as string;
        setAttachments((prev) => [
          ...prev,
          {
            name: file.name,
            mediaType: file.type || 'application/octet-stream',
            data: isImage ? raw.split(',')[1] : raw,
          },
        ]);
      };
      if (isImage) reader.readAsDataURL(file);
      else reader.readAsText(file);
    });
    e.target.value = '';
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const runSlashCommand = useCallback((command: SlashCommand) => {
    if (streaming) return;
    onRunSlashCommand(command.id);
    setText('');
    setSelectedCommandIndex(0);
    textareaRef.current?.focus();
  }, [onRunSlashCommand, streaming]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedCommandIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedCommandIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        runSlashCommand(slashMatches[selectedCommandIndex] ?? slashMatches[0]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setText('');
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }, [runSlashCommand, selectedCommandIndex, showSlashMenu, slashMatches, submit]);

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !streaming;
  const placeholder = backendReady
    ? 'Ask anything… (Shift+Enter for newline)'
    : 'Ask anything… first send starts the backend';

  return (
    <div id="input-row">
      {showSlashMenu && (
        <div id="slash-menu" role="listbox" aria-label="Slash commands">
          {slashMatches.map((cmd, index) => (
            <button
              key={`${cmd.id}-${cmd.trigger}`}
              type="button"
              className={`slash-item${index === selectedCommandIndex ? ' selected' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runSlashCommand(cmd)}
            >
              <span className="slash-trigger">/{cmd.trigger}</span>
              <span className="slash-title">{cmd.title}</span>
              <span className="slash-description">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div id="attachment-chips">
          {attachments.map((a, i) => (
            <span key={i} className="attachment-chip">
              {a.mediaType.startsWith('image/') && (
                <img
                  className="attachment-thumb"
                  src={`data:${a.mediaType};base64,${a.data}`}
                  alt={a.name}
                />
              )}
              <span className="attachment-name">{a.name}</span>
              <button
                type="button"
                className="attachment-remove"
                onClick={() => removeAttachment(i)}
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div id="prompt-area">
        {!streaming && (
          <button
            id="attach-btn"
            type="button"
            title="Attach image or file"
            aria-label="Attach file"
            onClick={() => fileInputRef.current?.click()}
          >
            <PaperclipIcon />
          </button>
        )}

        <textarea
          ref={textareaRef}
          id="prompt"
          value={text}
          placeholder={placeholder}
          disabled={streaming}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
        />

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.ts,.tsx,.js,.jsx,.py,.md,.txt,.json,.yaml,.yml,.toml,.css,.html,.sh,.rs,.go,.java,.c,.cpp,.h"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        <div id="input-btn-col">
          {streaming ? (
            <button id="btn-stop" type="button" onClick={onCancel}>
              <StopIcon />
              Stop
            </button>
          ) : (
            <button
              id="btn-send"
              type="button"
              onClick={submit}
              disabled={!canSend}
            >
              <SendIcon />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
