import { describe, expect, it } from 'vitest';
import { applyLexicon } from '../../src/voice/SpeechLexicon';
import { renderForSpeech } from '../../src/voice/SpeechRenderer';

/**
 * The vocabulary half of a listenable reply.
 *
 * Every case below is taken from one real spoken reply that ran 41 seconds for
 * four sentences of content -- a Telegram exchange on 2026-09-03 about which
 * llama.cpp build Forge was using. The tokens that made it unlistenable were
 * `b10733`, `a15...bdc`, `Q3_K_XL.gguf` and a full Windows path, and espeak
 * attempted every one of them as a word.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §14.
 */
describe('applyLexicon', () => {
  it('spells known acronyms rather than attempting them as words', () => {
    expect(applyLexicon('The GGUF loaded.')).toBe('The G G U F loaded.');
    expect(applyLexicon('Run npm install.')).toBe('Run N P M install.');
    expect(applyLexicon('Check the YAML.')).toBe('Check the yammle.');
  });

  it('keeps a multi-word term whole instead of splitting it', () => {
    // The whole-token lookup has to run before the dot split, or this becomes
    // "llama" plus "cpp" and the curated entry never fires.
    expect(applyLexicon('Forge uses llama.cpp today.')).toBe('Forge uses llama C P P today.');
  });

  /**
   * A build id is not a quantity. Reading `b10733` as "ten thousand seven
   * hundred thirty three" states a magnitude that does not exist and is harder
   * to write down than the digits.
   */
  it('reads a build id digit by digit', () => {
    expect(applyLexicon('build b10733 is current')).toBe(
      'build b one zero seven three three is current',
    );
  });

  it('reads a quant name as its letters and digits', () => {
    expect(applyLexicon('serving Q3_K_XL.gguf')).toBe('serving Q three K X L G G U F');
  });

  /**
   * Long opaque tokens are the ones with no good spoken form at all. A category
   * word costs one second; the exact value is in the written message.
   */
  it('replaces a hash and an elided id with a category word', () => {
    expect(applyLexicon('at commit 4354239abc1')).toBe('at commit a hash');
    expect(applyLexicon('ID: a15...bdc here')).toBe('I D: an I D here');
  });

  /**
   * The guard that makes the hash rule safe. `decade`, `facade` and `deface`
   * are made entirely of hex letters; requiring a digit is what stops an
   * ordinary English word from being announced as "a hash".
   */
  it('never mistakes an English word for a hash', () => {
    expect(applyLexicon('a decade of facade and deface')).toBe('a decade of facade and deface');
    expect(applyLexicon('the deadbeef cafe')).toBe('the deadbeef cafe');
  });

  it('says a port number as digits', () => {
    expect(applyLexicon('on port 8080')).toBe('on port eight zero eight zero');
  });

  it('keeps the dots audible in a version', () => {
    expect(applyLexicon('version 0.15.13')).toBe('version 0 point 15 point 13');
  });

  it('splits an identifier at its capitals', () => {
    expect(applyLexicon('in RemoteVoiceBridge now')).toBe('in Remote Voice Bridge now');
  });

  /**
   * Ordinary prose must survive untouched. This is the rule that decides
   * whether the feature is worth having: a lexicon that mangles normal
   * sentences to fix technical ones has made the reply worse overall.
   */
  it('leaves ordinary prose alone', () => {
    const prose = 'I restarted the server and every test passed on the first attempt.';
    expect(applyLexicon(prose)).toBe(prose);
    expect(applyLexicon('There are 199 files and 2 failures.')).toBe(
      'There are 199 files and 2 failures.',
    );
  });

  it('speaks Greek terms in Greek', () => {
    expect(applyLexicon('η CUDA δουλεύει', 'el')).toBe('η κούντα δουλεύει');
    expect(applyLexicon('build b10', 'el')).toBe('build b ένα μηδέν');
  });
});

/**
 * The end-to-end shape, on the reply that started this.
 *
 * Structure and vocabulary are separate passes and it is their composition that
 * matters: the path has to collapse to its last segment BEFORE the lexicon
 * sees it, or the lexicon spends its effort spelling directory names.
 */
describe('renderForSpeech with the lexicon', () => {
  it('renders the reply that ran 41 seconds', () => {
    const out = renderForSpeech(
      'Forge is using **llama.cpp build b10733**.\n\n' +
        '- **Config** (`.forge/config.yaml`): `C:/Users/me/AppData/Local/Forge/llama-server.exe`\n' +
        '- **Live process** (PID 6028): serving `Qwen3.8-27B-UD-Q3_K_XL.gguf` on port 8080.',
    );
    expect(out).not.toMatch(/[/\\]/);
    expect(out).toContain('llama C P P build b one zero seven three three');
    expect(out).toContain('port eight zero eight zero');
    // The config filename survives as a name, without its directories.
    expect(out).toContain('config yammle');
  });
});
