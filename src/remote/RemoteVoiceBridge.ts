import { VoiceIngress, type NormalizeStep } from '../voice/VoiceIngress';
import { VoiceOperation } from '../voice/VoiceOperation';
import { admittedFrom, VoiceAuditLog, type VoiceAuditSink } from '../voice/VoiceAudit';
import { VoiceAuditFileSink } from '../voice/VoiceAuditFileSink';
import type { VoiceTranscript, WhisperRunner } from '../voice/VoiceTypes';
import type { ForgeConfig } from '../config/types';
import {
  correlateGate,
  matchVoiceCommand,
  recordingWindow,
  type PendingGate,
  type VoiceCommand,
} from '../voice/VoiceGrammar';
import { PendingVoiceDraft, type DraftResolution } from '../voice/PendingVoiceDraft';
import type { RemoteChannel, RemoteInboundDisposition, RemoteInboundEvent } from './types';
import { buildVoiceBridge as buildVoiceBridgeWiring } from './remoteVoiceWiring';

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

/**
 * What a spoken approve/deny/stop needs, injected per call rather than held.
 *
 * Per call because the approval bridge is created inside `RemoteController`
 * while this bridge is built alongside the channel: passing it at handle time
 * avoids a settable field whose unset state would silently mean "spoken
 * approvals do nothing".
 */
export interface SpokenGateContext {
  readonly gates: readonly PendingGate[];
  /** Auth nonce for this chat; the same one the button path checks. */
  readonly nonce: string | undefined;
  resolve(gateId: string, approve: boolean, nonce: string | undefined): boolean;
  /** Cancels the running turn for `stop`. Absent where nothing is running. */
  cancel?(): boolean;
}

export interface RemoteVoiceBridgeOptions {
  readonly channel: RemoteChannel;
  readonly runner: WhisperRunner;
  readonly audit: VoiceAuditLog;
  readonly drafts: PendingVoiceDraft;
  readonly settings: () => VoiceBridgeSettings;
  readonly withActivity?: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Test seam only; production leaves this unset and gets the real ffmpeg step. */
  readonly normalize?: NormalizeStep | undefined;
}

