import { describe, expect, it } from 'vitest';
import type { SessionTabMeta } from '../../src/sidebar/messageBridge';
import { RESUMED_AFTER_MS, resumedNoteFor, resumedTabIds } from '../../webview-ui/src/resumedTabs';

const NOW = 1_800_000_000_000;

function tab(over: Partial<SessionTabMeta> & { id: string }): SessionTabMeta {
  return { title: 't', createdAt: 0, updatedAt: NOW, messageCount: 5, ...over };
}

describe('resumedTabIds', () => {
  it('leaves a freshly used tab alone', () => {
    const ids = resumedTabIds([tab({ id: 'a', updatedAt: NOW - 60_000 })], NOW);
    expect(ids.has('a')).toBe(false);
  });

  it('marks a stale tab that has messages', () => {
    const ids = resumedTabIds([tab({ id: 'a', updatedAt: NOW - RESUMED_AFTER_MS - 1 })], NOW);
    expect(ids.has('a')).toBe(true);
  });

  it('never marks an empty tab, however old', () => {
    // Nothing to resume: the marker would sit alone above the composer.
    const ids = resumedTabIds(
      [tab({ id: 'a', updatedAt: NOW - RESUMED_AFTER_MS * 100, messageCount: 0 })],
      NOW,
    );
    expect(ids.has('a')).toBe(false);
  });

  it('treats exactly the threshold as not yet resumed', () => {
    const ids = resumedTabIds([tab({ id: 'a', updatedAt: NOW - RESUMED_AFTER_MS })], NOW);
    expect(ids.has('a')).toBe(false);
  });
});

describe('resumedNoteFor', () => {
  const relative = (): string => '3 days ago';

  it('describes the tab when it is in the resumed set', () => {
    expect(resumedNoteFor(tab({ id: 'a', messageCount: 12 }), new Set(['a']), relative)).toBe(
      'resumed · 3 days ago · 12 msgs',
    );
  });

  it('singularises a one-message tab', () => {
    expect(resumedNoteFor(tab({ id: 'a', messageCount: 1 }), new Set(['a']), relative)).toBe(
      'resumed · 3 days ago · 1 msg',
    );
  });

  it('returns null for a tab outside the set, and for no tab at all', () => {
    expect(resumedNoteFor(tab({ id: 'a' }), new Set(['b']), relative)).toBeNull();
    expect(resumedNoteFor(undefined, new Set(['a']), relative)).toBeNull();
  });
});
