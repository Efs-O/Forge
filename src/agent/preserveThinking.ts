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
 * Drop sent reasoning oldest-first until `fits` holds or none is left. Runs
 * before any tool result is excerpted: the thinking is a convenience, the
 * results are the evidence.
 */
export function dropOldestReasoning(
  messages: ChatMessage[],
  fits: (messages: ChatMessage[]) => boolean,
): ChatMessage[] {
  let current = messages;
  for (let i = 0; i < current.length && !fits(current); i++) {
    if (current[i].reasoning_content === undefined) continue;
    const rest = { ...current[i] };
    delete rest.reasoning_content;
    current = [...current.slice(0, i), rest, ...current.slice(i + 1)];
  }
  return current;
}
