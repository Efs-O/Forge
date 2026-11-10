/**
 * Sidebar multi-conversation session: types, Zod persistence, migration from legacy history.
 */

import { z } from 'zod';
import type { CompactionState } from './compactionTypes';
import type { ForgeInstructionsPin } from './forgeInstructionsPin';
import type { ContextTrimState } from '../agent/toolResultContext';
import type { PromptAnchor } from '../util/contextBudget';
import {
  agentLinksSchema,
  type AgentLinks,
  type AgentSenderMetadata,
} from '../agentLinks/chatAgentLinks';
import { compactionPersistedSchema } from './compactionPersistedSchema';
import { PLAN_STATUSES, canonicalPlanStatus } from './planStatus';
export {
  createDefaultSession,
  loadSidebarSession,
  runtimeToPersisted,
  saveActiveConversationId,
  saveSidebarSession,
  upsertHistoryConversation,
} from './sessionPersistence';
import type { ChatAttachmentRef, ChatMessage } from '../llm/types';
import type { DiffHunk } from './messageBridge';
import { slimMsgSchema } from './slimPersist';
import { questionAnswerRecordSchema } from '../util/questionAnswers';
import type { QuestionAnswerRecord } from '../util/questionAnswers';
import { getLogger } from '../util/logger';
// Only for the `title_source` field below; the same name is re-exported from
// `conversationTitle.ts` at the bottom of this block, which does not bring it
// into this file's scope.
import type { TitleSource } from './conversationTitle';

// Naming lives in its own module; re-exported here because sessionTypes is
// the import site every caller already reaches for.
export {
  UNTITLED_TITLE,
  deriveTitle,
  displayTitle,
  isUntitled,
  stripHeadingMarker,
  titleSourceOf,
  type TitleSource,
} from './conversationTitle';

// The slim persisted message form lives in its own module; re-exported here for the same reason.
export { type SlimPersistMessage, slimPersistMessages, chatMessagesFromSlim } from './slimPersist';

/** Max open tabs — bounds workspaceState size and UI. */
export const MAX_CONVERSATIONS = 12;
export const MAX_HISTORY_CONVERSATIONS = 40;

/**
 * The refusal shown when no open chat can be archived, from the per-reason
 * counts `ConversationTabs.capBlockers` computes. One wording for the sidebar
 * toast and every transport that surfaces the facade's error.
 */
export function chatCapMessage(reasons: readonly string[]): string {
  if (reasons.length === 0) return `Forge: all ${MAX_CONVERSATIONS} open chats are at the cap.`;
  const nextStep = reasons.includes('auto-archive is disabled')
    ? 'Archive one yourself (✕ on its tab) or enable inactivity archiving and wait for its grace period, then try again.'
    : 'Archive one yourself (✕ on its tab) or wait for an eligible chat to expire, then try again.';
  return `Forge: no open chat can be archived — ${reasons.join(', ')}. ${nextStep}`;
}

export const HISTORY_KEY_LEGACY = 'forge.conversation.history';

export const SESSION_KEY_V1 = 'forge.conversations.v1';
/** Latest invalid session blob, retained so a later version can recover it. */
export const SESSION_KEY_V1_CORRUPT = 'forge.conversations.v1.corrupt';

/**
 * Which conversation is active, stored apart from the transcript blob so a tab
 * switch does not have to rewrite it. See `saveActiveConversationId`.
 */
export const ACTIVE_ID_KEY = 'forge.conversations.activeId';

/** Subset of the transcript which can be safely restored into the webview. */
export type DisplayPersistMessage =
  | {
      role: 'user' | 'assistant';
      content: string;
      createdAt?: number;
      reasoning?: string;
      reasoningMs?: number;
      midTurn?: boolean;
      agentSender?: AgentSenderMetadata;
      attachments?: ChatAttachmentRef[];
    }
  | {
      role: 'system';
      content: string;
      createdAt?: number;
    }
  | {
      role: 'tool';
      content: string;
      toolName: string;
      toolCallId?: string;
      toolTarget?: string;
      toolResult: string;
      toolResultTotal: number;
      questionRecord?: QuestionAnswerRecord;
      toolIsError?: boolean;
      toolMs?: number;
      stampedAt?: number;
    }
  | {
      role: 'diff';
      content: string;
      toolCallId?: string;
      diffHunks: DiffHunk[] | null;
      diffIsNew: boolean;
      diffIsDeleted: boolean;
    };

