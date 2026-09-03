import { VoiceIngress } from '../voice/VoiceIngress';
import { VoiceOperation } from '../voice/VoiceOperation';
import { admittedFrom, VoiceAuditLog, type VoiceAuditSink } from '../voice/VoiceAudit';
import type { VoiceTranscript, WhisperRunner } from '../voice/VoiceTypes';
import { matchVoiceCommand } from '../voice/VoiceGrammar';
import { PendingVoiceDraft, type DraftResolution } from '../voice/PendingVoiceDraft';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { WhisperCppRunner } from '../voice/WhisperCppRunner';
import type { ForgeConfig } from '../config/types';

/**
 * Turns an inbound voice note into a draft the sender confirms, and nothing more.
 *
 * A transcript is never submitted on arrival (§9.5). The default is inverted
 * from the obvious one on purpose: STT is wrong often enough that auto-submit
 * would spend agent turns on misheard prompts, and the echo doubles as the only
 * mitigation for audio that cut off mid-sentence -- the user sees it end
 * mid-thought, which no exit code reports.
 *
 * Voice is I/O around the existing agent loop, never a second agent mode: a
 * confirmed draft re-enters `RemoteController.handle()` as an ordinary text
 * event, so commands, dedup, length limits and the approval gate all apply
 * unchanged and none of them needed a voice-shaped variant.
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §5, §9.5, §9.6, §20.1.
 */

export interface VoiceBridgeSettings {
  readonly enabled: boolean;
  readonly language: string;
  readonly maxBytes: number;
  readonly maxSeconds: number;
  readonly biasPrompt: string;
  readonly trimSilence: boolean;
  readonly ffmpegPath?: string | undefined;
}

export interface RemoteVoiceBridgeOptions {
  readonly channel: RemoteChannel;
  readonly runner: WhisperRunner;
  readonly audit: VoiceAuditLog;
  readonly drafts: PendingVoiceDraft;
  readonly settings: () => VoiceBridgeSettings;
  readonly signal?: AbortSignal | undefined;
}

export class RemoteVoiceBridge {
  private readonly ingress: VoiceIngress;

  /**
   * Transcript metadata for the admitted audit row, which cannot be written
   * until the draft resolves -- `auto_submitted` and `edited_before_submit` are
   * not known any earlier (§20.1). Keyed per chat because the draft store holds
   * one draft per chat, so this cannot grow unbounded.
   */
  private readonly pendingTranscripts = new Map<
    string,
    { transcript: VoiceTranscript; audioMs: number }
  >();

  constructor(private readonly options: RemoteVoiceBridgeOptions) {
    this.ingress = new VoiceIngress(options.runner, options.audit);
  }

