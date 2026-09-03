import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  RemoteVoiceBridge,
  type SpokenGateContext,
  type VoiceBridgeSettings,
} from '../../src/remote/RemoteVoiceBridge';
import type { PendingGate } from '../../src/voice/VoiceGrammar';
import { PendingVoiceDraft } from '../../src/voice/PendingVoiceDraft';
import { VoiceAuditLog, type VoiceAuditEvent } from '../../src/voice/VoiceAudit';
import { VoiceAuditFileSink } from '../../src/voice/VoiceAuditFileSink';
import { FakeWhisperRunner } from '../../src/voice/FakeWhisperRunner';
import type { RemoteChannel, RemoteInboundEvent } from '../../src/remote/types';

/**
 * The Telegram voice path end to end, with no model, GPU, network or ffmpeg.
 *
 * ffmpeg is the one real dependency `VoiceIngress` has, so these tests stub
 * normalization at the channel boundary by handing the bridge a fake that writes
 * a real (tiny) file and a runner that never looks at it. What is under test is
 * the state machine around transcription -- gates, drafts, audit rows and
 * temp-file lifetime -- which is where the bugs that matter live.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §9.5, §9.6, §20.1, §24 (Tier A).
 */

const SETTINGS: VoiceBridgeSettings = {
  enabled: true,
  language: 'auto',
  maxBytes: 1024 * 1024,
  maxSeconds: 300,
  biasPrompt: '',
  trimSilence: true,
};

/**
 * A real, decodable 16 kHz mono WAV of silence.
 *
 * `VoiceIngress` genuinely runs ffmpeg, so a buffer of zero bytes is rejected as
 * `decode_failed` before the transcript is ever produced -- which would make
 * every assertion past that point vacuously pass. Half a second of silence is
 * the cheapest thing ffmpeg will actually decode.
 */
