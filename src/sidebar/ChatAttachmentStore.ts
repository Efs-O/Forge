import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { writeFileAtomic } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import type { AttachmentData } from './messageBridge';
// Owned by the message shape, not by this store: the transcript, the persistence
// schema and the webview bridge all name it, and only one of them may define it.
import type { ChatAttachmentRef } from '../llm/types';

export type { ChatAttachmentRef };

export interface ChatAttachmentSaveFailure {
  name: string;
  error: string;
}

export interface ChatAttachmentSaveResult {
  refs: ChatAttachmentRef[];
  failures: ChatAttachmentSaveFailure[];
}

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

const log = getLogger();
const OWNER_MARKER = '.owner';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionFor(name: string, mediaType: string): string {
  const known = EXTENSIONS[mediaType];
  if (known) return known;
  const suffix = path.extname(name);
  return /^\.[A-Za-z0-9]{1,8}$/u.test(suffix) ? suffix.toLowerCase() : '.bin';
}

export class ChatAttachmentStore {
  constructor(
    private readonly root: string,
    private readonly workspaceId: string,
  ) {}

  /** The directory the webview is given as a resource root. */
  get rootPath(): string {
    return this.root;
  }

  /**
   * Text attachments are stored as UTF-8 and images as raw bytes, matching how
   * `AttachmentData.data` already carries them.
   */
  async save(
    conversationId: string,
    attachments: AttachmentData[],
  ): Promise<ChatAttachmentSaveResult> {
    if (!attachments.length) return { refs: [], failures: [] };
    const directory = path.join(this.root, conversationId);
    try {
      await fs.mkdir(directory, { recursive: true });
      await this.ensureOwnerMarker(directory);
    } catch (error) {
      const detail = errorMessage(error);
      return {
        refs: [],
        failures: attachments.map((attachment) => ({ name: attachment.name, error: detail })),
      };
    }
    const refs: ChatAttachmentRef[] = [];
    const failures: ChatAttachmentSaveFailure[] = [];
    for (const attachment of attachments) {
      try {
        const isText = attachment.mediaType.startsWith('text/');
        const bytes = Buffer.from(attachment.data, isText ? 'utf8' : 'base64');
        const filename = `${randomUUID()}${extensionFor(attachment.name, attachment.mediaType)}`;
        const target = path.join(directory, filename);
        // Written atomically: a half-flushed file behind a reference the
        // transcript already shows would render as a broken image forever.
        await writeFileAtomic(target, bytes, { mode: 0o600 });
        refs.push({
          name: attachment.name,
          mediaType: attachment.mediaType,
          bytes: bytes.length,
          relativePath: path.posix.join(conversationId, filename),
        });
      } catch (error) {
        failures.push({ name: attachment.name, error: errorMessage(error) });
      }
    }
    return { refs, failures };
  }

  /**
   * Create the owner marker without replacing a marker another workspace may
   * already have written. Linking a fully flushed temporary file makes the
   * marker appear atomically and fails if the destination already exists.
   */
  private async ensureOwnerMarker(directory: string): Promise<void> {
    const marker = path.join(directory, OWNER_MARKER);
    try {
      const owner = await fs.readFile(marker, 'utf8');
      if (owner !== this.workspaceId) throw new Error('conversation belongs to another workspace');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const temporary = path.join(directory, `${OWNER_MARKER}-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(this.workspaceId, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.link(temporary, marker);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const owner = await fs.readFile(marker, 'utf8');
      if (owner !== this.workspaceId) throw new Error('conversation belongs to another workspace');
    } finally {
      await fs.rm(temporary, { force: true });
    }
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
   * Drops the directories of this workspace's conversations that no longer
   * exist. Directories with no owner marker (written before 0.17.43) are kept.
   *
   * Best-effort and non-fatal: an attachment left behind costs disk, while a
   * throw here would take activation down with it.
   */
  async prune(liveConversationIds: Iterable<string>): Promise<void> {
    const live = new Set(liveConversationIds);
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`[ChatAttachmentStore] could not list ${this.root}: ${errorMessage(error)}`);
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || live.has(entry.name)) continue;
      let owner: string;
      try {
        owner = await fs.readFile(path.join(this.root, entry.name, OWNER_MARKER), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn(
            `[ChatAttachmentStore] could not read owner marker for ${entry.name}: ${errorMessage(error)}`,
          );
        }
        continue;
      }
      if (owner !== this.workspaceId) continue;
      try {
        await fs.rm(path.join(this.root, entry.name), { recursive: true, force: true });
      } catch (error) {
        log.warn(`[ChatAttachmentStore] could not prune ${entry.name}: ${errorMessage(error)}`);
      }
    }
  }
}
