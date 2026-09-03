import { describe, expect, it } from 'vitest';
import { PendingVoiceDraft } from '../../src/voice/PendingVoiceDraft';
import {
  correlateGate,
  matchVoiceCommand,
  recordingWindow,
  type PendingGate,
} from '../../src/voice/VoiceGrammar';

const CHAT = { channel: 'telegram', chatId: '42' };

function draftInput(transcript: string) {
  return { ...CHAT, transcript, operationId: 'v_1' };
}

describe('PendingVoiceDraft', () => {
  it('/ok sends the transcript unchanged', () => {
    const drafts = new PendingVoiceDraft();
    drafts.hold(draftInput('restart the backend'));

    const result = drafts.resolve(CHAT.channel, CHAT.chatId, '/ok');

    expect(result).toMatchObject({ kind: 'send', text: 'restart the backend', edited: false });
  });

  it('/no discards and creates no prompt', () => {
    const drafts = new PendingVoiceDraft();
    drafts.hold(draftInput('restart the backend'));

    expect(drafts.resolve(CHAT.channel, CHAT.chatId, '/no')).toMatchObject({ kind: 'discard' });
    expect(drafts.peek(CHAT.channel, CHAT.chatId)).toBeUndefined();
  });

  it('ordinary text becomes the corrected prompt, so editing needs no verb', () => {
    const drafts = new PendingVoiceDraft();
    drafts.hold(draftInput('restart the backhand'));

    const result = drafts.resolve(CHAT.channel, CHAT.chatId, 'restart the backend');

    expect(result).toMatchObject({ kind: 'send', text: 'restart the backend', edited: true });
  });

  it('a second voice note replaces the first and reports what it replaced', () => {
    const drafts = new PendingVoiceDraft();
    drafts.hold(draftInput('first'));

    const { replaced } = drafts.hold(draftInput('second'));

    expect(replaced?.transcript).toBe('first');
    expect(drafts.peek(CHAT.channel, CHAT.chatId)?.transcript).toBe('second');
  });

  it('an expired draft admits nothing', () => {
    const drafts = new PendingVoiceDraft(1000);
    drafts.hold(draftInput('stale'), 0);

    expect(drafts.peek(CHAT.channel, CHAT.chatId, 5000)).toBeUndefined();
    expect(drafts.resolve(CHAT.channel, CHAT.chatId, '/ok', 5000)).toMatchObject({ kind: 'none' });
  });

  it('clearing a channel drops drafts, so none survives re-auth', () => {
    const drafts = new PendingVoiceDraft();
    drafts.hold(draftInput('pending'));

    drafts.clearChannel('telegram');

    expect(drafts.peek(CHAT.channel, CHAT.chatId)).toBeUndefined();
  });

  it('holds one draft per chat independently', () => {
    const drafts = new PendingVoiceDraft();
    drafts.hold(draftInput('for 42'));
    drafts.hold({ ...draftInput('for 99'), chatId: '99' });

    expect(drafts.peek('telegram', '42')?.transcript).toBe('for 42');
    expect(drafts.peek('telegram', '99')?.transcript).toBe('for 99');
  });
});

describe('matchVoiceCommand', () => {
  it.each(['approve', 'Approve.', 'ναι', 'ΕΝΤΑΞΕΙ'])('matches %s as approve', (text) => {
    expect(matchVoiceCommand(text)).toBe('approve');
  });

  it.each(['deny', 'no', 'όχι'])('matches %s as deny', (text) => {
    expect(matchVoiceCommand(text)).toBe('deny');
  });

  // The whole point of whole-utterance matching. A false match here authorizes
  // an action; a missed match merely sends a prompt.
  it.each([
    'do not approve that',
    'I said no, not yes',
    'approve the pull request when tests pass',
    'stop after this finishes',
    'μην εγκρίνεις',
    'do not cancel',
  ])('refuses to match the negation %s', (text) => {
    expect(matchVoiceCommand(text)).toBeUndefined();
  });

  it('ignores an empty or whitespace utterance', () => {
    expect(matchVoiceCommand('   ')).toBeUndefined();
  });
});

describe('correlateGate', () => {
  const window = recordingWindow(10_000, 3_000); // spoken across [7000, 10000]

  const gate = (over: Partial<PendingGate> = {}): PendingGate => ({
    id: 'g1',
    chatId: '42',
    openedAt: 1_000,
    ...over,
  });

  it('resolves when exactly one gate spanned the whole recording window', () => {
    expect(correlateGate([gate()], '42', window)).toMatchObject({
      kind: 'resolve',
      gate: { id: 'g1' },
    });
  });

  it('refuses when no gate is open', () => {
    expect(correlateGate([], '42', window)).toMatchObject({ kind: 'refuse', reason: 'none-open' });
  });

  it('refuses when two gates were open, rather than guessing', () => {
    const gates = [gate(), gate({ id: 'g2' })];
    expect(correlateGate(gates, '42', window)).toMatchObject({
      kind: 'refuse',
      reason: 'ambiguous',
    });
  });

  // The race R1 exists to close: the user cannot have meant a gate that opened
  // while they were already speaking.
  it('refuses when a gate opened mid-recording', () => {
    const gates = [gate(), gate({ id: 'g2', openedAt: 8_000 })];
    expect(correlateGate(gates, '42', window)).toMatchObject({
      kind: 'refuse',
      reason: 'ambiguous',
    });
  });

  it('refuses when a gate resolved mid-recording', () => {
    const gates = [gate(), gate({ id: 'g2', openedAt: 500, resolvedAt: 9_000 })];
    expect(correlateGate(gates, '42', window)).toMatchObject({
      kind: 'refuse',
      reason: 'ambiguous',
    });
  });

  it('ignores an already-resolved gate', () => {
    expect(correlateGate([gate({ resolvedAt: 2_000 })], '42', window)).toMatchObject({
      kind: 'refuse',
      reason: 'none-open',
    });
  });

  it('ignores gates belonging to another chat', () => {
    expect(correlateGate([gate({ chatId: '99' })], '42', window)).toMatchObject({
      kind: 'refuse',
      reason: 'none-open',
    });
  });

  it('an explicit reply wins over the timing heuristic', () => {
    const gates = [gate(), gate({ id: 'g2' })];
    expect(correlateGate(gates, '42', window, 'g2')).toMatchObject({
      kind: 'resolve',
      gate: { id: 'g2' },
    });
  });

  it('a reply to a resolved gate still refuses', () => {
    expect(correlateGate([gate({ resolvedAt: 5 })], '42', window, 'g1')).toMatchObject({
      kind: 'refuse',
    });
  });
});