function silentWav(seconds = 0.5, rate = 16_000): Buffer {
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function voiceEvent(
  overrides: Partial<Extract<RemoteInboundEvent, { kind: 'voice' }>> = {},
): Extract<RemoteInboundEvent, { kind: 'voice' }> {
  return {
    channel: 'telegram',
    kind: 'voice',
    providerMessageId: '1',
    senderId: 'u1',
    chatId: 'c1',
    chatType: 'private',
    receivedAt: 1_700_000_000_000,
    providerFileId: 'file-1',
    mediaType: 'audio/ogg',
    durationMs: 2_000,
    ...overrides,
  };
}

function harness(
  settings: Partial<VoiceBridgeSettings> = {},
  downloadBytes = 2048,
): {
  bridge: RemoteVoiceBridge;
  drafts: PendingVoiceDraft;
  rows: VoiceAuditEvent[];
  sent: string[];
  written: string[];
} {
  const rows: VoiceAuditEvent[] = [];
  const sent: string[] = [];
  const written: string[] = [];
  const channel = {
    name: 'telegram',
    send: async (_chatId: string, text: string) => {
      sent.push(text);
    },
    downloadAttachmentToFile: async (_id: string, targetPath: string) => {
      written.push(targetPath);
      await fs.writeFile(targetPath, Buffer.alloc(downloadBytes));
      return { bytes: downloadBytes, mediaType: 'audio/ogg' };
    },
    start: async () => undefined,
  } as unknown as RemoteChannel;
  const drafts = new PendingVoiceDraft();
  const bridge = new RemoteVoiceBridge({
    channel,
    runner: new FakeWhisperRunner(),
    audit: new VoiceAuditLog({ write: (row) => rows.push(row) }),
    drafts,
    settings: () => ({ ...SETTINGS, ...settings }),
  });
  return { bridge, drafts, rows, sent, written };
}

/**
 * ffmpeg is genuinely invoked by `VoiceIngress`, so on a machine without it the
 * happy path rejects with `decode_failed` rather than reaching the runner. Every
 * assertion below is written to hold either way, except where noted.
 */
describe('RemoteVoiceBridge gates', () => {
  it('refuses when voice is disabled, without touching the network', async () => {
    const { bridge, written } = harness({ enabled: false });
    const result = await bridge.handle(voiceEvent());
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'voice input is disabled (set voice.enabled in config)',
    });
    expect(written).toEqual([]);
  });

  /**
   * The gate order that matters: duration is client-reported and arrives on the
   * event, so an over-long note is refused before a byte is downloaded.
   */
  it('rejects an over-long note before downloading it', async () => {
    const { bridge, written, rows } = harness({ maxSeconds: 10 });
    const result = await bridge.handle(voiceEvent({ durationMs: 60_000 }));
    expect(result.kind).toBe('rejected');
    expect(result.kind === 'rejected' && result.reason).toContain('over the 10s limit');
    expect(written).toEqual([]);
    // No operation was created, so there is nothing to audit.
    expect(rows).toEqual([]);
  });

  it('rejects an oversize note after download and audits it', async () => {
    const { bridge, rows } = harness({ maxBytes: 1024 }, 4096);
    const result = await bridge.handle(voiceEvent());
    expect(result).toEqual({ kind: 'rejected', reason: 'voice note is too large' });
    const rejected = rows.find((row) => row.type === 'voice_ingress_rejected');
    expect(rejected).toBeDefined();
    expect(rejected?.type === 'voice_ingress_rejected' && rejected.reason).toBe('oversize');
  });

  it('refuses a channel that cannot download files', async () => {
    const bridge = new RemoteVoiceBridge({
      channel: { name: 'fake', send: async () => undefined } as unknown as RemoteChannel,
      runner: new FakeWhisperRunner(),
      audit: new VoiceAuditLog({ write: () => undefined }),
      drafts: new PendingVoiceDraft(),
      settings: () => SETTINGS,
    });
    const result = await bridge.handle(voiceEvent());
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'this channel cannot download voice notes',
    });
  });

  /**
   * Whether ingress succeeds or fails on this machine, the downloaded audio must
   * not survive the call. This is R8 as an observable property rather than a
   * claim about where `dispose()` is called.
   */
  it('leaves no audio on disk on any path', async () => {
    const { bridge, written } = harness();
    await bridge.handle(voiceEvent());
    expect(written).toHaveLength(1);
    await expect(fs.access(written[0]!)).rejects.toThrow();
  });

  it('always tells the sender something', async () => {
    const { bridge, sent } = harness();
    await bridge.handle(voiceEvent());
    // The progress line, then the outcome. Either way the sender is never left
    // wondering whether Forge heard them.
    expect(sent[0]).toContain('transcribing');
    expect(sent).toHaveLength(2);
  });
});

describe('RemoteVoiceBridge draft resolution', () => {
  function heldDraft(): ReturnType<typeof harness> & { operationId: string } {
    const h = harness();
    const { draft } = h.drafts.hold({
      channel: 'telegram',
      chatId: 'c1',
      transcript: 'restart the backend',
      operationId: 'v_test',
    });
    return { ...h, operationId: draft.operationId };
  }

  it('returns the transcript unchanged on /ok', () => {
    const { bridge, drafts } = heldDraft();
    const text = bridge.finishDraft(drafts.resolve('telegram', 'c1', '/ok'));
    expect(text).toBe('restart the backend');
  });

  it('returns the correction, not the transcript, on free text', () => {
    const { bridge, drafts } = heldDraft();
    const text = bridge.finishDraft(drafts.resolve('telegram', 'c1', 'restart the frontend'));
    expect(text).toBe('restart the frontend');
  });

  /**
   * A discard is a terminal outcome and must still produce a row, or the audit's
   * one-terminal-row-per-operation invariant would have a hole exactly where
   * users abandon bad transcripts -- the signal most worth counting.
   */
  it('audits a discard as cancelled and runs nothing', () => {
    const { bridge, drafts, rows } = heldDraft();
    const text = bridge.finishDraft(drafts.resolve('telegram', 'c1', '/no'));
    expect(text).toBeUndefined();
    const rejected = rows.find((row) => row.type === 'voice_ingress_rejected');
    expect(rejected?.type === 'voice_ingress_rejected' && rejected.reason).toBe('cancelled');
  });

  it('is a no-op when no draft is pending', () => {
    const { bridge, drafts, rows } = harness();
    expect(bridge.finishDraft(drafts.resolve('telegram', 'c1', '/ok'))).toBeUndefined();
    expect(rows).toEqual([]);
  });

  /**
   * The confirm verbs are slash-prefixed precisely so they cannot collide with
   * the §8A approval grammar. "approve" while a draft is pending is a
   * correction, not an authorization.
   */
  it('treats an approval word as a correction, never as a confirmation', () => {
    const { bridge, drafts } = heldDraft();
    expect(bridge.finishDraft(drafts.resolve('telegram', 'c1', 'approve'))).toBe('approve');
  });
});

