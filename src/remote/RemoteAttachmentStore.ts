import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  attachmentKind,
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS_PER_PROMPT,
} from '../sidebar/attachmentLimits';
import type { AttachmentData } from '../sidebar/messageBridge';
import { mimeFromHeader } from '../tools/imageTool';
import type { RemoteAttachmentReference, RemoteInboundAttachment } from './types';

const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Owns the remote-only sidecar. Project files are never written by this class. */
export class RemoteAttachmentStore {
  constructor(private readonly workspaceRoot: string) {}

  async save(
    conversationId: string,
    requestId: string,
    attachments: RemoteInboundAttachment[],
  ): Promise<RemoteAttachmentReference[]> {
    if (attachments.length > MAX_ATTACHMENTS_PER_PROMPT)
      throw new Error('at most 10 files are allowed');
    const root = path.join(this.workspaceRoot, '.forge', 'remote-inbox', conversationId, requestId);
    await fs.mkdir(root, { recursive: true });
    let total = 0;
    const refs: RemoteAttachmentReference[] = [];
    for (const attachment of attachments) {
      const prepared = await this.prepare(attachment);
      total += prepared.bytes.length;
      if (total > MAX_ATTACHMENT_TOTAL_BYTES)
        throw new Error('attachments exceed the 25 MiB total limit');
      const extension = prepared.kind === 'text' ? '.txt' : extensionFor(prepared.mediaType);
      const filename = `${refs.length + 1}-${randomUUID()}${extension}`;
      const target = path.join(root, filename);
      const temporary = `${target}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, prepared.bytes, { mode: 0o600 });
      await fs.rename(temporary, target);
      refs.push({
        name: prepared.name,
        mediaType: prepared.mediaType,
        relativePath: path.posix.join(conversationId, requestId, filename),
        bytes: prepared.bytes.length,
      });
    }
    return refs;
  }

  async load(refs: RemoteAttachmentReference[]): Promise<AttachmentData[]> {
    return Promise.all(
      refs.map(async (ref) => {
        const target = path.resolve(this.workspaceRoot, '.forge', 'remote-inbox', ref.relativePath);
        const root = path.resolve(this.workspaceRoot, '.forge', 'remote-inbox') + path.sep;
        if (!target.startsWith(root))
          throw new Error('remote attachment sidecar path escapes its inbox');
        const bytes = await fs.readFile(target);
        return {
          name: ref.name,
          mediaType: ref.mediaType,
          data: ref.mediaType.startsWith('image/')
            ? bytes.toString('base64')
            : bytes.toString('utf8'),
        };
      }),
    );
  }

  private async prepare(attachment: RemoteInboundAttachment): Promise<{
    name: string;
    mediaType: string;
    kind: 'image' | 'text';
    bytes: Buffer;
  }> {
    if (!attachment.data) throw new Error('attachment payload is unavailable');
    const binary =
      attachment.mediaType.startsWith('image/') || attachment.mediaType === 'application/pdf';
    const bytes = binary
      ? Buffer.from(attachment.data, 'base64')
      : Buffer.from(attachment.data, 'utf8');
    if (attachment.mediaType === 'application/pdf') {
      if (bytes.length > MAX_PDF_BYTES)
        throw new Error(`${attachment.name} exceeds its 10 MiB limit`);
      const text = await extractPdfText(bytes);
      return {
        name: `${attachment.name}.txt`,
        mediaType: 'text/plain',
        kind: 'text',
        bytes: Buffer.from(text),
      };
    }
    const kind = attachmentKind(attachment.name, attachment.mediaType);
    if (!kind) throw new Error(`${attachment.name} is unsupported`);
    if (kind === 'image') {
      if (bytes.length > 10 * 1024 * 1024)
        throw new Error(`${attachment.name} exceeds its 10 MiB limit`);
      if (mimeFromHeader(bytes) !== attachment.mediaType)
        throw new Error(`${attachment.name} image type does not match its contents`);
    } else if (bytes.length > 2 * 1024 * 1024) {
      throw new Error(`${attachment.name} exceeds its 2 MiB limit`);
    }
    return { name: attachment.name, mediaType: attachment.mediaType, kind, bytes };
  }
}

async function extractPdfText(bytes: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false })
    .promise;
  const parts: string[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const content = await (await document.getPage(pageNumber)).getTextContent();
    parts.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
  }
  const text = parts.join('\n').trim();
  if (!text)
    throw new Error('PDF has no extractable text (scanned/image-only PDFs are unsupported)');
  return text.slice(0, 2 * 1024 * 1024);
}

function extensionFor(mediaType: string): string {
  return (
    (
      {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif',
        'image/bmp': '.bmp',
      } as Record<string, string>
    )[mediaType] ?? '.bin'
  );
}
