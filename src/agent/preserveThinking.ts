import { endpointHostOf, isLoopbackHost } from '../config/policyYamlNodes';
import type { ModelConfig } from '../config/types';
import type { ChatMessage } from '../llm/types';

/**
 * Thinking preservation, on by default (`sampling.preserve_thinking: false` turns it off).
 *
 * Forge used to send no reasoning back at all. On a hybrid/recurrent model
 * (Qwen3.8) that cost a prompt re-process every tool round: the model generated
 * `<think>…</think>` into its KV cache, the next request rendered the same
 * assistant turn WITHOUT it, the prompt diverged at that point, and llama-server
 * logged "restored context checkpoint" and re-processed everything after the
 * nearest checkpoint. The model also lost the plan it had just reasoned out.
 *
 * Unless a model sets the flag to false, a llama.cpp model gets its reasoning back as
 * `reasoning_content` on EVERY assistant turn, the stored text unmodified, so
 * the rendered prefix matches what the server already has cached. This used to
 * be scoped to the current task (turns after the last typed message), which
 * stripped the previous task's thinking at every typed message and cold-read
 * Strata back to a checkpoint: 8 times, ~6 min, in one 2026-10-16 evening.
 * Keeping all of it is the tested default -- Qwen's model card, llama.cpp
 * (b10763+), Strata's template and OpenCode all do. Size is compaction's job,
 * and `prepareToolResultContext` drops the oldest thinking first when a prompt
 * still does not fit.
 *
 * The named cloud providers are never given it: `reasoning_content` on an
 * input message is a llama.cpp extension. A generic `openai-compatible`
 * endpoint on this machine gets it by default, because local servers such as Strata
 * take it the same way (OpenCode sends it to Strata on every round). Without
 * it, a 2026-10-07 bench run found the cause of a failure in round 13 and
 * lost it again by round 16, generating 3.5x OpenCode's tokens.
 *
 * It was opt-in until 2026-11-24, and every new model entry started without
 * it. Now the flag is an off switch for a model whose template mishandles
 * earlier thinking.
 */
const PRESERVING_PROVIDERS = new Set(['llama.cpp', 'openai-compatible']);

/**
 * On unless the model says otherwise: llama.cpp (Forge spawns it on this
 * machine), and an openai-compatible server on this machine (Strata, Maya). A
 * remote openai-compatible endpoint stays opt-in: strict APIs reject the field.
 */
function onByDefault(model: ModelConfig): boolean {
  const provider = model.provider ?? 'llama.cpp';
  if (provider === 'llama.cpp') return true;
  if (provider !== 'openai-compatible') return false;
  const host = endpointHostOf(model.endpoint);
  return host !== undefined && isLoopbackHost(host);
}

export function preservesThinking(model: ModelConfig): boolean {
  return (
    PRESERVING_PROVIDERS.has(model.provider ?? 'llama.cpp') &&
    (model.sampling?.preserve_thinking ?? onByDefault(model))
  );
}

/**
 * The template's `preserve_thinking` kwarg for this model: the explicit flag
 * for any provider, else `true` where thinking is preserved by default.
 */
export function templatePreserveThinking(model: ModelConfig): boolean | undefined {
  return model.sampling?.preserve_thinking ?? (onByDefault(model) ? true : undefined);
}

/** Model-facing copy with `reasoning_content` set on every assistant turn that has thinking. */
export function attachReasoning(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.role === 'assistant' && m.reasoning?.trim() ? { ...m, reasoning_content: m.reasoning } : m,
  );
}

/**
 * Drop the first `count` sent reasoning turns, oldest-first. The caller owns
 * the monotonic count so later rounds do not recalculate a moving fit point.
 */
export function dropOldestReasoning(messages: ChatMessage[], count: number): ChatMessage[] {
  if (count <= 0) return messages;
  let dropped = 0;
  const current = messages.map((message) => {
    if (dropped >= count || message.reasoning_content === undefined) return message;
    dropped += 1;
    const rest = { ...message };
    delete rest.reasoning_content;
    return rest;
  });
  if (dropped === 0) {
    return messages;
  }
  return current;
}
