import type { ModelConfig } from '../config/types';
import type { ChatMessage } from '../llm/types';

/**
 * Current-task thinking preservation (`sampling.preserve_thinking: true`).
 *
 * Forge used to send no reasoning back at all. On a hybrid/recurrent model
 * (Qwen3.8) that cost a prompt re-process every tool round: the model generated
 * `<think>…</think>` into its KV cache, the next request rendered the same
 * assistant turn WITHOUT it, the prompt diverged at that point, and llama-server
 * logged "restored context checkpoint" and re-processed everything after the
 * nearest checkpoint. The model also lost the plan it had just reasoned out.
 *
 * With the flag on, a llama.cpp model gets its reasoning back as
 * `reasoning_content`, but only for the CURRENT TASK: assistant turns after the
 * last message the user actually typed. Older turns' thinking stays out, so the
 * cost is bounded by one task, not by the whole conversation. The text is the
 * stored reasoning, unmodified, so the rendered prefix matches what the server
 * already has cached.
 *
 * Cloud providers are never given it: `reasoning_content` on an input message
 * is a llama.cpp extension.
 */
export function preservesThinking(model: ModelConfig): boolean {
  return (
    (model.provider ?? 'llama.cpp') === 'llama.cpp' && model.sampling?.preserve_thinking === true
  );
}

/**
 * The start of the current task: the last user message the user typed.
 * Forge's own nudges (`internal`) and messages told mid-turn belong to the
 * task already running, so they do not end it — dropping the thinking there
 * would re-process the prompt in the middle of a turn.
 */
function taskStart(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && !m.internal && !m.midTurn) return i;
  }
  return -1;
}

/** Model-facing copy with `reasoning_content` set on the current task's assistant turns. */
export function attachCurrentTaskReasoning(messages: ChatMessage[]): ChatMessage[] {
  const start = taskStart(messages);
  return messages.map((m, i) =>
    i > start && m.role === 'assistant' && m.reasoning?.trim()
      ? { ...m, reasoning_content: m.reasoning }
      : m,
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
