import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { RemoteVoiceBridge, type VoiceBridgeSettings } from '../../src/remote/RemoteVoiceBridge';
import { PendingVoiceDraft } from '../../src/voice/PendingVoiceDraft';
import { VoiceAuditLog, type VoiceAuditEvent } from '../../src/voice/VoiceAudit';
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
    expect(sent).toHaveLength(1);
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