/** A file preview produced by one completed native tool call. */
export interface ConversationDisplayDiff {
  toolCallId: string;
  filePath: string;
  hunks: DiffHunk[] | null;
  isNew: boolean;
  isDeleted: boolean;
}

/** Structured ask_user answers stored with the display transcript, not model history. */
export interface ConversationDisplayQuestionRecord {
  toolCallId: string;
  record: QuestionAnswerRecord;
}

/** Durable status rows shown in the transcript without entering model history. */
export type ConversationDisplayNotice = {
  message: string;
  createdAt: number;
  messageIndex: number;
};

const diffLineSchema = z.object({
  kind: z.enum(['context', 'added', 'removed']),
  text: z.string(),
});
const displayDiffSchema = z.object({
  toolCallId: z.string().min(1),
  filePath: z.string().min(1),
  hunks: z
    .array(
      z.object({
        oldStart: z.number().int(),
        newStart: z.number().int(),
        lines: z.array(diffLineSchema),
      }),
    )
    .nullable(),
  isNew: z.boolean(),
  isDeleted: z.boolean(),
});
const displayQuestionRecordSchema = z.object({
  toolCallId: z.string().min(1),
  record: questionAnswerRecordSchema,
});
const displayNoticeSchema = z.object({
  message: z.string(),
  createdAt: z.number().int(),
  messageIndex: z.number().int().min(0),
});

const log = getLogger();

function questionRecordToolCallId(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '<missing>';
  const id = (value as Record<string, unknown>)['toolCallId'];
  return typeof id === 'string' && id.length > 0 ? id : '<missing>';
}

function validDisplayQuestionRecords(chatId: string, values: unknown[]) {
  const valid: z.infer<typeof displayQuestionRecordSchema>[] = [];
  for (const value of values) {
    const parsed = displayQuestionRecordSchema.safeParse(value);
    if (parsed.success) {
      valid.push(parsed.data);
      continue;
    }
    log.warn(
      `[sessionPersistence] dropped malformed question record for chat ${chatId}, tool call ${questionRecordToolCallId(value)}`,
    );
  }
  return valid;
}

/**
 * Bounds on the agent-written task plan.
 *
 * `update_plan` is auto-approved, so a model can write this state with no
 * confirmation gate, and the result is both persisted to session.json AND
 * re-injected into every subsequent request. Unbounded, that is a context leak
 * that compounds each round rather than a one-off mistake.
 */
export const PLAN_MAX_ITEMS = 20;
export const PLAN_ITEM_MAX_CHARS = 500;

// `.strict()`, not the Zod default: an object schema that silently STRIPS
// unknown keys would accept the arbitrary blob the advertised
// `additionalProperties: false` promises to refuse, and the model would never
// learn its call was wrong.
export const planItemSchema = z
  .object({
    text: z.string().min(1).max(PLAN_ITEM_MAX_CHARS),
    status: z.preprocess(canonicalPlanStatus, z.enum(PLAN_STATUSES)),
  })
  .strict();

export type PlanItem = z.infer<typeof planItemSchema>;
export interface ConversationPlan {
  items: PlanItem[];
  updatedAt: number;
}

