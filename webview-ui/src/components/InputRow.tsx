import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { SlashCommand } from '../slashCommands';
import type { AttachmentData, ModelEntry } from '../../../src/sidebar/messageBridge';
import { ModelSelector } from './ModelSelector';
import { webviewDiagnostics } from '../WebviewDiagnostics';
import { ATTACHMENT_ACCEPT } from '../../../src/sidebar/attachmentLimits';
import { AttachmentTray } from './AttachmentTray';
import { useAttachments } from './useAttachments';

interface Props {
  onSend: (text: string, attachments: AttachmentData[]) => void;
  onCancel: () => void;
  streaming: boolean;
  backendReady: boolean;
  slashCommands: SlashCommand[];
  onRunSlashCommand: (commandId: SlashCommand['id']) => void;
  prefillText: string | null;
  onPrefillConsumed: () => void;
  clankerMode: boolean;
  models: ModelEntry[];
  activeModel: string | null;
  onModelChange: (name: string | null) => void;
  modelPickerDisabled: boolean;
  /** Whether anything outside this window can drive it. */
  remote: { transports: string[]; paired: boolean };
  activeConversationId: string;
}

/** A drag of selected text or a VS Code editor tab must not arm the drop target. */
function carriesFiles(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

const UNAVAILABLE_WHILE_STREAMING = 'Unavailable while the agent is generating.';

/**
 * Move the highlight to the next command that can actually be run, wrapping in
 * `direction`. Returns `from` when nothing in the list is runnable, so the
 * caller never lands on an index that Enter would ignore.
 */
function step(
  commands: SlashCommand[],
  runnable: (cmd: SlashCommand) => boolean,
  from: number,
  direction: 1 | -1,
): number {
  const count = commands.length;
  for (let hop = 1; hop <= count; hop++) {
    const next = (from + direction * hop + count * count) % count;
    if (runnable(commands[next]!)) return next;
  }
  return from;
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

/**
 * Whether anything outside this window can reach it.
 *
 * Three states, not two. A transport that is running with nobody paired is up
 * and answering `/pair`, but cannot be driven - saying "active" there would
 * claim someone can reach this window when the pairing gate says otherwise. It
 * reports Forge's own view and is not a health check: a revoked token or a
 * dropped session still reads as running until a send fails.
 */
function RemoteChip({
  transports,
  paired,
}: {
  transports: string[];
  paired: boolean;
}): React.ReactElement | null {
  if (transports.length === 0) return null;
  const via = transports.join(' · ');
  const label = paired ? 'Remote active' : 'Remote waiting';
  const title = paired
    ? `Remote control is paired on ${via}. Messages from there drive this window.`
    : `${via} is running but no owner is paired. Run “Forge: Pair Remote Device” to bind one.`;
  return (
    <span
      id="remote-chip"
      className={paired ? 'is-paired' : 'is-unpaired'}
      title={title}
      role="status"
    >
      <span className="remote-chip-dot" aria-hidden="true" />
      <span className="remote-chip-label">{label}</span>
    </span>
  );
}

export function InputRow({
  onSend,
  onCancel,
  streaming,
  backendReady,
  slashCommands,
  onRunSlashCommand,
  prefillText,
  onPrefillConsumed,
  clankerMode,
  models,
  activeModel,
  onModelChange,
  modelPickerDisabled,
  remote,
  activeConversationId,
}: Props): React.ReactElement {
  const [text, setText] = useState('');
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave fire for every child element the pointer crosses, so a
  // boolean alone flickers the overlay off mid-drag. Depth counts them.
  const dragDepth = useRef(0);
  const files = useAttachments(activeConversationId);
  const { attachments, addFiles, clear: clearAttachments } = files;

  const slashQuery = text.startsWith('/') ? text.slice(1).trim().toLowerCase() : '';
  const slashMatches = !text.startsWith('/')
    ? []
    : !slashQuery
      ? slashCommands
      : slashCommands.filter(
          (cmd) => cmd.trigger.includes(slashQuery) || cmd.title.toLowerCase().includes(slashQuery),
        );
  // Streaming-unsafe commands stay LISTED and are disabled instead of being
  // filtered out. Hiding them left a menu holding a single entry, which reads
  // as a broken menu rather than as a deliberate restriction — and gave no hint
  // that the command exists at all or why it is unavailable right now.
  const runnable = (cmd: SlashCommand): boolean =>
    !streaming || cmd.availableWhileStreaming === true;
  const showSlashMenu = slashMatches.length > 0 && text.startsWith('/');
  const firstRunnableIndex = slashMatches.findIndex(runnable);
  // Keyboard selection must never rest on a disabled row: Enter would silently
  // do nothing.
  const selected = slashMatches[selectedCommandIndex];
  const activeIndex = selected && runnable(selected) ? selectedCommandIndex : firstRunnableIndex;

  useEffect(() => {
    if (prefillText === null) return;
    setText(prefillText);
    onPrefillConsumed();
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [onPrefillConsumed, prefillText]);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      webviewDiagnostics.recordInputChange(e.target.value.length);
      setText(e.target.value);
      if (selectedCommandIndex !== 0) setSelectedCommandIndex(0);
    },
    [selectedCommandIndex],
  );

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments);
    setText('');
    clearAttachments();
    textareaRef.current?.focus();
  }, [text, attachments, clearAttachments, streaming, onSend]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(e.target.files ?? []));
      // Reset so re-picking the same file still fires a change event.
      e.target.value = '';
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const pasted = Array.from(e.clipboardData?.files ?? []);
      if (!pasted.length) return;
      // Only swallow the event when files came with it — a paste carrying both
      // text and files (some editors) still needs its text to land.
      if (!e.clipboardData.getData('text')) e.preventDefault();
      addFiles(pasted);
    },
    [addFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!carriesFiles(e)) return;
    dragDepth.current += 1;
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!carriesFiles(e)) return;
    // Without both of these the webview navigates away to the dropped file.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (!dropped.length) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(dropped);
    },
    [addFiles],
  );

  const runSlashCommand = useCallback(
    (command: SlashCommand) => {
      if (streaming && !command.availableWhileStreaming) return;
      onRunSlashCommand(command.id);
      setText('');
      setSelectedCommandIndex(0);
      textareaRef.current?.focus();
    },
    [onRunSlashCommand, streaming],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSlashMenu) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedCommandIndex((i) => step(slashMatches, runnable, i, 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedCommandIndex((i) => step(slashMatches, runnable, i, -1));
          return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
          e.preventDefault();
          const picked = slashMatches[activeIndex];
          if (picked) runSlashCommand(picked);
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
    },
    [activeIndex, runSlashCommand, runnable, slashMatches, showSlashMenu, submit],
  );

  const canSend = text.trim().length > 0 || attachments.length > 0;
  // The key hints moved to #composer-hint below the field, so the placeholder
  // stops repeating them - it is the widest text in the panel and was spending
  // that width on a shortcut the hint row now states permanently.
  const placeholder = backendReady
    ? 'Ask, or / for commands…'
    : 'Ask anything… first send starts the backend';

  return (
    <div
      id="input-row"
      className={dragging ? 'dropping' : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragging && (
        <div id="drop-overlay" aria-hidden="true">
          <span>Drop files to attach</span>
        </div>
      )}

      {showSlashMenu && (
        <div id="slash-menu" role="listbox" aria-label="Slash commands">
          {slashMatches.map((cmd, index) => {
            const enabled = runnable(cmd);
            return (
              <button
                key={`${cmd.id}-${cmd.trigger}`}
                type="button"
                disabled={!enabled}
                title={enabled ? cmd.description : UNAVAILABLE_WHILE_STREAMING}
                className={`slash-item${index === activeIndex ? ' selected' : ''}${
                  enabled ? '' : ' disabled'
                }`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => runSlashCommand(cmd)}
              >
                <span className="slash-trigger">/{cmd.trigger}</span>
                <span className="slash-title">{cmd.title}</span>
                <span className="slash-description">
                  {enabled ? cmd.description : UNAVAILABLE_WHILE_STREAMING}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <AttachmentTray
        attachments={attachments}
        totalBytes={files.totalBytes}
        errors={files.errors}
        onRemove={files.remove}
        onClear={clearAttachments}
        onDismissErrors={files.dismissErrors}
      />

      <div id="prompt-area">
        {/* The paperclip sits inside the field's own box rather than in the
            action row: attaching is something you do *to* the message being
            composed, and the row below is for what happens to it afterwards.
            The field reserves the corner with its bottom padding, so a full
            prompt scrolls above the button instead of under it. */}
        <div id="prompt-shell">
          <textarea
            ref={textareaRef}
            id="prompt"
            className={clankerMode ? 'clanker-armed' : undefined}
            value={text}
            placeholder={placeholder}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={5}
          />
          <button
            id="attach-btn"
            type="button"
            title="Attach files — or drop them here, or paste a screenshot. Images up to 10 MiB, text and code up to 2 MiB, 10 files / 25 MiB per message."
            aria-label="Attach files"
            onClick={() => fileInputRef.current?.click()}
          >
            <PaperclipIcon />
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept={ATTACHMENT_ACCEPT}
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />

        {/* Three columns rather than a flex spacer: `1fr auto 1fr` keeps the
            model at the row's true centre no matter how wide the left chip
            gets, where a spacer would shove it off-axis the moment the chip
            appeared. The side cells collapse to nothing when empty. */}
        <div id="input-actions">
          <span className="input-actions-left">
            <RemoteChip transports={remote.transports} paired={remote.paired} />
          </span>

          <ModelSelector
            models={models}
            activeModel={activeModel}
            onModelChange={onModelChange}
            disabled={modelPickerDisabled}
          />

          <span className="input-actions-right">
            {streaming ? (
              // The labels are wrapped so the narrow-panel rule can drop the
              // word and keep the glyph. A bare text node cannot be targeted.
              <button id="btn-stop" type="button" onClick={onCancel} title="Stop">
                <StopIcon />
                <span>Stop</span>
              </button>
            ) : (
              <button id="btn-send" type="button" onClick={submit} disabled={!canSend} title="Send">
                <SendIcon />
                <span>Send</span>
              </button>
            )}
          </span>
        </div>

        {/* One line carries both facts, and only one can apply at a time: armed
            is the louder of the two and wins the row. Enter's behaviour is
            stated rather than built into a second button - the queue confirms
            itself in the transcript, as a QueuedPromptRow. */}
        <p id="composer-hint" className={clankerMode ? 'clanker-armed' : undefined}>
          {clankerMode
            ? '⏵⏵ Clanker — no confirmations · /clanker to stop'
            : streaming
              ? 'Enter queues this for the next turn'
              : 'Enter to send · Shift+Enter for a newline'}
        </p>
      </div>
    </div>
  );
}
