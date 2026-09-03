import * as fs from 'fs/promises';
import * as os from 'os';
import { describe, expect, it } from 'vitest';
import { FakeWhisperRunner } from '../../src/voice/FakeWhisperRunner';
import { PendingVoiceDraft } from '../../src/voice/PendingVoiceDraft';
import {
  acceptTranscript,
  looksLikeTranscriptionRefusal,
  stripMarkers,
  stripPromptEcho,
} from '../../src/voice/TranscriptAcceptance';
import { admittedFrom, VoiceAuditLog, type VoiceAuditEvent } from '../../src/voice/VoiceAudit';
import { VoiceIngress } from '../../src/voice/VoiceIngress';
import { VoiceOperation } from '../../src/voice/VoiceOperation';
import type { VoiceTranscript } from '../../src/voice/VoiceTypes';

/**
 * The one-terminal-row invariant spans ingress AND the draft: ingress cannot
 * know `edited_before_submit`, and a successful ingress whose draft expires
 * must still terminate. These tests drive both halves together, which is the
 * only place the invariant is actually observable.
 */

const CHAT = { channel: 'telegram', chatId: '42' };

async function silentWav(operation: VoiceOperation): Promise<string> {
  const target = operation.reserve('input.wav');
  const data = Buffer.alloc(16000 * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  await fs.writeFile(target, Buffer.concat([header, data]));
  return target;
}

/** Runs ingress with the fake runner and holds the resulting draft. */
async function ingestToDraft(
  spoken: string,
  events: VoiceAuditEvent[],
): Promise<{
  log: VoiceAuditLog;
  drafts: PendingVoiceDraft;
  operationId: string;
  transcript: VoiceTranscript;
}> {
  const log = new VoiceAuditLog({ write: (event) => events.push(event) });
  const operation = await VoiceOperation.create(os.tmpdir());
  const source = await operation.adopt(await silentWav(operation), 'audio/wav');
  const runner = new FakeWhisperRunner().enqueue({ kind: 'text', text: spoken });
  const result = await new VoiceIngress(runner, log).run(operation, source, {
    surface: 'telegram',
    language: 'auto',
  });
  if (!result.ok) throw new Error(`expected ingress to accept: ${result.reason}`);
  const drafts = new PendingVoiceDraft();
  drafts.hold({ ...CHAT, transcript: result.text, operationId: operation.id });
  return { log, drafts, operationId: operation.id, transcript: result.transcript };
}

describe('voice terminal-row pairing', () => {
  it('records edited_before_submit=false when the transcript is sent as heard', async () => {
    const events: VoiceAuditEvent[] = [];
    const { log, drafts, operationId, transcript } = await ingestToDraft(
      'restart the backend',
      events,
    );

    const resolved = drafts.resolve(CHAT.channel, CHAT.chatId, '/ok');
    expect(resolved.kind).toBe('send');
    if (resolved.kind !== 'send') return;
    log.admitted(
      admittedFrom(operationId, transcript, {
        autoSubmitted: false,
        editedBeforeSubmit: resolved.edited,
        grammarMatch: null,
      }),
    );

    expect(events.map((event) => event.type)).toEqual([
      'voice_ingress_started',
      'voice_prompt_admitted',
    ]);
    expect(events.at(-1)).toMatchObject({ edited_before_submit: false, grammar_match: null });
  });

  it('records edited_before_submit=true when the user corrects it', async () => {
    const events: VoiceAuditEvent[] = [];
    const { log, drafts, operationId, transcript } = await ingestToDraft(
      'restart the backhand',
      events,
    );

    const resolved = drafts.resolve(CHAT.channel, CHAT.chatId, 'restart the backend');
    if (resolved.kind !== 'send') throw new Error('expected send');
    log.admitted(
      admittedFrom(operationId, transcript, {
        autoSubmitted: false,
        editedBeforeSubmit: resolved.edited,
        grammarMatch: null,
      }),
    );

    expect(resolved.text).toBe('restart the backend');
    expect(events.at(-1)).toMatchObject({ edited_before_submit: true });
  });

  it('a discarded draft terminates as draft_expired, never as admitted', async () => {
    const events: VoiceAuditEvent[] = [];
    const { log, drafts, operationId } = await ingestToDraft('restart the backend', events);

    const resolved = drafts.resolve(CHAT.channel, CHAT.chatId, '/no');
    expect(resolved.kind).toBe('discard');
    log.rejected({ operation_id: operationId, reason: 'draft_expired', detail: 'discarded' });

    expect(log.isTerminal(operationId)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'voice_ingress_rejected' });
  });

  it('refuses to write a second terminal row across the two halves', async () => {
    const events: VoiceAuditEvent[] = [];
    const { log, operationId, transcript } = await ingestToDraft('restart the backend', events);
    const row = admittedFrom(operationId, transcript, {
      autoSubmitted: true,
      editedBeforeSubmit: false,
      grammarMatch: null,
    });

    log.admitted(row);

    expect(() => log.admitted(row)).toThrow(/already has a terminal/);
  });
});

describe('transcript acceptance helpers', () => {
  it('strips silence markers without touching real words', () => {
    expect(stripMarkers('[BLANK_AUDIO] restart the backend')).toBe('restart the backend');
  });

  it('strips only a leading prompt echo', () => {
    expect(stripPromptEcho('Transcription: restart')).toBe('restart');
    // Mid-sentence, the same word is the user's.
    expect(stripPromptEcho('explain the transcription: flow')).toBe(
      'explain the transcription: flow',
    );
  });

  it('treats a long sentence that opens like a refusal as real speech', () => {
    const dictated = `I cannot transcribe this audio ${'and here is a long dictated sentence '.repeat(8)}`;
    expect(looksLikeTranscriptionRefusal(dictated)).toBe(false);
  });

  it('accepts ordinary Greek speech unchanged', () => {
    expect(acceptTranscript('ξεκίνα τον διακομιστή')).toMatchObject({
      ok: true,
      text: 'ξεκίνα τον διακομιστή',
    });
  });
});
