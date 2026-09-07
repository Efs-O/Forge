/**
 * Projections of the session onto what the webview renders.
 *
 * Split out of `sessionTypes`, which owns the shapes and the persistence
 * schema. Everything here is a pure read of a `SidebarRuntime` — the display
 * view of a transcript, the badge counts, the tab and history metadata, and the
 * transcripts a `sessionSync` carries. No mutation, no Memento, no posting.
 */

import type { ChatMessage } from '../llm/types';
import { capDisplayText } from '../tools/resultCap';
import { isFailureResult, resultLabel } from './toolResultView';
import { displayTitle } from './conversationTitle';
import type { SessionHistoryMeta, SessionTabMeta } from './messageBridge';
import type {
  ConversationDisplayDiff,
  ConversationRuntime,
  DisplayPersistMessage,
  SidebarRuntime,
} from './sessionTypes';

function textContent(content: ChatMessage['content']): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return text || null;
}

/**
 * Webview view: renderable turns. Completed tool calls are included so reload
 * can reconstruct the work already done. Their body is capped by the same rule
 * as a live ToolResult message, rather than copying an unbounded tool payload
 * into a webview message.
 *
 * An assistant turn that only called a tool is kept when it carries reasoning.
 * Dropping those made every thinking bubble except the final round's vanish the
 * moment a turn ended and SESSION_SYNC rebuilt the transcript.
 */
