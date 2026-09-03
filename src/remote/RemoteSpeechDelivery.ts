import { encodeToOpus } from '../voice/AudioNormalizer';
import { PiperRunner, type PiperOptions } from '../voice/PiperRunner';
import { isWorthSpeaking, renderForSpeech } from '../voice/SpeechRenderer';
import { VoiceOperation } from '../voice/VoiceOperation';
import { stripConversationIdentity } from './RemoteReplyIdentity';
import type { ForgeConfig } from '../config/types';
import type { RemoteChannel } from './types';

/**
 * Speaks an outbound message, after it has already been delivered as text.
 *
 * After, never instead: speech is a second channel for the gist. The written
 * reply carries the code, the paths and the exact wording, and a listener who
 * missed something must be able to scroll up and read it.
 *
 * Every failure here is swallowed on purpose. TTS is an enhancement on a
 * message the user already has; a missing Piper binary, an unreadable voice or a
 * failed upload must never turn a delivered reply into an undelivered one. The
 * one thing it must not do is fail silently forever, so the first failure is
 * surfaced once (§18 R6: capabilities are flagged independently).
 *
 * Plan: docs/VOICE_STT_TTS_IMPLEMENTATION_PLAN.md §11, §12A, §17.
 */

export interface SpeechSettings {
  readonly enabled: boolean;
  readonly voiceEn: string;
  readonly voiceEl: string;
  readonly maxChars: number;
  readonly ffmpegPath?: string | undefined;
}

export class RemoteSpeechDelivery {
  private warned = false;

  constructor(
    private readonly channel: RemoteChannel,
    private readonly piper: PiperRunner,
    private readonly settings: () => SpeechSettings,
    private readonly signal?: AbortSignal,
    private readonly onError?: (message: string) => void,
  ) {}

  /**
   * Renders, synthesizes, encodes and uploads. Returns whether audio was sent,
   * which is false for every ordinary "nothing worth speaking" case as well as
   * for failures -- the caller treats both the same.
   */
  async speak(chatId: string, markdown: string): Promise<boolean> {
    const settings = this.settings();
    if (!settings.enabled || !this.channel.sendVoice) return false;
    // The chat label is a written navigation aid and nothing else. Its title is
    // the sender's own first prompt, so leaving it in made every spoken reply
    // open by reading the question back before answering it.
    const body = stripConversationIdentity(markdown);
    const language = detectLanguage(body);
    const spoken = renderForSpeech(body, { language, maxChars: settings.maxChars });
    if (!isWorthSpeaking(spoken)) return false;

    const operation = await VoiceOperation.create();
    try {
      const voice = language === 'el' ? settings.voiceEl : settings.voiceEn;
      const wav = await this.piper.synthesize(operation, spoken, voice);
      const ogg = await encodeToOpus(operation, wav, {
        ffmpegPath: settings.ffmpegPath,
        ...(this.signal ? { signal: this.signal } : {}),
      });
      await this.channel.sendVoice(chatId, ogg, this.signal);
      return true;
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        this.onError?.(
          `Forge: spoken replies are failing (${
            error instanceof Error ? error.message : String(error)
          }). Text delivery is unaffected.`,
        );
      }
      return false;
    } finally {
      await operation.dispose();
    }
  }
}

/**
 * Picks a voice from the script the reply is written in.
 *
 * Character counting rather than a language model: replies here are routinely
 * mixed ("κάνε commit τις αλλαγές"), and what matters is only which of two
 * voices pronounces the majority correctly. A Greek voice reading occasional
 * English technical terms is far more intelligible than the reverse, so any
 * meaningful Greek presence wins.
 */
function detectLanguage(text: string): 'en' | 'el' {
  const greek = text.match(/\p{Script=Greek}/gu)?.length ?? 0;
  const latin = text.match(/\p{Script=Latin}/gu)?.length ?? 0;
  return greek > 0 && greek * 4 >= latin ? 'el' : 'en';
}

/** Builds the delivery service from config, or undefined when speech is off. */
export function buildSpeechDelivery(
  channel: RemoteChannel,
  config: ForgeConfig,
  signal?: AbortSignal,
  onError?: (message: string) => void,
): RemoteSpeechDelivery | undefined {
  const output = config.voice?.output;
  if (output?.enabled !== true) return undefined;
  if (!output.piper_binary || !output.voices_dir) return undefined;
  const piperOptions: PiperOptions = {
    binary: output.piper_binary,
    voicesDir: output.voices_dir,
  };
  return new RemoteSpeechDelivery(
    channel,
    new PiperRunner(piperOptions),
    () => ({
      enabled: true,
      voiceEn: output.voice_en ?? 'en_US-amy-medium',
      voiceEl: output.voice_el ?? 'el_GR-joy-medium',
      maxChars: output.max_chars ?? 600,
      ...(config.video?.ffmpeg_path ? { ffmpegPath: config.video.ffmpeg_path } : {}),
    }),
    signal,
    onError,
  );
}
