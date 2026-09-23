/**
 * The archived-conversation list, kept in its own file instead of workspaceState.
 *
 * VS Code's Memento ships an extension's WHOLE workspaceState to the renderer on
 * every `update()`, and Forge saves the session after every tool round, so 40
 * archived transcripts (45 MB in the workspace this was measured in) were being
 * re-sent and re-serialized by the workbench on each round — the whole window
 * lagged. The archive changes only when a tab is closed or cleared, so it lives
 * here and is rewritten only when it actually changed. See
 * `docs/plans/SESSION_HISTORY_FILE_PLAN.md`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { ArchivedSessions } from './ArchivedSessions';
import { getLogger } from '../util/logger';
import {
  conversationPersistedSchema,
  type ConversationPersisted,
  type ConversationRuntime,
} from './sessionTypes';

const log = getLogger();
const archiveSchema = z.array(conversationPersistedSchema);

export const HISTORY_ARCHIVE_FILE = 'conversation-history.json';

function signatureOf(history: readonly ConversationRuntime[]): string {
  return history.map((c) => `${c.id}:${c.updatedAt}:${c.title}:${c.messages.length}`).join('|');
}

export class HistoryArchive {
  /** Signature of what the file holds, as far as this process knows. */
  private writtenSignature: string | undefined;
  /**
   * Set when the file exists but could neither be read nor moved aside. Saves
   * then refuse, so history stays in the memento instead of an empty list
   * overwriting the only copy of the old one.
   */
  private blocked = false;

  readonly overflow: ArchivedSessions;

  constructor(
    readonly filePath: string,
    workspacePath?: string,
  ) {
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
   * The archived conversations, or `undefined` when there is no file yet.
   * An unparsable file is renamed aside (never deleted) and reads as empty.
   */
  load(): ConversationPersisted[] | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      const detail = error instanceof Error ? error.message : String(error);
      log.error(
        `[HistoryArchive] could not read ${this.filePath}; leaving it untouched: ${detail}`,
      );
      this.blocked = true;
      return [];
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      this.quarantine(error instanceof Error ? error.message : String(error));
      return [];
    }
    const parsed = archiveSchema.safeParse(json);
    if (!parsed.success) {
      this.quarantine(parsed.error.message);
      return [];
    }
    return parsed.data;
  }

  /**
   * Write `history` when it differs from what the file last held. `build` is
   * called only then, so an unchanged archive costs one string compare.
   * Returns false when the write failed; the caller must then keep the
   * history somewhere else, because the file does not hold it.
   */
  save(history: readonly ConversationRuntime[], build: () => ConversationPersisted[]): boolean {
    if (this.blocked) return false;
    const signature = signatureOf(history);
    if (signature === this.writtenSignature) return true;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileAtomicSync(this.filePath, JSON.stringify(build()));
      this.writtenSignature = signature;
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log.error(`[HistoryArchive] could not write ${this.filePath}: ${detail}`);
      this.writtenSignature = undefined;
      return false;
    }
  }

  private quarantine(detail: string): void {
    const parsed = path.parse(this.filePath);
    const target = path.join(parsed.dir, `${parsed.name}.corrupt-${Date.now()}${parsed.ext}`);
    try {
      fs.renameSync(this.filePath, target);
      log.error(`[HistoryArchive] unreadable archive moved to ${target}: ${detail}`);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      log.error(
        `[HistoryArchive] unreadable archive ${this.filePath} (${detail}); could not move it aside, leaving it untouched: ${why}`,
      );
      this.blocked = true;
    }
    this.writtenSignature = undefined;
  }
}
