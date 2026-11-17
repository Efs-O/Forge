/** Shared atomic storage for one JSON body per conversation id. */

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import { isSafeId } from './ArchivedSessions';
import { parseConversationBody } from './conversationBodyParse';
import { type ConversationPersisted, type ConversationRuntime } from './sessionTypes';

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

  /**
   * One body. A body that fails validation anywhere else is moved aside as
   * before; one whose only bad field is `compaction` loads, and its file is
   * copied (not renamed) aside, so the live file stays and the damaged bytes
   * stay readable.
   */
  private readBody(filename: string, expectedId: string): ConversationPersisted | undefined {
    const target = path.join(this.directory, filename);
    try {
      const parsed = parseConversationBody(JSON.parse(fs.readFileSync(target, 'utf8')));
      if (!parsed.ok) {
        this.quarantineBody(target, expectedId, parsed.issue);
        return undefined;
      }
      if (!isSafeId(expectedId) || parsed.body.id !== expectedId) {
        this.quarantineBody(target, expectedId, 'body id does not match filename');
        return undefined;
      }
      if (parsed.dropped === 'compaction') {
        const aside = this.copyAside(target, expectedId);
        log.error(
          `[${this.name}] kept body ${expectedId} with its compaction notes dropped; ` +
            `copy at ${aside}: ${parsed.issue}`,
        );
      }
      return parsed.body;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      this.quarantineBody(target, expectedId, detailOf(error));
    }
    return undefined;
  }

  /** The id part of an aside name; every aside builder and the duplicate check use it. */
  private safeIdFor(target: string, id: string): string {
    return isSafeId(id) ? id : path.basename(target, '.json');
  }

  /** The aside name for a damaged body; both handlers below build it the same way. */
  private asidePath(target: string, id: string): string {
    const safeId = this.safeIdFor(target, id);
    return path.join(this.directory, `${safeId}.corrupt-${Date.now()}.json.bad`);
  }

  /**
   * An aside already written for this body, oldest first. `asidePath` stamps a
   * fresh timestamp on every call, so without this a body that stays damaged
   * on disk (an untouched chat is never rewritten) gained one copy per load.
   * A directory that cannot be listed simply means no known copy.
   */
  private existingAside(target: string, id: string): string | undefined {
    const prefix = `${this.safeIdFor(target, id)}.corrupt-`;
    try {
      const [oldest] = fs
        .readdirSync(this.directory)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.json.bad'))
        .sort();
      return oldest === undefined ? undefined : path.join(this.directory, oldest);
    } catch {
      return undefined;
    }
  }

  /**
   * Copy a body that still loaded, so the original stays the live one — and
   * only the first time. The quarantine path below never asks: a body it
   * cannot load at all is renamed away, copy or no copy.
   */
  private copyAside(target: string, id: string): string {
    const existing = this.existingAside(target, id);
    if (existing !== undefined) return existing;
    const aside = this.asidePath(target, id);
    try {
      fs.copyFileSync(target, aside);
    } catch (error) {
      log.error(
        `[${this.name}] could not copy loaded body ${target} to ${aside}: ${detailOf(error)}`,
      );
    }
    return aside;
  }

  private quarantineBody(target: string, id: string, detail: string): void {
    const aside = this.asidePath(target, id);
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
