import { describe, expect, it } from 'vitest';
import {
  CLANKER_PHRASES,
  CLOUD_PHRASES,
  LOCAL_PHRASES,
  SHARED_PHRASES,
  nextPhrase,
  phrasePool,
} from '../../webview-ui/src/statusPhrases';

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
    // At 3.5s a 40s cold load shows ~11 phrases.
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