export const conversationPersistedBaseSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  // The same three values as `TitleSource` in `conversationTitle.ts`, optional
  // so every record written before it still parses. See `titleSourceOf` there.
  title_source: z.enum(['prompt', 'user', 'auto']).optional(),
  // Who started the chat, when a bus prompt did — the sender name as the bus
  // wrote it. Optional: every record written before it must still parse.
  origin_agent: z.string().min(1).max(64).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Last user-facing conversation activity; independent of history ordering. */
  retention_activity_at: z.number().finite().int().min(0).optional(),
  /** Explicitly keep this open while automatic inactivity archiving is enabled. */
  keep_open: z.boolean().optional(),
  messages: z.array(slimMsgSchema),
  agentLinks: agentLinksSchema.optional(),
  opened_by: z.string().min(1).optional(),
  active_model: z.string().optional(),
  cli_sessions: z.record(z.string(), z.string().min(1)).optional(),
  // Optional, so records written before compaction existed still parse.
  compaction: compactionPersistedSchema.optional(),
  // The bounds are re-asserted here, not just in the tool schema: a hand-edited
  // or corrupted session.json must not be able to reintroduce an unbounded plan
  // on load, since every round re-injects it into the prompt.
  plan: z
    .object({
      items: z.array(planItemSchema).min(1).max(PLAN_MAX_ITEMS),
      updatedAt: z.number().int(),
    })
    .optional(),
  forge_instructions_pin: z
    .object({
      text: z.string(),
      windowStart: z.number().int().min(0),
      announced: z.object({ text: z.string(), messageIndex: z.number().int() }).strict().optional(),
    })
    .strict()
    .optional(),
  // Optional migration field: previews written by older Forge versions were
  // only live webview state and therefore were not recoverable after a sync.
  display_diffs: z.array(displayDiffSchema).optional(),
  /** Read-only question cards, separate from the compact model-facing turns. */
  display_question_records: z.array(z.unknown()).optional(),
  /** Durable status rows, separate from model-facing messages. */
  display_notices: z.array(displayNoticeSchema).optional(),
  // Active-agent-time tracking. Optional so pre-existing records parse unchanged.
  active_time_ms: z.number().int().min(0).optional(),
  active_started_at: z.number().int().optional(),
  input_tokens: z.number().int().min(0).optional(),
  output_tokens: z.number().int().min(0).optional(),
  last_input_tokens: z.number().int().min(0).optional(),
  last_output_tokens: z.number().int().min(0).optional(),
  model_request_count: z.number().int().min(0).optional(),
  tool_call_count: z.number().int().min(0).optional(),
  /**
   * Epoch ms of the moment content from outside this machine first entered this
   * chat (`src/tools/exfilTaint.ts`). Optional so every record written before
   * phase 4 parses unchanged; kept beside `compaction` rather than inside it, so
   * a reload cannot clear the flag while the page that brought it in is still in
   * context and compaction can still summarize that page away.
   */
  untrusted_since_ms: z.number().int().min(0).optional(),
  /**
   * The approval keys this chat has been allowed (`src/sidebar/chatApprovalRules.ts`),
   * one string per key, each in the shape `src/sidebar/approvalKey.ts` validates.
   * Optional so every record written before phase 2 parses unchanged, and bounded
   * because a chat's rules are written by clicks, not by a model: 200 keys is more
   * than a chat can click through, and an unbounded list would be a record a
   * corrupted save could grow without end.
   */
  approval_rules: z.array(z.string().min(1).max(400)).max(200).optional(),
  /**
   * Whether THIS chat has Clanker on (`src/sidebar/ToolApprovalService.ts`).
   * Optional so every record written before it parses unchanged, and stored here
   * rather than in a window-wide `workspaceState` key because the mode is a
   * property of one conversation: a window that kept it for every tab let a chat
   * that never armed it run unconfirmed, and the owner could not see which chat
   * was armed. Records written by older Forge have no field, so every chat starts
   * off after this update — the safer side of a mode that skips confirmations.
   */
  clanker: z.boolean().optional(),
  /** Provenance for expiring owner policy defaults; old records omit it. */
  clankerSource: z.literal('policy-default').optional(),
});

export type ConversationPersisted = Omit<
  z.infer<typeof conversationPersistedBaseSchema>,
  'display_question_records' | 'display_notices'
