import { Buffer } from 'node:buffer';
import type { AttachmentData } from './messageBridge';
import {
  attachmentLimitBytes,
  MAX_ATTACHMENTS_PER_PROMPT,
  MAX_ATTACHMENT_TOTAL_BYTES,
} from './attachmentLimits';

function byteSize(attachment: AttachmentData): number {
  return attachment.mediaType.startsWith('image/')
    ? Buffer.byteLength(attachment.data, 'base64')
    : Buffer.byteLength(attachment.data, 'utf8');
}

/** Reject malformed or oversized webview payloads before they enter a transcript/model request. */
export function validateAttachments(attachments?: AttachmentData[]): string | null {
  if (!attachments?.length) return null;
  if (attachments.length > MAX_ATTACHMENTS_PER_PROMPT) {
    return `Forge: attach at most ${MAX_ATTACHMENTS_PER_PROMPT} files per message.`;
  }
  let total = 0;
  for (const attachment of attachments) {
    const limit = attachmentLimitBytes(attachment);
    if (!limit) {
      return `Forge: ${attachment.name} is unsupported. Attach images or plain-text/code files.`;
    }
    const size = byteSize(attachment);
    if (size > limit) {
      return `Forge: ${attachment.name} exceeds its ${Math.floor(limit / 1024 / 1024)} MiB limit.`;
    }
    total += size;
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) {
    return 'Forge: attachments exceed the 25 MiB total limit for one message.';
  }
  return null;
}
