import type { ForgeConfig, VoiceConfig } from '../config/types';
import { VoiceAuditLog, type VoiceAuditSink } from '../voice/VoiceAudit';
import { VoiceAuditFileSink } from '../voice/VoiceAuditFileSink';
import { WhisperCppRunner, type WhisperCppOptions } from '../voice/WhisperCppRunner';
import { WhisperServerProcess } from '../voice/WhisperServerProcess';
import { WhisperServerRunner } from '../voice/WhisperServerRunner';
import type { PendingGate } from '../voice/VoiceGrammar';
import { PendingVoiceDraft } from '../voice/PendingVoiceDraft';
import type { RemoteInboundDisposition, RemoteInboundEvent, RemoteChannel } from './types';
import {
  type SpokenGateContext,
  type VoiceBridgeBundle,
  type VoiceBridgeSettings,
  type RemoteVoiceBridgeOptions,
} from './RemoteVoiceBridge';
import type { WhisperRunner } from '../voice/VoiceTypes';

export type VoiceBridgeFactory = (options: RemoteVoiceBridgeOptions) => VoiceBridgeBundle['bridge'];

export function buildVoiceBridge(
  channel: RemoteChannel,
  config: ForgeConfig,
  sink: VoiceAuditSink = new VoiceAuditFileSink(),
  lifecycle: { confirmServerStart?: ((detail: string) => Promise<boolean>) | undefined } = {},
  createBridge: VoiceBridgeFactory,
): VoiceBridgeBundle | undefined {
  const voice = config.voice;
  if (voice?.enabled !== true || !voice.whisper_model) return undefined;
  const serverEnabled = voice.server?.enabled === true;
  if (serverEnabled ? !voice.server?.binary : !voice.whisper_binary) return undefined;
  const drafts = new PendingVoiceDraft();
  const compute = whisperCompute(voice.compute);
  const server = serverEnabled
    ? new WhisperServerProcess({
        binary: voice.server!.binary!,
        model: voice.whisper_model,
        port: voice.server!.port,
        idleTimeoutMs: voice.server!.idle_timeout_ms,
        confirmOnStart: voice.server!.confirm_on_start,
        confirmStart: lifecycle.confirmServerStart,
        ...compute,
      })
    : undefined;
  const runner: WhisperRunner = server
    ? new WhisperServerRunner({
        baseUrl: server.baseUrl(),
        model: voice.whisper_model,
        useGpu: compute.useGpu,
      })
    : new WhisperCppRunner({
        binary: voice.whisper_binary!,
        model: voice.whisper_model,
        ...compute,
      });
  const bridge = createBridge({
    channel,
    runner,
    audit: new VoiceAuditLog(sink),
    drafts,
    settings: () => voiceSettings(config),
    ...(server ? { withActivity: (operation) => server.withActivity(operation) } : {}),
  });
  return { bridge, drafts, dispose: async () => await server?.dispose() };
}

function whisperCompute(compute: VoiceConfig['compute']): Partial<WhisperCppOptions> {
  if (!compute) return {};
  return {
    ...(compute.gpu !== undefined ? { useGpu: compute.gpu } : {}),
    ...(compute.device !== undefined ? { gpuDevice: compute.device } : {}),
    ...(compute.threads !== undefined ? { threads: compute.threads } : {}),
    ...(compute.beam_size !== undefined ? { beamSize: compute.beam_size } : {}),
    ...(compute.flash_attn !== undefined ? { flashAttn: compute.flash_attn } : {}),
  };
}

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

export function buildSpokenGateContext(
  event: Extract<RemoteInboundEvent, { kind: 'voice' }>,
  nonce: string | undefined,
  deps: {
    pendingGates(chatId: string): PendingGate[];
    resolveSpoken(gateId: string, approve: boolean, chatId: string, nonce?: string): boolean;
    conversationFor(channel: string, chatId: string): string | undefined;
    interrupt(conversationId: string): void;
  },
): SpokenGateContext {
  return {
    gates: deps.pendingGates(event.chatId),
    nonce,
    resolve: (gateId, approve, resolveNonce) =>
      deps.resolveSpoken(gateId, approve, event.chatId, resolveNonce),
    cancel: () => {
      const conversationId = deps.conversationFor(event.channel, event.chatId);
      if (!conversationId) return false;
      deps.interrupt(conversationId);
      return true;
    },
  };
}

export async function resolveVoiceDraft(
  event: Extract<RemoteInboundEvent, { kind: 'text' }>,
  voice: VoiceBridgeBundle,
  deps: {
    touch(): void;
    say(text: string): Promise<void>;
    rerun(text: string): Promise<RemoteInboundDisposition>;
  },
): Promise<RemoteInboundDisposition | undefined> {
  const resolution = voice.drafts.resolve(event.channel, event.chatId, event.text);
  if (resolution.kind === 'none') return undefined;
  const text = voice.bridge.finishDraft(resolution);
  deps.touch();
  if (text === undefined) {
    await deps.say('Forge: draft discarded.');
    return { kind: 'handled' };
  }
  return await deps.rerun(text);
}
