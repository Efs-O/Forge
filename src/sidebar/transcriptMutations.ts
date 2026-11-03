/**
 * Pure mutations on a conversation's transcript and counters.
 *
 * Split out of `AgentLoop`: these change conversation data only. Notifying
 * listeners that the transcript is dirty stays with the loop, which owns them.
 */

import type { AttachmentData } from './messageBridge';
import type { ChatAttachmentRef } from '../llm/types';
import type { ConversationRuntime } from './sessionTypes';
import { buildUserContent } from './ConversationOps';
import { deriveTitle, stripHeadingMarker } from './sessionTypes';
import { parseForgeInboundPrompt } from '../agentBus/busContent';
import type { AgentSenderMetadata } from '../agentLinks/chatAgentLinks';

/** Presentation metadata for a prompt injected by Forge rather than authored by the user. */
export interface UserPromptOptions {
  /** Creation time shared with the optimistic webview row, when supplied. */
  createdAt?: number;
  internal?: boolean;
  /**
   * On-disk references to what this prompt carried, stamped on the transcript
   * so the webview can show the images back. The pixels stay out of the
   * transcript; `ChatAttachmentStore` holds them.
   */
  attachmentRefs?: ChatAttachmentRef[];
  sender?: AgentSenderMetadata;
}

/** Keep bridge-supplied values finite and inside JavaScript's date range. */
export function messageCreatedAt(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) return Date.now();
  return Number.isNaN(new Date(value).getTime()) ? Date.now() : value;
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
    createdAt: messageCreatedAt(options?.createdAt),
    ...(options?.internal ? { internal: true } : {}),
    ...(options?.attachmentRefs?.length ? { attachments: options.attachmentRefs } : {}),
    ...(options?.sender ? { agentSender: options.sender } : {}),
  });
  // A chat named before its first prompt keeps that name: `message_chat`
  // `new_chat` names a worker after its task (`auto`), and the first prompt is
  // the `📨 Message from …` wrapper, which named every worker the same.
  if (priorUserCount === 0 && conv.title_source !== 'user' && conv.title_source !== 'auto') {
    // Named from the prompt, and marked as such: the daily retitle job proposes
    // new names only for chats still marked `prompt` (`retitleRun.ts`).
    const named = titleLine(text);
    conv.title = deriveTitle(named.line);
    conv.title_source = 'prompt';
    // Who started it, recorded next to the name rather than inside it, so the
    // panel can show it as a badge without putting `claude: ` in front of every
    // agent-started chat's title.
    if (named.originAgent) conv.origin_agent = named.originAgent;
  }
}

/**
 * The line a conversation is named from, and who sent the prompt it came from.
 *
 * A bus prompt's first line is its `**codex says:**` header, which named every
 * agent-started chat the same thing; the header used to be pasted in front of
 * the brief, so seven rows read `Claude: Claude here, with an owner-…`. The
 * sender now travels as `origin_agent` instead, and the title is the brief's
 * own first non-empty line, with any leading `# ` heading marker stripped.
 */
function titleLine(text: string): { line: string; originAgent?: string } {
  const bus = parseForgeInboundPrompt(text);
  if (!bus) return { line: text.split('\n')[0] ?? text };
  const first = bus.text.split('\n').find((line) => line.trim()) ?? '';
  return { line: stripHeadingMarker(first), originAgent: bus.from };
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

/**
 * Fold one round's dispatched tool calls into the running total. Separate from
 * `applyUsage` because the two do not move together: a round can dispatch four
 * tools, and a turn can end with none.
 */
export function applyToolCalls(conv: ConversationRuntime, count: number): void {
  if (count <= 0) return;
  conv.tool_call_count = (conv.tool_call_count ?? 0) + count;
}
