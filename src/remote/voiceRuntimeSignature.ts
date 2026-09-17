import type { ForgeConfig } from '../config/types';

/**
 * Voice runners capture executable/model/device settings at construction.
 * `output.enabled` is left out: it is applied live via
 * RemoteSpeechDelivery.setEnabled, so `/voice on|off` needs no rebuild.
 */
export function voiceRuntimeSignature(config: ForgeConfig): string {
  const voice = config.voice;
  if (!voice?.output) return JSON.stringify(voice ?? null);
  return JSON.stringify({ ...voice, output: { ...voice.output, enabled: undefined } });
}