export function displayPersistMessages(
  messages: ChatMessage[],
  displayDiffs: ConversationDisplayDiff[] = [],
): DisplayPersistMessage[] {
  const out: DisplayPersistMessage[] = [];
  const diffsByToolCall = new Map<string, ConversationDisplayDiff[]>();
  for (const diff of displayDiffs) {
    const current = diffsByToolCall.get(diff.toolCallId);
    if (current) current.push(diff);
    else diffsByToolCall.set(diff.toolCallId, [diff]);
  }
  for (const m of messages) {
    if (m.internal) continue;
    const toolText = m.role === 'tool' ? textContent(m.content) : null;
    if (m.role === 'tool' && toolText !== null) {
      const toolName = m.name ?? 'tool';
      const { text: toolResult, totalChars: toolResultTotal } = capDisplayText(toolText);
      out.push({
        role: 'tool',
        content: `${toolName} → ${resultLabel(toolName, toolText, null)}`,
        toolName,
        toolResult,
        toolResultTotal,
        ...(isFailureResult(toolText) ? { toolIsError: true } : {}),
        ...(typeof m.toolMs === 'number' ? { toolMs: m.toolMs } : {}),
      });
      for (const diff of diffsByToolCall.get(m.tool_call_id ?? '') ?? []) {
        out.push({
          role: 'diff',
          content: diff.filePath,
          diffHunks: diff.hunks,
          diffIsNew: diff.isNew,
          diffIsDeleted: diff.isDeleted,
        });
      }
      continue;
    }
    // A user turn that carried an attachment has ARRAY content, and requiring a
    // string here dropped it whole: after a reload the prompt text vanished
    // from the transcript along with the image. Its text parts are renderable,
    // so take them.
    const arrayText = m.role === 'user' && Array.isArray(m.content) ? textContent(m.content) : null;
    if (
      (m.role !== 'user' && m.role !== 'assistant') ||
      (typeof m.content !== 'string' &&
        arrayText === null &&
        !(m.role === 'user' && m.attachments?.length) &&
        !(m.role === 'assistant' && typeof m.reasoning === 'string' && m.reasoning.length > 0))
    ) {
      continue;
    }
    const content = typeof m.content === 'string' ? m.content : (arrayText ?? '');
    const reasoning = typeof m.reasoning === 'string' && m.reasoning.length > 0 ? m.reasoning : '';
    // The final answer can follow streamed reasoning in the same model turn.
    // The ordinary message renderer intentionally shows answer text only, so
    // preserve the thought as its own Thinking row rather than losing it when
    // session sync replaces the live stream.
    // The span belongs to the thought, so on a split turn it rides the reasoning
    // half - the answer half never reasoned.
    const reasoningMs = typeof m.reasoningMs === 'number' ? { reasoningMs: m.reasoningMs } : {};
    if (m.role === 'assistant' && content && reasoning) {
      out.push({ role: 'assistant', content: '', reasoning, ...reasoningMs });
      out.push({ role: 'assistant', content });
      continue;
    }
    out.push({
      role: m.role,
      // A reasoning-only turn has content: null; the webview contract is string.
      content,
      ...(reasoning ? { reasoning, ...reasoningMs } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    });
  }
  return out;
}

/**
 * The tab/history badge count, without building the display array to measure it.
 *
 * `displayPersistMessages(...).filter(m => m.role !== 'tool').length` was the
 * old spelling, and it ran for every open tab AND every archived conversation on
 * every sync — materialising ~52 full transcripts, capping every tool body, to
 * read 52 integers. This must stay in step with `displayPersistMessages`: it
 * counts exactly the rows that function emits with a role other than `tool`.
 */
export function countDisplayMessages(
  messages: ChatMessage[],
  displayDiffs: ConversationDisplayDiff[] = [],
): number {
  const diffsByToolCall = new Map<string, number>();
  for (const diff of displayDiffs) {
    diffsByToolCall.set(diff.toolCallId, (diffsByToolCall.get(diff.toolCallId) ?? 0) + 1);
  }
  let count = 0;
  for (const m of messages) {
    if (m.internal) continue;
    if (m.role === 'tool') {
      // The tool row itself is excluded from the badge; the diff rows it drags
      // along are not.
      if (textContent(m.content) !== null) count += diffsByToolCall.get(m.tool_call_id ?? '') ?? 0;
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const hasReasoning = typeof m.reasoning === 'string' && m.reasoning.length > 0;
    // Mirrors the attachment-carrying user turn the projection now keeps: its
    // content is an array, and it still counts for one row.
    const arrayText = m.role === 'user' && Array.isArray(m.content) ? textContent(m.content) : null;
    if (
      typeof m.content !== 'string' &&
      arrayText === null &&
      !(m.role === 'user' && m.attachments?.length) &&
      !(m.role === 'assistant' && hasReasoning)
    ) {
      continue;
    }
    const content = typeof m.content === 'string' ? m.content : '';
    // A split turn (streamed thought followed by the answer) emits two rows.
    count += m.role === 'assistant' && content && hasReasoning ? 2 : 1;
  }
  return count;
}

export function tabMetasFromSession(
  session: SidebarRuntime,
  streamingIds?: ReadonlySet<string>,
  getActiveTimeMs?: (conversation: ConversationRuntime) => number,
): SessionTabMeta[] {
  return session.conversations.map((c) => {
    // Tool turns are restored but must not inflate the user-facing badge.
    return {
      id: c.id,
      title: displayTitle(c.title),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: countDisplayMessages(c.messages, c.displayDiffs),
      ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
      active_time_ms: getActiveTimeMs?.(c) ?? c.active_time_ms ?? 0,
      ...(streamingIds?.has(c.id) ? { streaming: true } : {}),
    };
  });
}

export function historyMetasFromSession(session: SidebarRuntime): SessionHistoryMeta[] {
  const openIds = new Set(session.conversations.map((c) => c.id));
  return session.history
    .filter((c) => !openIds.has(c.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => {
      return {
        id: c.id,
        title: displayTitle(c.title),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: countDisplayMessages(c.messages, c.displayDiffs),
        ...(c.active_model !== undefined ? { active_model: c.active_model } : {}),
        active_time_ms: c.active_time_ms ?? 0,
      };
    });
}

/**
 * Transcripts for webview sync — display view, not the persistence view.
 *
 * `ids` is the set the webview can actually render right now: the active tab
 * plus anything streaming. It is not an optimisation detail the caller may skip
 * — building every open tab AND all 40 archived conversations put ~16 MB
 * (measured, this workspace) through `postMessage` on every tab switch, model
 * pin and tool round, to render one of them. A transcript the webview has not
 * been sent is requested by id when it becomes renderable.
 */
export function slimMessagesById(
  session: SidebarRuntime,
  ids: ReadonlySet<string>,
): Record<string, DisplayPersistMessage[]> {
  const out: Record<string, DisplayPersistMessage[]> = {};
  for (const c of [...session.conversations, ...session.history]) {
    if (!ids.has(c.id)) continue;
    out[c.id] = displayPersistMessages(c.messages, c.displayDiffs);
  }
  return out;
}

/** One prompt and what the agent finally said back to it. */
export interface ForgeExchange {
  prompt: string;
  answer: string;
}

/**
 * The last `limit` prompt/answer pairs, oldest first.
 *
 * Built on the display projection rather than on `messages` directly, so what a
 * remote `/view` reads back is the same text the sidebar renders — including
 * the fact that a compacted conversation holds its summary and not the answers
 * it replaced. Reporting what the agent can still see is the more useful of the
 * two possible answers, and the only one that stays true as the turn continues.
 *
 * One exchange per PROMPT, not per assistant message: an agentic turn emits
 * text between tool rounds, and pairing each fragment with the same prompt
 * would spend a `/view 3` on three pieces of one turn. The last text of the
 * turn is the outcome, which is what the command is for.
 */
export function recentExchanges(messages: ChatMessage[], limit: number): ForgeExchange[] {
  const exchanges: ForgeExchange[] = [];
  let prompt = '';
  let started = false;
  for (const message of displayPersistMessages(messages)) {
    if (message.role === 'user') {
      prompt = message.content.trim();
      started = false;
      continue;
    }
    if (message.role !== 'assistant') continue;
    const answer = message.content.trim();
    if (!answer) continue;
    // Later text in the same turn REPLACES the earlier: a turn that narrated
    // before its tool calls has already had that narration superseded by the
    // answer it was working towards.
    if (started) exchanges[exchanges.length - 1] = { prompt, answer };
    else exchanges.push({ prompt, answer });
    started = true;
  }
  return limit >= exchanges.length ? exchanges : exchanges.slice(-limit);
}
