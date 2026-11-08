import type { Memento } from 'vscode';
import { isDeepStrictEqual } from 'util';
import {
  SESSION_KEY_V1,
  sidebarSessionPersistedSchema,
  type ConversationPersisted,
  type SidebarRuntime,
} from './sessionTypes';
import { conversationToPersisted } from './sessionPersistence';
import type { HistoryArchive } from './HistoryArchive';
import { getLogger } from '../util/logger';

type LegacyStore = Pick<Memento, 'get'>;
interface LegacyIndex {
  source: unknown;
  originals: Map<string, ConversationPersisted>;
  matches: Map<string, { version: string; copy: boolean }>;
}
const indices = new WeakMap<LegacyStore, LegacyIndex>();

/** Closing/retention can change these without changing the imported chat. */
function comparable(body: ConversationPersisted): Record<string, unknown> {
  const result: Record<string, unknown> = { ...body };
  delete result.updatedAt;
  delete result.retention_activity_at;
  delete result.keep_open;
  return result;
}

/**
 * Identify old shared-history copies for the panel only. Never remove them
 * from runtime/persistence: a later save would otherwise prune their bodies.
 * All copies remain reachable through the panel's explicit legacy toggle.
 */
export function legacyGlobalHistoryIds(
  globalState: LegacyStore | undefined,
  sidebar: SidebarRuntime,
  archive?: HistoryArchive,
): ReadonlySet<string> {
  if (!globalState) return new Set();
  const source = globalState.get<unknown>(SESSION_KEY_V1);
  let index = indices.get(globalState);
  if (!index || index.source !== source) {
    const parsed = sidebarSessionPersistedSchema.safeParse(source);
    if (source !== undefined && !parsed.success)
      getLogger().warn('Legacy global history could not be classified; all chats remain visible.');
    index = {
      source,
      originals: new Map(
        parsed.success
          ? [...parsed.data.conversations, ...(parsed.data.history ?? [])].map((body) => [
              body.id,
              body,
            ])
          : [],
      ),
      matches: new Map(),
    };
    indices.set(globalState, index);
  }
  const ids = new Set<string>();
  const classify = (
    id: string,
    version: string,
    read: () => ConversationPersisted | undefined,
  ): void => {
    const original = index.originals.get(id);
    if (!original) return;
    let match = index.matches.get(id);
    if (match?.version !== version) {
      const body = read();
      match = {
        version,
        copy: !!body && isDeepStrictEqual(comparable(original), comparable(body)),
      };
      index.matches.set(id, match);
    }
    if (match.copy) ids.add(id);
  };
  for (const body of sidebar.history) {
    classify(body.id, JSON.stringify([body.updatedAt, body.title, body.messages.length]), () =>
      conversationToPersisted(body),
    );
  }
  const recentIds = new Set([...sidebar.conversations, ...sidebar.history].map((body) => body.id));
  for (const row of archive?.overflow.list() ?? []) {
    if (recentIds.has(row.id)) continue;
    classify(row.id, JSON.stringify([row.updatedAt, row.title, row.messageCount]), () =>
      archive?.overflow.read(row.id),
    );
  }
  return ids;
}
