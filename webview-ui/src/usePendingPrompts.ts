import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentData, SessionSyncMsg } from '../../src/sidebar/messageBridge';
import type { Action } from './reducer';
import { attachmentBytes } from './components/useAttachments';
import type { MessageAttachment } from './messageOps';
import { vscode } from './vscode';

export interface QueuedPrompt {
  id: string;
  conversationId: string;
  text: string;
  attachments: AttachmentData[];
  tell?: boolean;
}

interface UsePendingPromptsOptions {
  dispatch: React.Dispatch<Action>;
  activeConversationId: string;
  streamingIds: ReadonlySet<string>;
  clearResumed: (conversationId: string) => void;
}

export interface PendingPrompts {
  queuedPrompts: QueuedPrompt[];
  handleSend: (text: string, attachments: AttachmentData[]) => void;
  cancelQueuedPrompt: (id: string) => void;
  clearTellPrompts: (conversationId?: string) => void;
  reconcileSessionSync: (messagesById: SessionSyncMsg['messagesById']) => void;
}

/** Owns the local queue and the inbox-backed text tells shown by the sidebar. */
export function usePendingPrompts({
  dispatch,
  activeConversationId,
  streamingIds,
  clearResumed,
}: UsePendingPromptsOptions): PendingPrompts {
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;

  const postPrompt = useCallback(
    (prompt: QueuedPrompt) => {
      if (!prompt.tell) {
        // The bytes are in hand right now, so the thumbnail appears with the
        // bubble rather than after the host has written the file and synced back.
        const attachments: MessageAttachment[] = prompt.attachments.map((attachment) => ({
          name: attachment.name,
          mediaType: attachment.mediaType,
          bytes: attachmentBytes(attachment),
          src: `data:${attachment.mediaType};base64,${attachment.data}`,
        }));
        dispatch({
          type: 'USER_SEND',
          text: prompt.text,
          convId: prompt.conversationId,
          attachments,
        });
      }
      vscode.postMessage({
        type: 'send',
        text: prompt.text,
        attachments: prompt.attachments.length ? prompt.attachments : undefined,
        conversationId: prompt.conversationId,
        ...(prompt.tell ? { tellId: prompt.id } : {}),
      });
    },
    [dispatch],
  );

  const handleSend = useCallback(
    (text: string, attachments: AttachmentData[]) => {
      const prompt = { conversationId: activeConversationId, text, attachments };
      clearResumed(prompt.conversationId);
      if (streamingIds.has(prompt.conversationId)) {
        const pending: QueuedPrompt = {
          ...prompt,
          id: crypto.randomUUID(),
          ...(attachments.length === 0 ? { tell: true } : {}),
        };
        setQueuedPrompts((current) => [...current, pending]);
        if (attachments.length === 0) postPrompt(pending);
        return;
      }
      postPrompt({ ...prompt, id: crypto.randomUUID() });
    },
    [activeConversationId, clearResumed, postPrompt, streamingIds],
  );

  // Flush attachment prompts as soon as their conversation releases the turn.
  useEffect(() => {
    const nextIndex = queuedPrompts.findIndex(
      (prompt) => !prompt.tell && !streamingIds.has(prompt.conversationId),
    );
    if (nextIndex < 0) return;
    const next = queuedPrompts[nextIndex];
    if (!next) return;
    setQueuedPrompts((current) => current.filter((prompt) => prompt.id !== next.id));
    postPrompt(next);
  }, [postPrompt, queuedPrompts, streamingIds]);

  const cancelQueuedPrompt = useCallback(
    (id: string) => {
      const prompt = queuedPrompts.find((candidate) => candidate.id === id);
      // A tell already sits in the host inbox; withdraw it there too. If the
      // turn has read it, the host says so and the bubble stays.
      if (prompt?.tell) {
        vscode.postMessage({
          type: 'cancelTell',
          conversationId: prompt.conversationId,
          tellId: prompt.id,
        });
      }
      setQueuedPrompts((current) => current.filter((candidate) => candidate.id !== id));
    },
    [queuedPrompts],
  );

  const clearTellPrompts = useCallback((conversationId?: string) => {
    const targetId = conversationId ?? activeConversationIdRef.current;
    setQueuedPrompts((current) =>
      current.filter((prompt) => !prompt.tell || prompt.conversationId !== targetId),
    );
  }, []);

  const reconcileSessionSync = useCallback((messagesById: SessionSyncMsg['messagesById']) => {
    setQueuedPrompts((current) =>
      current.filter(
        (prompt) =>
          !prompt.tell ||
          !messagesById[prompt.conversationId]?.some(
            (row) => row.role === 'user' && row.midTurn && row.content === prompt.text,
          ),
      ),
    );
  }, []);

  return {
    queuedPrompts,
    handleSend,
    cancelQueuedPrompt,
    clearTellPrompts,
    reconcileSessionSync,
  };
}
