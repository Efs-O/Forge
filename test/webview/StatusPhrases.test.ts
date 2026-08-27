import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLANKER_PHRASES,
  CLOUD_PHRASES,
  LOCAL_PHRASES,
  SHARED_PHRASES,
  nextPhrase,
  phrasePool,
  resetPhraseBags,
} from '../../webview-ui/src/statusPhrases';

beforeEach(() => resetPhraseBags());

describe('phrasePool', () => {
  it('gives a cloud turn no phrase about the user own hardware', () => {
    // The whole point of the split: claiming local VRAM load during an xAI call
    // would undercut the residency signalling the rest of the sidebar does.
    const pool = phrasePool({ local: false, clanker: false });
    for (const phrase of LOCAL_PHRASES) expect(pool).not.toContain(phrase);
    expect(pool).toEqual([...CLOUD_PHRASES, ...SHARED_PHRASES]);
  });

  it('gives a local turn no phrase about paying for someone else GPU', () => {
    const pool = phrasePool({ local: true, clanker: false });
    for (const phrase of CLOUD_PHRASES) expect(pool).not.toContain(phrase);
  });

  it('adds the clanker phrases to whichever pool applies, replacing neither', () => {
    const local = phrasePool({ local: true, clanker: true });
    expect(local).toEqual([...LOCAL_PHRASES, ...SHARED_PHRASES, ...CLANKER_PHRASES]);

    const cloud = phrasePool({ local: false, clanker: true });
    expect(cloud).toEqual([...CLOUD_PHRASES, ...SHARED_PHRASES, ...CLANKER_PHRASES]);
  });

  it('holds enough phrases to rotate a long turn without obvious repeats', () => {
    // At 12s a 40s cold load shows ~4 phrases; the bag is what makes the rest
    // of the deck reachable across turns.
    expect(LOCAL_PHRASES.length).toBeGreaterThanOrEqual(12);
    expect(CLOUD_PHRASES.length).toBeGreaterThanOrEqual(10);
  });

  it('never promises progress it cannot measure', () => {
    const all = [...LOCAL_PHRASES, ...CLOUD_PHRASES, ...SHARED_PHRASES, ...CLANKER_PHRASES];
    for (const phrase of all) {
      expect(phrase).not.toMatch(/almost|nearly|soon|finishing|wrapping/i);
    }
  });

  it('keeps the shared phrases free of any claim about where the work runs', () => {
    for (const phrase of SHARED_PHRASES) {
      expect(phrase).not.toMatch(/gpu|vram|credit|rent|datacenter|silicon|watt/i);
    }
  });
});

describe('nextPhrase', () => {
  it('never repeats the phrase already showing', () => {
    const pool = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) {
      expect(nextPhrase(pool, 'b')).not.toBe('b');
    }
  });

  it('still returns something when the pool holds only the current phrase', () => {
    expect(nextPhrase(['only'], 'only')).toBe('only');
  });

  it('picks from the pool when nothing is showing yet', () => {
    expect(['a', 'b']).toContain(nextPhrase(['a', 'b'], null));
  });
});

describe('nextPhrase bag', () => {
  it('deals every phrase once before repeating any of them', () => {
    // The reason the bag exists. Independent uniform draws needed ~100 picks to
    // cover a 26-phrase pool, so the rarer phrases went unseen for days.
    const pool = phrasePool({ local: true, clanker: true });
    const seen: string[] = [];
    let current: string | null = null;
    for (let i = 0; i < pool.length; i++) {
      current = nextPhrase(pool, current);
      seen.push(current);
    }
    expect(new Set(seen).size).toBe(pool.length);
    expect([...seen].sort()).toEqual([...pool].sort());
  });

  it('keeps dealing full cycles, never stalling once the deck runs out', () => {
    const pool = phrasePool({ local: true, clanker: false });
    let current: string | null = null;
    for (let cycle = 0; cycle < 3; cycle++) {
      const seen = new Set<string>();
      for (let i = 0; i < pool.length; i++) {
        current = nextPhrase(pool, current);
        seen.add(current);
      }
      expect(seen.size).toBe(pool.length);
    }
  });

  it('carries a partly dealt bag across turns rather than restarting it', () => {
    // A short turn draws one phrase. If the bag reset per turn, every turn
    // would deal from a full deck and the tail would stay unreachable.
    const pool = phrasePool({ local: true, clanker: false });
    const seen = new Set<string>();
    for (let turn = 0; turn < pool.length; turn++) {
      seen.add(nextPhrase(pool, null));
    }
    expect(seen.size).toBe(pool.length);
  });

  it('gives each pool composition its own deck', () => {
    // Toggling Clanker Mode must not throw away progress through the other one.
    const plain = phrasePool({ local: true, clanker: false });
    const clanker = phrasePool({ local: true, clanker: true });
    const first = nextPhrase(plain, null);
    for (let i = 0; i < clanker.length; i++) nextPhrase(clanker, null);

    const rest = new Set<string>();
    for (let i = 0; i < plain.length - 1; i++) rest.add(nextPhrase(plain, null));
    expect(rest.has(first)).toBe(false);
    expect(rest.size).toBe(plain.length - 1);
  });
});
