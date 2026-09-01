import { randomBytes } from 'crypto';
import type { RemoteSelection } from './RemoteStoreSchemas';

/**
 * The list-identity rules for a remote numeric selection, in one place.
 *
 * Issue, look up and clear each matched `(channel, chatId, kind)` with their own
 * inline predicate, so the token check that makes a page button unforgeable had
 * to be written three times to hold. They are pure functions over the stored
 * array: `RemoteRequestStore` still owns persistence and mutation ordering.
 */

export type SelectionKey = {
  channel: RemoteSelection['channel'];
  chatId: string;
  kind: RemoteSelection['kind'];
};

/** 12 base64url characters — the width the Telegram callback codec parses. */
export function newSelectionToken(): string {
  return randomBytes(9).toString('base64url');
}

function isSameList(candidate: RemoteSelection, key: SelectionKey): boolean {
  return (
    candidate.channel === key.channel &&
    candidate.chatId === key.chatId &&
    candidate.kind === key.kind
  );
}

/** A new list of a kind replaces the old one, which is what makes its buttons stale. */
export function replaceSelection(
  selections: RemoteSelection[],
  next: RemoteSelection,
): RemoteSelection[] {
  return [...selections.filter((item) => !isSameList(item, next)), next];
}

export function findSelection(
  selections: readonly RemoteSelection[],
  key: SelectionKey,
  token: string | undefined,
  now: number,
): RemoteSelection | undefined {
  const item = selections.find(
    (candidate) => isSameList(candidate, key) && (token === undefined || candidate.token === token),
  );
  return item && item.expiresAt > now ? item : undefined;
}

export function removeSelection(
  selections: readonly RemoteSelection[],
  key: SelectionKey,
  token: string,
): { selections: RemoteSelection[]; removed: boolean } {
  const kept = selections.filter((item) => !(isSameList(item, key) && item.token === token));
  return { selections: kept, removed: kept.length !== selections.length };
}
