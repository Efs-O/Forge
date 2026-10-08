/**
 * Per-conversation history bodies, with the old list file read only for migration.
 * See `docs/plans/HISTORY_PER_CONVERSATION_FILES_PLAN.md`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import { ArchivedSessions, isSafeId } from './ArchivedSessions';
import {
  conversationPersistedSchema,
  type ConversationPersisted,
  type ConversationRuntime,
} from './sessionTypes';

const log = getLogger();

export const HISTORY_ARCHIVE_FILE = 'conversation-history.json';

function signatureOf(conversation: ConversationRuntime): string {
  return `${conversation.updatedAt}:${conversation.title}:${conversation.messages.length}:${JSON.stringify(conversation.agentLinks ?? {})}`;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class HistoryArchive {
  private readonly bodyDirectory: string;
  private readonly written = new Map<string, string>();
  private readonly pendingRemovals = new Set<string>();
  /** Refuse writes if existing data could not be read or safely quarantined. */
  private blocked = false;
  /**
   * True until a save confirms the legacy list file is gone, so the delete is
   * one syscall per process rather than one per tool-round save.
   */
  private legacyMayExist = true;

  readonly overflow: ArchivedSessions;

  constructor(
    readonly filePath: string,
    workspacePath?: string,
  ) {
    this.bodyDirectory = path.join(path.dirname(filePath), 'history');
    this.overflow = new ArchivedSessions(path.dirname(filePath), workspacePath);
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

  /**
   * Read all conversation bodies, unioning an old list file while it migrates.
   * Returns undefined only when neither storage layout exists.
   */
  load(): ConversationPersisted[] | undefined {
    let filenames: string[] | undefined;
    try {
      filenames = fs.readdirSync(this.bodyDirectory).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error(`[HistoryArchive] could not list ${this.bodyDirectory}: ${detailOf(error)}`);
        this.blocked = true;
        return [];
      }
    }

    this.written.clear();
    const byId = new Map<string, ConversationPersisted>();
    for (const filename of filenames ?? []) {
      const id = filename.slice(0, -'.json'.length);
      const body = this.readBody(filename, id);
      if (!body) continue;
      byId.set(id, body);
      this.written.set(id, this.signatureOfPersisted(body));
    }

    const legacy = this.loadLegacy();
    if (legacy === undefined && filenames === undefined && !this.blocked) return undefined;
    for (const entry of legacy ?? []) {
      const current = byId.get(entry.id);
      if (!current || entry.updatedAt > current.updatedAt) byId.set(entry.id, entry);
      // Legacy-only entries intentionally are not marked written; the first
      // save must materialize them in the new directory before deleting legacy.
    }

    return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Write only changed bodies; a false result keeps the caller's memento copy. */
  save(
    history: readonly ConversationRuntime[],
    build: (conversation: ConversationRuntime) => ConversationPersisted,
  ): boolean {
    if (this.blocked) return false;
    try {
      for (const conversation of history) {
        if (!isSafeId(conversation.id))
          throw new Error(`Invalid history conversation id: ${conversation.id}`);
        const signature = signatureOf(conversation);
        if (this.written.get(conversation.id) === signature) continue;
        fs.mkdirSync(this.bodyDirectory, { recursive: true });
        const persisted = build(conversation);
        writeFileAtomicSync(this.bodyPath(conversation.id), JSON.stringify(persisted));
        this.written.set(conversation.id, signature);
      }
    } catch (error) {
      log.error(`[HistoryArchive] could not write history bodies: ${detailOf(error)}`);
      return false;
    }

    const currentIds = new Set(history.map((conversation) => conversation.id));
    for (const id of currentIds) this.pendingRemovals.delete(id);
    for (const id of this.written.keys()) {
      if (!currentIds.has(id)) this.pendingRemovals.add(id);
    }

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
    for (const id of this.pendingRemovals) {
      try {
        fs.unlinkSync(this.bodyPath(id));
        this.pendingRemovals.delete(id);
        this.written.delete(id);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.pendingRemovals.delete(id);
          this.written.delete(id);
          continue;
        }
        log.error(`[HistoryArchive] could not remove history body ${id}: ${detailOf(error)}`);
      }
    }
  }

  private readBody(filename: string, expectedId: string): ConversationPersisted | undefined {
    const target = path.join(this.bodyDirectory, filename);
    try {
      const parsed = conversationPersistedSchema.safeParse(
        JSON.parse(fs.readFileSync(target, 'utf8')),
      );
      if (parsed.success && isSafeId(expectedId) && parsed.data.id === expectedId)
        return parsed.data;
      this.quarantineBody(
        target,
        expectedId,
        parsed.success ? 'body id does not match filename' : parsed.error.message,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.quarantineBody(target, expectedId, detailOf(error));
    }
    return undefined;
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
      this.blocked = true;
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

  private quarantineBody(target: string, id: string, detail: string): void {
    const safeId = isSafeId(id) ? id : path.basename(target, '.json');
    const aside = path.join(this.bodyDirectory, `${safeId}.corrupt-${Date.now()}.json.bad`);
    try {
      fs.renameSync(target, aside);
      log.error(`[HistoryArchive] unreadable body moved to ${aside}: ${detail}`);
    } catch (error) {
      log.error(
        `[HistoryArchive] unreadable body ${target} (${detail}); could not quarantine it: ${detailOf(error)}`,
      );
      this.blocked = true;
    }
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
      this.blocked = true;
    }
  }

  private bodyPath(id: string): string {
    if (!isSafeId(id)) throw new Error(`Invalid history conversation id: ${id}`);
    return path.join(this.bodyDirectory, `${id}.json`);
  }

  private signatureOfPersisted(conversation: ConversationPersisted): string {
    return `${conversation.updatedAt}:${conversation.title}:${conversation.messages.length}:${JSON.stringify(conversation.agentLinks ?? {})}`;
  }
}
