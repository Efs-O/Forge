/**
 * Model/config mismatch warnings for a turn.
 *
 * Extracted from `ModelTurn.ts` (2026-10-29, lane F2: that file had reached the
 * 500-line gate this repo lints, and adding the skills-catalog snapshot to it
 * needed a real seam first). These are the checks that change *how the request is
 * built* rather than what is sent, and they are all `warnOnce`-keyed: they are
 * properties of the model, so repeating them every turn would be noise.
 *
 * `warnOnce` is passed as a sink rather than the whole turn context, so this
 * module does not import `ModelTurn` — the two must not form a cycle.
 */
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { RuntimeModelCapabilities } from '../backend/ModelCapabilities';
import { perSlotContext } from '../util/contextBudget';

export interface ModelMismatchWarningSink {
  /** Shows a warning at most once per key, for the life of the session. */
  warnOnce: (key: string, message: string) => void;
}

export function warnAboutModel(
  sink: ModelMismatchWarningSink,
  model: ModelConfig,
  config: ForgeConfig,
  runtimeCaps: RuntimeModelCapabilities | undefined,
  thinkingKwargs: boolean,
): void {
  if (
    !thinkingKwargs &&
    (model.think !== undefined || model.sampling?.preserve_thinking !== undefined)
  ) {
    sink.warnOnce(
      `${model.name}:thinking`,
      `Forge: model "${model.name}" does not appear to support thinking template toggles. Thinking kwargs will be omitted for this request.`,
    );
  }
  if (runtimeCaps?.hasChatTemplate === false) {
    sink.warnOnce(
      `${model.name}:template`,
      `Forge: model "${model.name}" does not expose a usable chat template. Prompt formatting may be mismatched.`,
    );
  }
  const perSlot = perSlotContext(model, config.llama_server, model.provider ?? 'llama.cpp');
  const configuredMaxTokens = model.sampling?.max_tokens;
  if (perSlot > 0 && configuredMaxTokens !== undefined && configuredMaxTokens > perSlot) {
    sink.warnOnce(
      `${model.name}:max-tokens`,
      `Forge: model "${model.name}" sets max_tokens ${configuredMaxTokens}, above its ${perSlot}-token per-slot context. Forge will cap output at the room actually left in each turn.`,
    );
  }
}
