import { useCallback, useState } from 'react';
import type { AttachmentData } from '../../../src/sidebar/messageBridge';
import {
  attachmentKind,
  attachmentLimitBytes,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from '../../../src/sidebar/attachmentLimits';

export interface AttachmentsApi {
  attachments: AttachmentData[];
  /** Bytes already staged, measured the same way the host measures them. */
  totalBytes: number;
  /** Per-file rejection reasons from the last add; empty once dismissed. */
  errors: string[];
  addFiles: (files: File[]) => void;
  remove: (index: number) => void;
  clear: () => void;
  dismissErrors: () => void;
}

/**
 * Size of a staged attachment in the encoding it is held in: images keep raw
 * base64 (4 chars per 3 bytes, minus padding), text keeps its decoded string.
 */
export function attachmentBytes(item: AttachmentData): number {
  if (item.mediaType.startsWith('image/')) {
    const padding = item.data.endsWith('==') ? 2 : item.data.endsWith('=') ? 1 : 0;
    return Math.floor((item.data.length * 3) / 4) - padding;
  }
  return new Blob([item.data]).size;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MiB`;
}

function readFile(file: File, kind: 'image' | 'text'): Promise<AttachmentData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} could not be read.`));
    reader.onload = () => {
      const raw = reader.result as string;
      resolve({
        name: file.name,
        mediaType: file.type || 'application/octet-stream',
        data: kind === 'image' ? (raw.split(',')[1] ?? '') : raw,
      });
    };
    if (kind === 'image') reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

/**
 * Staged attachments for the composer, keyed by conversation so switching tabs
 * does not hand one chat's files to another.
 *
 * Rejections are per-file and non-blocking: a batch that is partly over budget
 * stages what fits and reports the rest, rather than dropping everything. That
 * matters most for drag-and-drop, where the user cannot see a file's size
 * before letting go.
 */
export function useAttachments(activeConversationId: string): AttachmentsApi {
  const [byConversation, setByConversation] = useState<Record<string, AttachmentData[]>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const attachments = byConversation[activeConversationId] ?? [];

  const update = useCallback(
    (fn: (previous: AttachmentData[]) => AttachmentData[]) => {
      setByConversation((previous) => ({
        ...previous,
        [activeConversationId]: fn(previous[activeConversationId] ?? []),
      }));
    },
    [activeConversationId],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      setErrors([]);
      void (async () => {
        const rejected: string[] = [];
        const accepted: AttachmentData[] = [];
        // Budget is tracked against a local running total: the state updates
        // below are batched, so re-reading `attachments` per file would let a
        // multi-file drop sail past the cap.
        let count = attachments.length;
        let bytes = attachments.reduce((sum, item) => sum + attachmentBytes(item), 0);

        for (const file of files) {
          const kind = attachmentKind(file.name, file.type);
          const limit = attachmentLimitBytes({ name: file.name, mediaType: file.type });
          if (!kind || !limit) {
            rejected.push(`${file.name} — not an image or a text/code file.`);
            continue;
          }
          if (file.size > limit) {
            rejected.push(`${file.name} — over the ${mib(limit)} limit for ${kind} files.`);
            continue;
          }
          if (count >= MAX_ATTACHMENTS_PER_PROMPT) {
            rejected.push(`${file.name} — only ${MAX_ATTACHMENTS_PER_PROMPT} files per message.`);
            continue;
          }
          if (bytes + file.size > MAX_ATTACHMENT_TOTAL_BYTES) {
            rejected.push(
              `${file.name} — would exceed the ${mib(MAX_ATTACHMENT_TOTAL_BYTES)} total.`,
            );
            continue;
          }
          try {
            accepted.push(await readFile(file, kind));
            count += 1;
            bytes += file.size;
          } catch (error) {
            rejected.push(
              error instanceof Error ? error.message : `${file.name} could not be read.`,
            );
          }
        }

        if (accepted.length) update((previous) => [...previous, ...accepted]);
        if (rejected.length) setErrors(rejected);
      })();
    },
    [attachments, update],
  );

  const remove = useCallback(
    (index: number) => update((prev) => prev.filter((_, i) => i !== index)),
    [update],
  );
  const clear = useCallback(() => update(() => []), [update]);
  const dismissErrors = useCallback(() => setErrors([]), []);

  return {
    attachments,
    totalBytes: attachments.reduce((sum, item) => sum + attachmentBytes(item), 0),
    errors,
    addFiles,
    remove,
    clear,
    dismissErrors,
  };
}