  /**
   * Downloads, transcribes and echoes one voice note.
   *
   * The duration gate runs before the download and the size gate before
   * transcription: rejecting a 40-minute note only after paying to fetch and
   * decode it is the same mistake as validating a request body after parsing it.
   */
  async handle(
    event: Extract<RemoteInboundEvent, { kind: 'voice' }>,
  ): Promise<RemoteInboundDisposition> {
    const settings = this.options.settings();
    if (!settings.enabled) {
      return { kind: 'rejected', reason: 'voice input is disabled (set voice.enabled in config)' };
    }
    if (event.durationMs > settings.maxSeconds * 1000) {
      const seconds = Math.round(event.durationMs / 1000);
      return {
        kind: 'rejected',
        reason: `voice note is ${seconds}s, over the ${settings.maxSeconds}s limit`,
      };
    }

    const operation = await VoiceOperation.create();
    try {
      return await this.transcribeAndEcho(operation, event, settings);
    } catch (error) {
      // The operation disposes itself inside `ingress.run`; a failure before
      // that point (download, size gate) has to clean up here, or the audio
      // outlives the operation that owns it.
      await operation.dispose();
      return { kind: 'retry', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async transcribeAndEcho(
    operation: VoiceOperation,
    event: Extract<RemoteInboundEvent, { kind: 'voice' }>,
    settings: VoiceBridgeSettings,
  ): Promise<RemoteInboundDisposition> {
    const download = this.options.channel.downloadAttachmentToFile;
    if (!download) {
      await operation.dispose();
      return { kind: 'rejected', reason: 'this channel cannot download voice notes' };
    }
    const target = operation.reserve('source.audio');
    const { bytes, mediaType } = await download.call(
      this.options.channel,
      event.providerFileId,
      target,
      this.options.signal,
    );
    if (bytes > settings.maxBytes) {
      await operation.dispose();
      this.options.audit.rejected({
        operation_id: operation.id,
        reason: 'oversize',
        detail: `${bytes} bytes exceeds voice.input.max_bytes ${settings.maxBytes}`,
      });
      return { kind: 'rejected', reason: 'voice note is too large' };
    }
    const source = await operation.adopt(target, mediaType);

    const result = await this.ingress.run(operation, source, {
      surface: 'telegram',
      language: settings.language,
      initialPrompt: settings.biasPrompt,
      audioMs: event.durationMs,
      normalize: { trimSilence: settings.trimSilence, ffmpegPath: settings.ffmpegPath },
      signal: this.options.signal,
    });
    if (!result.ok) {
      // `ingress.run` already wrote the terminal audit row; this is the half the
      // user sees. A silent rejection is the `ask_user` failure again -- the
      // sender must never be left wondering whether Forge heard them.
      await this.say(event.chatId, `Forge: could not use that voice note (${result.reason}).`);
      return { kind: 'handled' };
    }

    const { draft, replaced } = this.options.drafts.hold({
      channel: event.channel,
      chatId: event.chatId,
      transcript: result.text,
      operationId: operation.id,
    });
    this.pendingTranscripts.set(draftKey(draft.channel, draft.chatId), {
      transcript: result.transcript,
      audioMs: event.durationMs,
    });
    const preamble = replaced ? 'Forge: replaced your previous draft.\n' : '';
    await this.say(
      event.chatId,
      `${preamble}Heard: "${result.text}"\n\n/ok to send, /no to discard, or type a correction.`,
    );
    return { kind: 'handled' };
  }

  /**
   * Closes out a resolved draft, writing the terminal `admitted` row.
   *
   * Returns the text to run, or undefined when the draft was discarded or there
   * was none. The caller re-enters the ordinary text path with it.
   */
  finishDraft(resolution: DraftResolution): string | undefined {
    if (resolution.kind === 'none') return undefined;
    const key = draftKey(resolution.draft.channel, resolution.draft.chatId);
    const pending = this.pendingTranscripts.get(key);
    this.pendingTranscripts.delete(key);
    if (resolution.kind === 'discard') {
      this.options.audit.rejected({
        operation_id: resolution.draft.operationId,
        reason: 'cancelled',
        detail: 'sender discarded the draft',
      });
      return undefined;
    }
    if (pending) {
      this.options.audit.admitted(
        admittedFrom(resolution.draft.operationId, pending.transcript, {
          audioMs: pending.audioMs,
          // Always false: §9.5 has no auto-submit path. The field exists so that
          // a future one is visible in the log rather than indistinguishable.
          autoSubmitted: false,
          editedBeforeSubmit: resolution.edited,
          grammarMatch: matchVoiceCommand(resolution.text) ?? null,
        }),
      );
    }
    return resolution.text;
  }

  private async say(chatId: string, text: string): Promise<void> {
    await this.options.channel
      .send(chatId, text, { ...(this.options.signal ? { signal: this.options.signal } : {}) })
      .catch(() => undefined);
  }
}

function draftKey(channel: string, chatId: string): string {
  return `${channel} ${chatId}`;
}

/**
 * Builds the bridge from config, or returns undefined when voice is off.
 *
 * Undefined rather than a disabled instance: an absent bridge makes the
 * controller's voice branch statically dead when the feature is off, so a
 * misconfigured install cannot spawn a transcription process at all.
 *
 * Both paths must be set. A default guess at where a 3 GB model lives would
 * fail at record time with a bare non-zero exit, which is exactly the hidden
 * fallback the no-fallbacks rule exists to prevent.
 */
export function buildVoiceBridge(
  channel: RemoteChannel,
  config: ForgeConfig,
  sink: VoiceAuditSink = { write: () => undefined },
): { bridge: RemoteVoiceBridge; drafts: PendingVoiceDraft } | undefined {
  const voice = config.voice;
  if (voice?.enabled !== true) return undefined;
  if (!voice.whisper_binary || !voice.whisper_model) return undefined;
  const drafts = new PendingVoiceDraft();
  const bridge = new RemoteVoiceBridge({
    channel,
    runner: new WhisperCppRunner({ binary: voice.whisper_binary, model: voice.whisper_model }),
    audit: new VoiceAuditLog(sink),
    drafts,
    settings: () => voiceSettings(config),
  });
  return { bridge, drafts };
}

/** Reads the `voice:` block every call, so a config reload takes effect. */
function voiceSettings(config: ForgeConfig): VoiceBridgeSettings {
  const voice = config.voice ?? {};
  return {
    enabled: voice.enabled === true,
    language: voice.language ?? 'auto',
    maxBytes: voice.input?.max_bytes ?? 25 * 1024 * 1024,
    maxSeconds: voice.input?.max_seconds ?? 300,
    biasPrompt: voice.bias_prompt ?? '',
    trimSilence: voice.trim_silence !== false,
    ...(config.video?.ffmpeg_path ? { ffmpegPath: config.video.ffmpeg_path } : {}),
  };
}
