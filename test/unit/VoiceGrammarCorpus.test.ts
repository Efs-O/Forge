import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { matchVoiceCommand } from '../../src/voice/VoiceGrammar';

/**
 * The R3 gate, run against REAL recogniser output on REAL human speech.
 *
 * Every other grammar test feeds `matchVoiceCommand` strings a developer typed,
 * which means it only ever sees mistakes a developer thought to imagine. This
 * one feeds it what whisper.cpp actually produced from the recorded corpus --
 * including "Μείνα εγκρίνης" for "μην εγκρίνεις", which no one would have
 * invented and which is precisely the shape that could authorize an action by
 * accident.
 *
 * Tier A: the transcripts are checked in, so no binary, model or GPU is needed.
 * Regenerate them when the backend changes (see the fixture's $comment).
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §24 (R3, R9).
 */

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'voice');

interface Expectation {
  readonly grammar?: string | null;
  readonly negation?: boolean;
  readonly critical?: readonly string[];
  readonly mustNotContain?: readonly string[];
}
interface ManifestEntry {
  readonly id: string;
  readonly text: string;
  readonly expect?: Expectation;
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'),
) as { entries: ManifestEntry[] };

const corpus = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'transcripts-whispercpp-large-v3-cuda.json'), 'utf8'),
) as { transcripts: Record<string, { text: string; elapsedMs: number }> };

const entries = manifest.entries.filter((entry) => corpus.transcripts[entry.id]);

describe('voice grammar against the recorded corpus', () => {
  it('covers every recorded utterance', () => {
    expect(entries.length).toBe(Object.keys(corpus.transcripts).length);
  });

  /**
   * The one assertion that is a release blocker rather than a regression.
   * A negated utterance resolving to a command is a false authorization: the
   * user said "do not approve" and the system approved.
   */
  it.each(entries.filter((entry) => entry.expect?.negation === true))(
    'refuses to authorize on negated utterance $id',
    (entry) => {
      const heard = corpus.transcripts[entry.id]!.text;
      expect(matchVoiceCommand(heard), `heard: ${heard}`).toBeUndefined();
    },
  );

  it.each(entries.filter((entry) => typeof entry.expect?.grammar === 'string'))(
    'still recognises the plain command $id',
    (entry) => {
      const heard = corpus.transcripts[entry.id]!.text;
      expect(matchVoiceCommand(heard), `heard: ${heard}`).toBe(entry.expect!.grammar);
    },
  );

  /**
   * A free-form prompt must never be swallowed by the grammar -- it is a
   * message for the agent, not a control word.
   */
  it.each(entries.filter((entry) => entry.expect?.grammar === null))(
    'treats $id as a prompt, not a command',
    (entry) => {
      const heard = corpus.transcripts[entry.id]!.text;
      expect(matchVoiceCommand(heard), `heard: ${heard}`).toBeUndefined();
    },
  );

  /**
   * §27.1's trailing-silence hallucination: whisper.cpp repeats the final line
   * or appends a stray phrase when audio ends in silence. The recorded clip has
   * six seconds of it.
   */
  it('does not hallucinate past the end of speech', () => {
    const heard = corpus.transcripts['trailing-silence']!.text.toLowerCase();
    expect(heard).toContain('restart the backend');
    expect(heard.match(/restart the backend/g)?.length).toBe(1);
  });
});
