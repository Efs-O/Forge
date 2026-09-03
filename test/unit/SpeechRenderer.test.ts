import { describe, expect, it } from 'vitest';
import { isWorthSpeaking, renderForSpeech } from '../../src/voice/SpeechRenderer';

/**
 * What separates a usable spoken reply from an unusable one.
 *
 * Every case here is something Piper would otherwise pronounce literally, and
 * literal pronunciation of a coding reply is not a degraded feature -- it is a
 * reason to switch the feature off. So these are quality assertions, not
 * correctness ones, and they are the point of the module.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §12, §13.
 */
describe('renderForSpeech', () => {
  it('summarizes a fenced code block instead of reading it', () => {
    const out = renderForSpeech('Fixed it:\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nDone.');
    expect(out).toContain('Code block, 2 lines');
    expect(out).not.toContain('const');
  });

  it('counts a one-line block in the singular', () => {
    expect(renderForSpeech('```\nnpm run ci\n```')).toContain('One line of code');
  });

  /**
   * A truncated reply ends mid-fence. Reading the tail as prose would speak raw
   * source; saying it is code is both shorter and true.
   */
  it('handles an unterminated fence', () => {
    const out = renderForSpeech('Here:\n\n```ts\nconst a = 1;\nconst b =');
    expect(out).not.toContain('const');
  });

  /**
   * Inline code is the opposite case: `npm run ci` is exactly what the listener
   * needs to hear. Only the backticks go.
   */
  it('keeps inline code content and drops the backticks', () => {
    // The backticks go; the content stays and is then spoken properly -- `npm`
    // as three letters rather than an attempt at the word "nppm" (§14).
    expect(renderForSpeech('Run `npm run ci` first.')).toBe('Run N P M run C I first.');
  });

  it('speaks the last path segment, not the whole path', () => {
    // The identifier is also split at its capitals: espeak runs an unsplit
    // `RemoteVoiceBridge` together into one unsayable word.
    const out = renderForSpeech('See src/remote/RemoteVoiceBridge.ts for details.');
    expect(out).toBe('See Remote Voice Bridge T S for details.');
  });

  /**
   * The drive letter has to go with the rest of the path. It did not: written
   * as an optional prefix, the drive matched empty, the match began at the
   * first directory, and the drive root survived to be read aloud as
   * "C colon backslash". Both old assertions passed anyway -- the residue was
   * in neither of them.
   */
  it('handles Windows paths too, drive letter included', () => {
    expect(renderForSpeech('Open C:\\Users\\me\\notes.txt now.')).toBe('Open notes text now.');
  });

  it('says a link exists rather than spelling a URL', () => {
    expect(renderForSpeech('See https://example.com/a/b?c=1 now.')).toBe('See a link now.');
  });

  it('keeps a markdown link label and drops its target', () => {
    expect(renderForSpeech('See [the plan](docs/PLAN.md) now.')).toBe('See the plan now.');
  });

  it('strips emphasis and headings', () => {
    expect(renderForSpeech('## Result\n\n**All** tests _pass_.')).toBe('Result. All tests pass.');
  });

  /**
   * The trap in stripping emphasis: an underscore inside an identifier is not
   * markup. `max_tool_rounds` must survive intact.
   */
  it('does not treat snake_case as emphasis', () => {
    // Not emphasis, and not one word either: the underscores separate spoken
    // words. What must never happen is the middle being eaten as italics.
    expect(renderForSpeech('Set max_tool_rounds higher.')).toBe('Set max tool rounds higher.');
  });

  it('replaces a table rather than reading its pipes', () => {
    const out = renderForSpeech('Results:\n\n| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).not.toContain('|');
    expect(out).toContain('A table');
  });

  /**
   * The bullet goes, but the item boundary must not: run together as "one two",
   * a list becomes one breathless clause with no pause where the eye saw a new
   * line.
   */
  it('flattens list markers into sentences', () => {
    expect(renderForSpeech('- one\n- two')).toBe('one. two.');
  });

  /**
   * A spoken reply that stops mid-sentence is indistinguishable from a crash --
   * there is no visible ellipsis to reassure the listener.
   */
  it('truncates at a sentence boundary and says so', () => {
    const long = `${'This is a full sentence about the backend. '.repeat(20)}`;
    const out = renderForSpeech(long, { maxChars: 200 });
    expect(out.length).toBeLessThan(280);
    expect(out).toContain('The rest is in the message');
    expect(out).toMatch(/backend\. The rest/);
  });

  it('renders Greek replies with Greek placeholders', () => {
    const out = renderForSpeech('Έτοιμο:\n\n```\nx\n```', { language: 'el' });
    expect(out).toContain('Μία γραμμή κώδικα');
  });
});

describe('isWorthSpeaking', () => {
  /**
   * "Code block, 12 lines." with no surrounding sentence is noise, not a reply.
   * Sending no audio is the better outcome.
   */
  it('rejects a reply that rendered down to almost nothing', () => {
    expect(isWorthSpeaking(renderForSpeech('```\nx = 1\n```'))).toBe(false);
    expect(isWorthSpeaking(renderForSpeech('`ok`'))).toBe(false);
  });

  it('accepts a real sentence', () => {
    expect(isWorthSpeaking(renderForSpeech('The tests all pass now.'))).toBe(true);
  });
});