> & {
  display_question_records?: ConversationDisplayQuestionRecord[];
  display_notices?: ConversationDisplayNotice[];
};

export const conversationPersistedSchema = conversationPersistedBaseSchema.transform(
  (conversation): ConversationPersisted => {
    const { display_question_records: records, display_notices: notices, ...body } = conversation;
    return {
      ...body,
      ...(records !== undefined
        ? { display_question_records: validDisplayQuestionRecords(conversation.id, records) }
        : {}),
      ...(notices !== undefined ? { display_notices: notices } : {}),
    };
  },
);

export const sidebarSessionPersistedSchema = z.object({
  activeConversationId: z.string().min(1),
  conversations: z.array(conversationPersistedSchema),
  history: z.array(conversationPersistedSchema).optional(),
});

export type SidebarSessionPersisted = z.infer<typeof sidebarSessionPersistedSchema>;

/** In-memory conversation (full transcript including tool/tool_result for agent loop). */
export interface ConversationRuntime {
  id: string;
  title: string;
  /** Who named this chat: `prompt`, a person, or the daily retitle job. */
  title_source?: TitleSource;
  /**
   * Who started this chat, when an agent-bus prompt did: the sender name as the
   * bus wrote it (`claude`, `codex`, `copilot`, or another peer's name).
   *
   * Provenance, not a name: it survives a rename and a retitle, because who
   * opened the chat does not change when what it is called does. The sessions
   * panel renders it as a badge; it is never pasted into the title.
   */
  origin_agent?: string;
  createdAt: number;
  updatedAt: number;
  /** Inactivity clock; tool rounds, title edits and redraws do not change it. */
  retention_activity_at?: number;
  /** Persists across archive and restore; manual Close still works. */
  keep_open?: boolean;
  messages: ChatMessage[];
  /** Per-chat agent session links; only chatAgentLinks.ts mutates this field. */
  agentLinks?: AgentLinks;
  /** Conversation id that opened this worker through message_chat new_chat. */
  opened_by?: string;
  active_model?: string;
  /** Persistent external CLI sessions keyed by configured Forge model name. */
  cli_sessions?: Record<string, string>;
  /**
   * Set by /compact. The model is sent `summary` + `messages.slice(fromIndex)`;
   * `messages` itself is never truncated, so the sidebar transcript and the
   * persisted record stay whole. Clearing this restores full context.
   */
  compaction?: CompactionState;
  /** Model-facing context reductions; in-memory only, reset when history/model changes. */
  contextTrimState?: ContextTrimState;
  /**
   * Agent-maintained task ledger, written by the `update_plan` tool.
   *
   * Held as conversation state rather than as transcript text so compaction
   * cannot summarize it away: it is re-rendered into the model-facing messages
   * every round (see ModelTurn's prepareMessages). `updatedAt` is stamped by
   * the host, never by the model — the staleness the render displays would be
   * worthless if the writer could choose it.
   */
  plan?: ConversationPlan;
  /** FORGE.md text this chat's system prompt renders; see forgeInstructionsPin.ts. */
  forgeInstructionsPin?: ForgeInstructionsPin;
  /**
   * The skills catalog this conversation's system prompt renders, frozen when it
   * was first built (`src/skills/skillsService.ts`).
   *
   * Deliberately NOT persisted — `runtimeToPersisted` is an allowlist and these
   * two fields are not on it. A reload rebuilds it from the roots as they are
   * then, which is the plan's "catalog re-read at each new conversation" cell;
   * within a conversation it never changes, because a skill added mid-chat would
   * otherwise rewrite the prompt prefix and cost a cold re-read of the whole
   * transcript. `skillsCatalogSignature` is the roots-and-enabled-flag the text
   * was built from, so a workspace switch or a config change can invalidate it
   * without a skill install doing so.
   */
  skillsCatalog?: string;
  skillsCatalogSignature?: string;
  /** Durable presentation previews, deliberately separate from LLM messages. */
  displayDiffs?: ConversationDisplayDiff[];
  /** Durable transcript records keyed by the ask_user tool call id. */
  displayQuestionRecords?: ConversationDisplayQuestionRecord[];
  /** Durable status rows, deliberately absent from LLM messages. */
  displayNotices?: ConversationDisplayNotice[];
  /**
   * Set once the user has been told this conversation lost images to a reload.
   *
   * Deliberately NOT persisted — `runtimeToPersisted` is an allowlist and this
   * field is not on it. Resetting per session is the point: each reload is a
   * fresh loss worth announcing once, and repeating it every turn would be noise
   * for a condition the user cannot undo.
   */
  imageLossNoticed?: boolean;
  /**
   * `promptEstimateScale` from the last round's reported prompt, so the next
   * round's `max_tokens` is sized against this transcript's real token density.
   * Not persisted: after a reload the first round runs uncorrected, and the
   * server's own context 400 is the backstop (`serverReportedOutputRoom`).
   */
  promptEstimateScale?: number;
  /** Last measured request prefix and completion; in-memory only, like the scale. */
  promptAnchor?: PromptAnchor;
  /**
   * Accumulated active-agent time in milliseconds (model work + tool execution,
   * excluding approval waits). Set after each completed generation interval.
   */
  active_time_ms?: number;
  /**
   * Epoch ms when the current active interval began. Present while a turn is
   * in progress; cleared (and folded into `active_time_ms`) when the turn ends.
   */
  active_started_at?: number;
  /** Provider-reported prompt tokens accumulated for this conversation. */
  input_tokens?: number;
  /** Provider-reported completion tokens accumulated for this conversation. */
  output_tokens?: number;
  /** Prompt tokens in the most recent model request. */
  last_input_tokens?: number;
  /** Completion tokens in the most recent model request. */
  last_output_tokens?: number;
  /** Number of model requests that have reported usage. */
  model_request_count?: number;
  /**
   * Tool calls dispatched in this conversation. Counts what was *dispatched*,
   * so a refused or failed call still counts: it spent a round either way, and
   * a figure that only counted successes would understate exactly the turns
   * worth looking at.
   */
  tool_call_count?: number;
  /**
   * Epoch ms when outside content first entered this chat, and the reason its
   * next egress costs an approval card (`src/sidebar/untrustedExitPolicy.ts`).
   * Persisted, unlike the secret flag, because a reload clears an in-memory flag
   * while the page it came from stays in context. Stamped by `AgentLoop` from
   * the stored number, the live mark and the transcript — see `exfilTaint.ts`.
   */
  untrusted_since_ms?: number;
  /**
   * The approval keys this chat has been allowed to run without a card
   * (`src/sidebar/chatApprovalRules.ts`). Cleared by `/clear`, a new chat, Reset
   * approvals or deleting the chat, and never by turning Clanker off: an approval
   * the owner made outlives the shortcut they also have.
   */
  approval_rules?: string[];
  /**
   * Clanker mode for this chat and no other: keyed calls run with no card, and
   * anything with no key still gets one (`src/sidebar/chatApprovalRules.ts` §2 of
   * `docs/plans/ASK_ONCE_APPROVALS_PLAN.md`). Persisted with the chat, so a window
   * reload keeps the mode the owner armed, and cleared by `/clear`, a new chat or
   * deleting the chat. Turning it off revokes nothing: an approval the owner made
   * outlives the shortcut they also have.
   */
  clanker?: boolean;
  clankerSource?: 'policy-default';
}

export interface SidebarRuntime {
  activeConversationId: string;
  conversations: ConversationRuntime[];
  history: ConversationRuntime[];
}

/** A conversation by id, open tabs first, then archived history. */
export function findConversation(
  sidebar: SidebarRuntime,
  id: string,
): ConversationRuntime | undefined {
  return sidebar.conversations.find((c) => c.id === id) ?? sidebar.history.find((c) => c.id === id);
}

export function newConversationId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
