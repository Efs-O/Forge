import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AttachmentData } from './messageBridge';
// Owned by the message shape, not by this store: the transcript, the persistence
// schema and the webview bridge all name it, and only one of them may define it.
import type { ChatAttachmentRef } from '../llm/types';

export type { ChatAttachmentRef };

/**
 * On-disk home for the files a prompt carried, so the transcript can show them.
 *
 * The transcript cannot hold the pixels itself: `slimPersistMessages` strips
 * image parts precisely so base64 never reaches `workspaceState`. What survives
 * a reload is therefore a reference — name, type, size and a path under this
 * root — and the webview loads the bytes back through a webview URI.
 *
 * globalStorage rather than the workspace: an image pasted into a chat is not
 * project content, and writing it into the user's repo would put it in front of
 * `git status`. `.forge/remote-inbox` (RemoteAttachmentStore) stays where it is;
 * it holds a transport's inbox, not a transcript's history.
 */

const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
};

function extensionFor(name: string, mediaType: string): string {
  const known = EXTENSIONS[mediaType];
  if (known) return known;
  const suffix = path.extname(name);
  return /^\.[A-Za-z0-9]{1,8}$/u.test(suffix) ? suffix.toLowerCase() : '.bin';
}

export class ChatAttachmentStore {
  constructor(private readonly root: string) {}

  /** The directory the webview is given as a resource root. */
  get rootPath(): string {
    return this.root;
  }

  /**
   * Text attachments are stored as UTF-8 and images as raw bytes, matching how
   * `AttachmentData.data` already carries them.
   */
  async save(conversationId: string, attachments: AttachmentData[]): Promise<ChatAttachmentRef[]> {
    if (!attachments.length) return [];
    const directory = path.join(this.root, conversationId);
    await fs.mkdir(directory, { recursive: true });
    const refs: ChatAttachmentRef[] = [];
    for (const attachment of attachments) {
      const isText = attachment.mediaType.startsWith('text/');
      const bytes = Buffer.from(attachment.data, isText ? 'utf8' : 'base64');
      const filename = `${randomUUID()}${extensionFor(attachment.name, attachment.mediaType)}`;
      const target = path.join(directory, filename);
      // Written through a temporary: a half-flushed file behind a reference the
      // transcript already shows would render as a broken image forever.
      const temporary = `${target}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, bytes, { mode: 0o600 });
      await fs.rename(temporary, target);
      refs.push({
        name: attachment.name,
        mediaType: attachment.mediaType,
        bytes: bytes.length,
        relativePath: path.posix.join(conversationId, filename),
      });
    }
    return refs;
  }

  /** Absolute path for a reference, refusing anything that escapes the root. */
  resolve(relativePath: string): string {
    const target = path.resolve(this.root, relativePath);
    if (!target.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error('chat attachment path escapes its store');
    }
    return target;
  }

  /**
   * Drops the directories of conversations that no longer exist.
   *
   * Best-effort and non-fatal: an attachment left behind costs disk, while a
   * throw here would take activation down with it.
   */
  async prune(liveConversationIds: Iterable<string>): Promise<void> {
    const live = new Set(liveConversationIds);
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !live.has(entry.name))
        .map((entry) =>
          fs
            .rm(path.join(this.root, entry.name), { recursive: true, force: true })
            .catch(() => undefined),
        ),
    );
  }
}
