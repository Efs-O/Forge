/**
 * Pure mutations on a conversation's transcript and counters.
 *
 * Split out of `AgentLoop`: these change conversation data only. Notifying
 * listeners that the transcript is dirty stays with the loop, which owns them.
 */

import type { AttachmentData } from './messageBridge';
import type { ConversationRuntime } from './sessionTypes';
import { buildUserContent } from './ConversationOps';
import { deriveTitle } from './sessionTypes';

/** Presentation metadata for a prompt injected by Forge rather than authored by the user. */
export interface UserPromptOptions {
  internal?: boolean;
}

/** Append the user's message, titling the conversation from its first one. */
export function appendUserPrompt(
  conv: ConversationRuntime,
  text: string,
  attachments?: AttachmentData[],
  options?: UserPromptOptions,
): void {
  const priorUserCount = conv.messages.filter((m) => m.role === 'user').length;
  conv.messages.push({
    role: 'user',
    content: buildUserContent(text, attachments),
    ...(options?.internal ? { internal: true } : {}),
  });
  if (priorUserCount === 0) conv.title = deriveTitle(text.split('\n')[0] ?? text);
}

/** Fold one model request's token usage into the running totals. */
export function applyUsage(
  conv: ConversationRuntime,
  inputTokens: number,
  outputTokens: number,
): void {
  conv.input_tokens = (conv.input_tokens ?? 0) + inputTokens;
  conv.output_tokens = (conv.output_tokens ?? 0) + outputTokens;
  conv.last_input_tokens = inputTokens;
  conv.last_output_tokens = outputTokens;
  conv.model_request_count = (conv.model_request_count ?? 0) + 1;
}