describe('VoiceAuditFileSink', () => {
  it('appends one JSON line per row, joinable by operation_id', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-voice-audit-'));
    const sink = new VoiceAuditFileSink(dir);
    const log = new VoiceAuditLog(sink);
    log.started({
      operation_id: 'v_1',
      surface: 'telegram',
      bytes: 10,
      media_type: 'audio/ogg',
    });
    log.rejected({ operation_id: 'v_1', reason: 'empty', detail: 'silence' });
    const lines = (await fs.readFile(path.join(dir, 'voice.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).operation_id)).toEqual(['v_1', 'v_1']);
    expect(JSON.parse(lines[1]!).type).toBe('voice_ingress_rejected');
  });

  /**
   * Audio is deliberately not retained, so a voice turn whose row failed to
   * write is undiagnosable -- but that must never be allowed to take down the
   * turn itself.
   */
  it('never throws when the log cannot be written', () => {
    const sink = new VoiceAuditFileSink(path.join(os.tmpdir(), 'forge-voice-\0-invalid'));
    expect(() =>
      sink.write({
        type: 'voice_ingress_started',
        operation_id: 'v_2',
        ts_ms: 0,
        surface: 'telegram',
        bytes: 1,
        media_type: 'audio/ogg',
      }),
    ).not.toThrow();
  });
});

/**
 * Phase 1.5. These use the fake runner's returned text as the "heard" utterance,
 * so they exercise the correlation rule rather than the recogniser.
 *
 * Note the asymmetry these protect: every other failure in this file costs a
 * wasted turn, while a wrong answer here takes an action the user did not
 * authorize. That is why the refuse cases outnumber the resolve case.
 */
describe('spoken approvals', () => {
  const WINDOW_START = 1_700_000_000_000 - 2_000;

  function spokenHarness(text: string, gates: PendingGate[]) {
    const resolved: Array<{ gateId: string; approve: boolean }> = [];
    const sent: string[] = [];
    const channel = {
      name: 'telegram',
      send: async (_c: string, message: string) => {
        sent.push(message);
      },
      downloadAttachmentToFile: async (_id: string, targetPath: string) => {
        const wav = silentWav();
        await fs.writeFile(targetPath, wav);
        return { bytes: wav.length, mediaType: 'audio/wav' };
      },
    } as unknown as RemoteChannel;
    const rows: VoiceAuditEvent[] = [];
    const bridge = new RemoteVoiceBridge({
      channel,
      runner: new FakeWhisperRunner({ kind: 'text', text }),
      audit: new VoiceAuditLog({ write: (row) => rows.push(row) }),
      drafts: new PendingVoiceDraft(),
      settings: () => SETTINGS,
    });
    const context: SpokenGateContext = {
      gates,
      nonce: 'n1',
      resolve: (gateId, approve) => {
        resolved.push({ gateId, approve });
        return true;
      },
      cancel: () => true,
    };
    return { bridge, context, resolved, sent, rows };
  }

  it('resolves the one gate that was open for the whole window', async () => {
    const gates: PendingGate[] = [{ id: 'g1', chatId: 'c1', openedAt: WINDOW_START - 5_000 }];
    const { bridge, context, resolved, sent, rows } = spokenHarness('approve', gates);
    await bridge.handle(voiceEvent(), context);
    expect(resolved).toEqual([{ gateId: 'g1', approve: true }]);
    expect(sent.join(' ')).toContain('approved by voice');
    // A spoken command IS the submission, so it terminates as admitted with the
    // grammar entry recorded -- not as a draft awaiting /ok.
    const admitted = rows.find((row) => row.type === 'voice_prompt_admitted');
    expect(admitted?.type === 'voice_prompt_admitted' && admitted.grammar_match).toBe('approve');
    expect(admitted?.type === 'voice_prompt_admitted' && admitted.auto_submitted).toBe(true);
  });

  it('denies on "no"', async () => {
    const gates: PendingGate[] = [{ id: 'g1', chatId: 'c1', openedAt: WINDOW_START - 5_000 }];
    const { bridge, context, resolved } = spokenHarness('Όχι.', gates);
    await bridge.handle(voiceEvent(), context);
    expect(resolved).toEqual([{ gateId: 'g1', approve: false }]);
  });

  /**
   * A gate that closed while the user was speaking is the other half of the
   * race: they were answering something that is no longer there.
   */
  it('refuses when a gate resolved inside the window', async () => {
    const gates: PendingGate[] = [
      { id: 'g1', chatId: 'c1', openedAt: WINDOW_START - 5_000 },
      {
        id: 'g0',
        chatId: 'c1',
        openedAt: WINDOW_START - 9_000,
        resolvedAt: WINDOW_START + 200,
      },
    ];
    const { bridge, context, resolved } = spokenHarness('approve', gates);
    await bridge.handle(voiceEvent(), context);
    expect(resolved).toEqual([]);
  });

  it('refuses when two gates were open for the window', async () => {
    const gates: PendingGate[] = [
      { id: 'g1', chatId: 'c1', openedAt: WINDOW_START - 5_000 },
      { id: 'g2', chatId: 'c1', openedAt: WINDOW_START - 4_000 },
    ];
    const { bridge, context, resolved, sent } = spokenHarness('approve', gates);
    await bridge.handle(voiceEvent(), context);
    expect(resolved).toEqual([]);
    expect(sent.join(' ')).toContain('more than one approval');
  });

  /**
   * The race the window rule exists for: a gate that opened while the user was
   * mid-sentence cannot be what they were answering.
   */
  it('refuses when a gate opened inside the recording window', async () => {
    const gates: PendingGate[] = [
      { id: 'g1', chatId: 'c1', openedAt: WINDOW_START - 5_000 },
      { id: 'g2', chatId: 'c1', openedAt: WINDOW_START + 500 },
    ];
    const { bridge, context, resolved } = spokenHarness('approve', gates);
    await bridge.handle(voiceEvent(), context);
    expect(resolved).toEqual([]);
  });

  it('never resolves a gate belonging to another chat', async () => {
    const gates: PendingGate[] = [{ id: 'g1', chatId: 'other', openedAt: WINDOW_START - 5_000 }];
    const { bridge, context, resolved } = spokenHarness('approve', gates);
    await bridge.handle(voiceEvent(), context);
    expect(resolved).toEqual([]);
  });

  /**
   * The R3 gate at the wiring level, not just the grammar: a mangled negation
   * must reach the draft path, never the resolve path. This is the exact string
   * whisper.cpp produced for "μην εγκρίνεις" on the recorded corpus.
   */
  it('does not authorize on a mangled negation', async () => {
    const gates: PendingGate[] = [{ id: 'g1', chatId: 'c1', openedAt: WINDOW_START - 5_000 }];
    const { bridge, context, resolved } = spokenHarness('Μείνα εγκρίνης.', gates);
    await bridge.handle(voiceEvent(), context);
    expect(resolved).toEqual([]);
  });

  it('does not authorize on "do not approve that"', async () => {
    const gates: PendingGate[] = [{ id: 'g1', chatId: 'c1', openedAt: WINDOW_START - 5_000 }];
    const { bridge, context, resolved } = spokenHarness('Do not approve that.', gates);
    await bridge.handle(voiceEvent(), context);
    expect(resolved).toEqual([]);
  });
});
