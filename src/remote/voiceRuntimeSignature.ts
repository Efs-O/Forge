import type { ForgeConfig } from '../config/types';

/** Voice runners capture executable/model/device settings at construction. */
export function voiceRuntimeSignature(config: ForgeConfig): string {
  return JSON.stringify(config.voice ?? null);
}
