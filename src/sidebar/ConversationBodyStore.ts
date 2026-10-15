/** Shared atomic storage for one JSON body per conversation id. */

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import { isSafeId } from './ArchivedSessions';
import {
  conversationPersistedSchema,
  type ConversationPersisted,
  type ConversationRuntime,
} from './sessionTypes';

const log = getLogger();

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BodySaveResult {
  ok: boolean;
  failedBodies: ConversationPersisted[];
}

/**
 * Owns atomic per-id body reads/writes, quarantine, change signatures and
 * deferred removals. The caller supplies its signature because history and
 * open conversations have different change contracts.
 */
export class ConversationBodyStore {
  private readonly written = new Map<string, string>();
  private readonly pendingRemovals = new Set<string>();
  /** Refuse writes if existing data could not be read or safely quarantined. */
  private blocked = false;

  constructor(
    readonly directory: string,
    private readonly name: string,
  ) {}

  /** Read only `.json` bodies; an orphan atomic-write temp is never a body. */
  load(signature: (body: ConversationPersisted) => string): ConversationPersisted[] | undefined {
    let filenames: string[] | undefined;
    try {
      filenames = fs.readdirSync(this.directory).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error(`[${this.name}] could not list ${this.directory}: ${detailOf(error)}`);
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
      this.written.set(id, signature(body));
    }
    return filenames === undefined && !this.blocked ? undefined : [...byId.values()];
  }

  /** Write changed bodies, always writing a specifically changed hot-path id. */
  save(
    conversations: readonly ConversationRuntime[],
    build: (conversation: ConversationRuntime) => ConversationPersisted,
    signature: (conversation: ConversationRuntime) => string,
    forceId?: string,
    forceIds?: ReadonlySet<string>,
  ): BodySaveResult {
    const failedBodies: ConversationPersisted[] = [];
    if (this.blocked) {
      return {
        ok: false,
        failedBodies: conversations.map((conversation) => build(conversation)),
      };
    }

    for (const conversation of conversations) {
      let body: ConversationPersisted | undefined;
      try {
        if (!isSafeId(conversation.id))
          throw new Error(`Invalid ${this.name.toLowerCase()} conversation id: ${conversation.id}`);
        const nextSignature = signature(conversation);
        if (
          conversation.id !== forceId &&
          !forceIds?.has(conversation.id) &&
          this.written.get(conversation.id) === nextSignature
        )
          continue;
        fs.mkdirSync(this.directory, { recursive: true });
        body = build(conversation);
        writeFileAtomicSync(this.bodyPath(conversation.id), JSON.stringify(body));
        this.written.set(conversation.id, nextSignature);
      } catch (error) {
        log.error(`[${this.name}] could not write ${conversation.id}: ${detailOf(error)}`);
        if (body) failedBodies.push(body);
        else {
          try {
            failedBodies.push(build(conversation));
          } catch (buildError) {
            log.error(
              `[${this.name}] could not serialize ${conversation.id}: ${detailOf(buildError)}`,
            );
          }
        }
      }
    }

    const currentIds = new Set(conversations.map((conversation) => conversation.id));
    for (const id of currentIds) this.pendingRemovals.delete(id);
    for (const id of this.written.keys()) {
      if (!currentIds.has(id)) this.pendingRemovals.add(id);
    }
    return { ok: failedBodies.length === 0, failedBodies };
  }

  /** Unlink bodies only after the memento describing the new list commits. */
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
        log.error(`[${this.name}] could not remove body ${id}: ${detailOf(error)}`);
      }
    }
  }

  private readBody(filename: string, expectedId: string): ConversationPersisted | undefined {
    const target = path.join(this.directory, filename);
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

  private quarantineBody(target: string, id: string, detail: string): void {
    const safeId = isSafeId(id) ? id : path.basename(target, '.json');
    const aside = path.join(this.directory, `${safeId}.corrupt-${Date.now()}.json.bad`);
    try {
      fs.renameSync(target, aside);
      log.error(`[${this.name}] unreadable body moved to ${aside}: ${detail}`);
    } catch (error) {
      log.error(
        `[${this.name}] unreadable body ${target} (${detail}); could not quarantine it: ${detailOf(error)}`,
      );
      this.blocked = true;
    }
  }

  private bodyPath(id: string): string {
    if (!isSafeId(id)) throw new Error(`Invalid ${this.name.toLowerCase()} conversation id: ${id}`);
    return path.join(this.directory, `${id}.json`);
  }
}