export interface VoiceBridgeBundle {
  readonly bridge: RemoteVoiceBridge;
  readonly drafts: PendingVoiceDraft;
  dispose(): Promise<void>;
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
    this.ingress = new VoiceIngress(options.runner, options.audit, options.normalize);
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
    spoken?: SpokenGateContext,
  ): Promise<RemoteInboundDisposition> {
    const settings = this.options.settings();
    if (!settings.enabled) {
      return {
        kind: 'rejected',
        reason: 'voice input is disabled (set voice.enabled in config)',
        ephemeral: true,
      };
    }
    if (event.durationMs > settings.maxSeconds * 1000) {
      const seconds = Math.round(event.durationMs / 1000);
      return {
        kind: 'rejected',
        reason: `voice note is ${seconds}s, over the ${settings.maxSeconds}s limit`,
        ephemeral: true,
      };
    }

    const operation = await VoiceOperation.create();
    try {
      return await this.transcribeAndEcho(operation, event, settings, spoken);
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
    spoken?: SpokenGateContext,
  ): Promise<RemoteInboundDisposition> {
    const download = this.options.channel.downloadAttachmentToFile;
    if (!download) {
      await operation.dispose();
      return {
        kind: 'rejected',
        reason: 'this channel cannot download voice notes',
        ephemeral: true,
      };
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
      return { kind: 'rejected', reason: 'voice note is too large', ephemeral: true };
    }
    const source = await operation.adopt(target, mediaType);
    // Cold start is ~4.2 s (§6.1b) and the sender has no other signal that
    // anything is happening. Silence for four seconds after sending a voice note
    // reads as "it was ignored", which is the failure this whole path is prone
    // to being mistaken for.
    await this.say(event.chatId, 'Forge: transcribing voice…');

    const runIngress = (): ReturnType<VoiceIngress['run']> =>
      this.ingress.run(operation, source, {
        surface: 'telegram',
        language: settings.language,
        initialPrompt: settings.biasPrompt,
        audioMs: event.durationMs,
        normalize: { trimSilence: settings.trimSilence, ffmpegPath: settings.ffmpegPath },
        signal: this.options.signal,
      });
    // Residency activity covers normalization as well as the HTTP request, so
    // the idle timer cannot unload the model between those two phases.
    const result = this.options.withActivity
      ? await this.options.withActivity(runIngress)
      : await runIngress();
    if (!result.ok) {
      // `ingress.run` already wrote the terminal audit row; this is the half the
      // user sees. A silent rejection is the `ask_user` failure again -- the
      // sender must never be left wondering whether Forge heard them.
      // The last line of the detail is the actual cause (whisper-cli's stderr ends on it).
      const cause = result.detail.trim().split(/\r?\n/).pop()?.slice(0, 300) ?? '';
      await this.say(
        event.chatId,
        `Forge: could not use that voice note (${result.reason}). ${cause}`.trim(),
      );
      return { kind: 'handled' };
    }

    const command = matchVoiceCommand(result.text);
    if (command && spoken) {
      const handled = await this.runSpokenCommand(operation.id, event, command, spoken);
      if (handled) {
        this.options.audit.admitted(
          admittedFrom(operation.id, result.transcript, {
            audioMs: event.durationMs,
            // A spoken command IS the submission -- there is no draft to confirm.
            autoSubmitted: true,
            editedBeforeSubmit: false,
            grammarMatch: command,
          }),
        );
        return { kind: 'handled' };
      }
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
      `${preamble}Heard: "${result.text}"\n\n/ok to send, /no to discard, or type a replacement message (sent instead of this).`,
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

  /**
   * Applies a matched command to a pending gate, or refuses and says why.
   *
   * Returns false when the utterance should fall through to the draft path --
   * `status` has no gate to resolve, and a command with nothing pending is
   * usually the user dictating an ordinary prompt that happens to be one word.
   *
   * The correlation rule is `correlateGate`: exactly one gate open for the whole
   * recording window, still unresolved, same chat. Anything ambiguous refuses.
   * That is where strictness belongs -- the unambiguous case is the one that
   * keeps this hands-free, which is the only reason spoken approval beats the
   * inline button that is already one tap away.
   */
  private async runSpokenCommand(
    operationId: string,
    event: Extract<RemoteInboundEvent, { kind: 'voice' }>,
    command: VoiceCommand,
    spoken: SpokenGateContext,
  ): Promise<boolean> {
    if (command === 'status') return false;
    if (command === 'stop') {
      if (!spoken.cancel?.()) {
        await this.say(event.chatId, 'Forge: nothing is running to stop.');
        return true;
      }
      await this.say(event.chatId, 'Forge: stopped.');
      return true;
    }
    const window = recordingWindow(event.receivedAt, event.durationMs);
    const correlation = correlateGate(spoken.gates, event.chatId, window, event.replyToMessageId);
    if (correlation.kind === 'not-a-command') return false;
    if (correlation.kind === 'refuse') {
      if (correlation.reason === 'none-open') return false;
      // Ambiguous, never a guess: two gates were open, or one opened or closed
      // while the user was still speaking. Naming the fallback matters -- a bare
      // refusal teaches the user the capability does not work.
      await this.say(
        event.chatId,
        'Forge: more than one approval was in play while you spoke, so I did not ' +
          'act on it. Tap the button on the request, or reply to it directly.',
      );
      this.options.audit.rejected({
        operation_id: operationId,
        reason: 'refusal',
        detail: `ambiguous spoken ${command}: ${spoken.gates.length} gate(s) in window`,
      });
      return true;
    }
    const approve = command === 'approve';
    if (!spoken.resolve(correlation.gate.id, approve, spoken.nonce)) {
      await this.say(event.chatId, 'Forge: that approval is stale — tap the button instead.');
      return true;
    }
    await this.say(event.chatId, `Forge: ${approve ? 'approved' : 'denied'} by voice.`);
    return true;
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
export { buildSpokenGateContext, resolveVoiceDraft } from './remoteVoiceWiring';

export function buildVoiceBridge(
  channel: RemoteChannel,
  config: ForgeConfig,
  sink: VoiceAuditSink = new VoiceAuditFileSink(),
  lifecycle: { confirmServerStart?: ((detail: string) => Promise<boolean>) | undefined } = {},
): VoiceBridgeBundle | undefined {
  return buildVoiceBridgeWiring(
    channel,
    config,
    sink,
    lifecycle,
    (options) => new RemoteVoiceBridge(options),
  );
}
