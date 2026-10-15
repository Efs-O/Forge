/** Per-conversation history bodies, with the old list file read only for migration. */

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../util/logger';
import { ArchivedSessions } from './ArchivedSessions';
import { ConversationBodyStore } from './ConversationBodyStore';
import { OpenConversationsPersistence } from './openConversationsPersistence';
import {
  conversationPersistedSchema,
  type ConversationPersisted,
  type ConversationRuntime,
} from './sessionTypes';

const log = getLogger();

export const HISTORY_ARCHIVE_FILE = 'conversation-history.json';

function signatureOf(conversation: ConversationRuntime | ConversationPersisted): string {
  return `${conversation.updatedAt}:${conversation.title}:${conversation.messages.length}:${JSON.stringify(conversation.agentLinks ?? {})}`;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HistoryArchive {
  private readonly bodies: ConversationBodyStore;
  private legacyMayExist = true;
  private legacyBlocked = false;
  readonly openConversations: OpenConversationsPersistence;
  readonly overflow: ArchivedSessions;

  constructor(
    readonly filePath: string,
    workspacePath?: string,
  ) {
    const storageDirectory = path.dirname(filePath);
    this.bodies = new ConversationBodyStore(
      path.join(storageDirectory, 'history'),
      'HistoryArchive',
    );
    this.openConversations = new OpenConversationsPersistence(
      new ConversationBodyStore(path.join(storageDirectory, 'open'), 'OpenConversations'),
    );
    this.overflow = new ArchivedSessions(storageDirectory, workspacePath);
  }

  /** The archive for a workspace storage folder; none without one (no folder open). */
  static inStorageDir(
    storageDir: string | undefined,
    workspacePath?: string,
  ): HistoryArchive | undefined {
    return storageDir
      ? new HistoryArchive(path.join(storageDir, HISTORY_ARCHIVE_FILE), workspacePath)
      : undefined;
  }

  /** Read directory bodies and union the old list file while it migrates. */
  load(): ConversationPersisted[] | undefined {
    const bodies = this.bodies.load(signatureOf);
    const byId = new Map((bodies ?? []).map((body) => [body.id, body]));
    const legacy = this.loadLegacy();
    if (legacy === undefined && bodies === undefined) return undefined;
    for (const entry of legacy ?? []) {
      const current = byId.get(entry.id);
      if (!current || entry.updatedAt > current.updatedAt) byId.set(entry.id, entry);
      // Legacy-only entries are materialized before the legacy file is removed.
    }
    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Write only changed bodies; a false result keeps the caller's memento copy. */
  save(
    history: readonly ConversationRuntime[],
    build: (conversation: ConversationRuntime) => ConversationPersisted,
  ): boolean {
    if (this.legacyBlocked) return false;
    if (!this.bodies.save(history, build, signatureOf).ok) return false;
    if (!this.legacyMayExist) return true;
    try {
      fs.unlinkSync(this.filePath);
      this.legacyMayExist = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.legacyMayExist = false;
        return true;
      }
      log.error(
        `[HistoryArchive] could not remove migrated legacy file ${this.filePath}: ${detailOf(error)}`,
      );
      return false;
    }
    return true;
  }

  /** Remove bodies made redundant by a successful memento write. */
  pruneRemoved(): void {
    this.bodies.pruneRemoved();
  }

  private loadLegacy(): ConversationPersisted[] | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      log.error(
        `[HistoryArchive] could not read ${this.filePath}; leaving it untouched: ${detailOf(error)}`,
      );
      this.legacyBlocked = true;
      return [];
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      this.quarantineLegacy(detailOf(error));
      return [];
    }
    if (!Array.isArray(json)) {
      this.quarantineLegacy('legacy archive must be an array');
      return [];
    }
    const parsed = json.map((entry) => conversationPersistedSchema.safeParse(entry));
    if (parsed.some((entry) => !entry.success)) {
      const invalid = parsed.find((entry) => !entry.success);
      this.quarantineLegacy(invalid && !invalid.success ? invalid.error.message : 'invalid entry');
      return [];
    }
    return parsed.flatMap((entry) => (entry.success ? [entry.data] : []));
  }

  private quarantineLegacy(detail: string): void {
    const parsed = path.parse(this.filePath);
    const target = path.join(parsed.dir, `${parsed.name}.corrupt-${Date.now()}${parsed.ext}`);
    try {
      fs.renameSync(this.filePath, target);
      log.error(`[HistoryArchive] unreadable legacy archive moved to ${target}: ${detail}`);
    } catch (error) {
      log.error(
        `[HistoryArchive] unreadable archive ${this.filePath} (${detail}); could not move it aside: ${detailOf(error)}`,
      );
      this.legacyBlocked = true;
    }
  }
}
