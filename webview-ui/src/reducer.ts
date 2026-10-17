import { findPendingToolRow, mkId, type AppMessage } from './messageOps';
import { withoutCall, withoutConversation, withProgress } from './pendingToolCalls';
import type { Action, State } from './appState';
import { formatDuration } from '../../src/util/formatDuration';
import { applySessionSync } from './sessionSyncReducer';

export type { AppMessage } from './messageOps';
export type { Action, State } from './appState';
export {
  initialState,
  selectMessages,
  selectStreaming,
  selectGenerating,
  selectCheckpointPending,
  selectCheckpointStats,
} from './appState';

function appendToConv(state: State, convId: string, msg: AppMessage): State {
  const existing = state.messagesById[convId] ?? [];
  return { ...state, messagesById: { ...state.messagesById, [convId]: [...existing, msg] } };
}

function updateLastInConv(
  state: State,
  convId: string,
  updater: (last: AppMessage) => AppMessage,
): State {
  const existing = state.messagesById[convId] ?? [];
  if (existing.length === 0) return state;
  const updated = [...existing.slice(0, -1), updater(existing[existing.length - 1]!)];
  return { ...state, messagesById: { ...state.messagesById, [convId]: updated } };
}

function resolveConvId(state: State, convId?: string): string {
  return convId ?? state.activeConversationId;
}

function withoutKey<V>(map: Map<string, V>, id: string): Map<string, V> {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}

function withoutId(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set;
  const next = new Set(set);
  next.delete(id);
  return next;
}

function clearRecoveredBackendStartErrors(state: State, convId: string): State {
  const existing = state.messagesById[convId] ?? [];
  const remaining = existing.filter(
    (message) =>
      message.role !== 'error' ||
      !(
        message.content.startsWith('Backend failed to start:') ||
        message.content === 'Backend start cancelled.'
      ),
  );
  if (remaining.length === existing.length) return state;
  return { ...state, messagesById: { ...state.messagesById, [convId]: remaining } };
}

/**
 * Close an open reasoning span on the conversation's last row.
 *
 * A reasoning-only round ends at a tool call, not at prose, so `TOKEN` alone
 * would leave every thinking-then-tool round unmeasured - which on this agent
 * loop is most of them.
 */
function sealReasoningSpan(state: State, cid: string): State {
  const rows = state.messagesById[cid] ?? [];
  const last = rows[rows.length - 1];
  if (last?.role !== 'assistant') return state;
  if (last.reasoningStartedAt === undefined || last.reasoningMs !== undefined) return state;
  return updateLastInConv(state, cid, (m) => ({
    ...m,
    reasoningMs: Date.now() - (m.reasoningStartedAt ?? Date.now()),
  }));
}

/**
 * ` · 2.1 s` for a wait worth reporting, and nothing at all for one that is not.
 *
 * The row only exists when the acquire ran past BACKEND_START_NOTICE_MS, so
 * every one of these is at least half a second; the floor here guards the case
 * where the READY frame follows almost immediately after, where a duration says
 * less than no duration would.
 */
function elapsedSuffix(ms: number): string {
  const elapsed = formatDuration(ms, 500);
  return elapsed ? ` · ${elapsed}` : '.';
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'GENERATION_STARTED': {
      const cid = resolveConvId(state, action.convId);
      return {
        ...state,
        streamingIds: new Set([...state.streamingIds, cid]),
        generatingIds: new Set([...state.generatingIds, cid]),
      };
    }

    case 'USER_SEND': {
      const cid = resolveConvId(state, action.convId);
      const existing = state.messagesById[cid] ?? [];
      const last = existing[existing.length - 1];
      // Strip stale diff cards and trailing empty assistant placeholder from previous turn
      const base = existing
        .filter((m) => m.role !== 'diff')
        // A new prompt is an explicit retry or a model switch. The previous
        // provider failure remains useful until then, but must not look like
        // it is being replayed by the newly selected model.
        .filter((m) => m.role !== 'error')
        .filter(
          (m, _i, arr) =>
            !(m.role === 'assistant' && m.content === '' && m === arr[arr.length - 1]),
        );
      void last;
      return {
        ...state,
        streamingIds: new Set([...state.streamingIds, cid]),
        generatingIds: new Set([...state.generatingIds, cid]),
        checkpointPendingIds: withoutId(state.checkpointPendingIds, cid),
        messagesById: {
          ...state.messagesById,
          [cid]: [
            ...base,
            {
              id: mkId(),
              role: 'user',
              content: action.text,
              createdAt: action.createdAt ?? Date.now(),
              ...(action.sender ? { agentSender: action.sender } : {}),
              ...(action.attachments?.length ? { attachments: action.attachments } : {}),
            },
          ],
        },
      };
    }
    case 'MID_TURN_TELL': {
      // Inline in the running turn; the next round's tokens open a new bubble.
      const cid = resolveConvId(state, action.convId);
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'user',
        content: action.text,
        createdAt: action.createdAt ?? Date.now(),
        midTurn: true,
      });
    }
    case 'TOKEN': {
      const cid = resolveConvId(state, action.convId);
      const existing = state.messagesById[cid] ?? [];
      const last = existing[existing.length - 1];
      // The final round commonly streams reasoning before answer text. Keep
      // that reasoning as its own Thinking row instead of converting it into
      // a normal assistant bubble (which does not render `reasoning`).
      if (last?.role === 'assistant' && last.content === '' && last.reasoning) {
        // The answer starting ends the thinking row it follows: unsealed, that
        // row's live timer counted on for the rest of the turn.
        return appendToConv(sealReasoningSpan(state, cid), cid, {
          id: mkId(),
          role: 'assistant',
          content: action.text,
          createdAt: action.createdAt ?? Date.now(),
        });
      }
      if (last?.role === 'assistant') {
        return updateLastInConv(state, cid, (m) => ({
          ...m,
          content: m.content + action.text,
          // Prose starting is the end of the reasoning phase. Stamped once:
          // every later token would otherwise re-measure to "now".
          ...(m.reasoningStartedAt !== undefined && m.reasoningMs === undefined
            ? { reasoningMs: Date.now() - m.reasoningStartedAt }
            : {}),
        }));
      }
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'assistant',
        content: action.text,
        createdAt: action.createdAt ?? Date.now(),
      });
    }
    case 'NOTICE': {
      const cid = resolveConvId(state, action.convId);
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'system',
        content: action.message,
        ...(action.preformatted ? { preformatted: true } : {}),
      });
    }
    case 'REASONING_TOKEN': {
      const cid = resolveConvId(state, action.convId);
      const existing = state.messagesById[cid] ?? [];
      const last = existing[existing.length - 1];
      if (last?.role === 'assistant') {
        return updateLastInConv(state, cid, (m) => ({
          ...m,
          reasoning: (m.reasoning ?? '') + action.text,
          reasoningStartedAt: m.reasoningStartedAt ?? Date.now(),
          createdAt: m.createdAt ?? action.createdAt ?? Date.now(),
        }));
      }
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'assistant',
        content: '',
        reasoning: action.text,
        createdAt: action.createdAt ?? Date.now(),
        reasoningStartedAt: Date.now(),
      });
    }

    case 'DONE': {
      const cid = resolveConvId(state, action.convId);
      const newStreaming = new Set(state.streamingIds);
      const newGenerating = new Set(state.generatingIds);
      newStreaming.delete(cid);
      newGenerating.delete(cid);
      // A turn that ends on reasoning alone - cancelled, or cut off by the
      // output budget - still gets its span closed here rather than left open.
      const ended: State = {
        ...sealReasoningSpan(state, cid),
        streamingIds: newStreaming,
        generatingIds: newGenerating,
        pendingToolCallsById: withoutConversation(state.pendingToolCallsById, cid),
      };
      // A stopped turn otherwise ends on whatever bubble was last, which reads
      // as a hang. Live only: a reload rebuilds rows from history without it.
      return action.finishReason === 'cancelled' && state.streamingIds.has(cid)
        ? appendToConv(ended, cid, { id: mkId(), role: 'system', content: 'Stopped.' })
        : ended;
    }

    case 'ERROR': {
      const cid = resolveConvId(state, action.convId);
      const newStreaming = new Set(state.streamingIds);
      const newGenerating = new Set(state.generatingIds);
      newStreaming.delete(cid);
      newGenerating.delete(cid);
      // Seal like DONE: an open span would keep its live timer counting forever.
      return appendToConv(
        {
          ...sealReasoningSpan(state, cid),
          streamingIds: newStreaming,
          generatingIds: newGenerating,
          pendingToolCallsById: withoutConversation(state.pendingToolCallsById, cid),
        },
        cid,
        { id: mkId(), role: 'error', content: action.message },
      );
    }

    case 'READY': {
      const cid = resolveConvId(state, action.convId);
      // The flag flips either way — it drives the composer placeholder and the
      // recovered-error sweep, neither of which depends on a row being shown.
      const next: State = {
        ...clearRecoveredBackendStartErrors(state, cid),
        backendReady: true,
        backendStartRowIds: withoutKey(state.backendStartRowIds, cid),
      };
      const start = state.backendStartRowIds.get(cid);
      if (start === undefined) return next;
      // Rewrite the announcement rather than answering it. The pair used to
      // accumulate, leaving "Starting backend, please wait…" in the transcript
      // forever above a "Backend ready." that had made it untrue.
      const content = `Backend ready${elapsedSuffix(Date.now() - start.startedAt)}`;
      return {
        ...next,
        messagesById: {
          ...next.messagesById,
          [cid]: (next.messagesById[cid] ?? []).map((row) =>
            row.id === start.id ? { ...row, content } : row,
          ),
        },
      };
    }

    case 'BACKEND_STARTING': {
      const cid = resolveConvId(state, action.convId);
      const rowId = mkId();
      return appendToConv(
        {
          ...state,
          backendReady: false,
          backendStartRowIds: new Map(state.backendStartRowIds).set(cid, {
            id: rowId,
            startedAt: Date.now(),
          }),
        },
        cid,
        { id: rowId, role: 'system', content: action.message },
      );
    }

    case 'BACKEND_DOWN': {
      const cid = resolveConvId(state, action.convId);
      const newStreaming = new Set(state.streamingIds);
      const newGenerating = new Set(state.generatingIds);
      newStreaming.delete(cid);
      newGenerating.delete(cid);
      return appendToConv(
        {
          ...state,
          streamingIds: newStreaming,
          generatingIds: newGenerating,
          backendReady: false,
          // The failure row is the answer to the announcement; a later READY
          // must not also reply to it.
          backendStartRowIds: withoutKey(state.backendStartRowIds, cid),
        },
        cid,
        { id: mkId(), role: 'error', content: action.message },
      );
    }

    case 'MODELS':
      return { ...state, models: action.models, activeModel: action.active };

    case 'SET_MODEL':
      return { ...state, activeModel: action.name };

    case 'TOOL_CALL_PROGRESS': {
      const cid = resolveConvId(state, action.convId);
      // Writing a call's arguments ends the thinking before it.
      const sealed = sealReasoningSpan(state, cid);
      const { index, toolCallId, toolName, target, tokens } = action;
      const call = {
        index,
        toolName,
        tokens,
        startedAt: Date.now(),
        ...(toolCallId ? { toolCallId } : {}),
      };
      return {
        ...sealed,
        pendingToolCallsById: withProgress(sealed.pendingToolCallsById, cid, {
          ...call,
          ...(target ? { target } : {}),
        }),
      };
    }

    case 'TOOL_ACTIVITY': {
      const cid = resolveConvId(state, action.convId);
      const landed: State = {
        ...sealReasoningSpan(state, cid),
        pendingToolCallsById: withoutCall(state.pendingToolCallsById, cid, action.toolCallId),
      };
      return appendToConv(landed, cid, {
        id: mkId(),
        role: 'tool' as const,
        content: action.detail ? `${action.toolName} → ${action.detail}` : action.toolName,
        toolName: action.toolName,
        toolStartedAt: Date.now(),
        ...(action.detail ? { toolDetail: action.detail } : {}),
        ...(action.detail ? { toolTarget: action.detail } : {}),
        ...(action.toolCallId ? { toolCallId: action.toolCallId } : {}),
      });
    }

    case 'TOOL_RESULT': {
      const cid = resolveConvId(state, action.convId);
      const existing = state.messagesById[cid] ?? [];
      const filled = {
        toolResult: action.text,
        toolResultTotal: action.totalChars,
        ...(action.filePath ? { toolFilePath: action.filePath } : {}),
        ...(action.isError ? { toolIsError: true } : {}),
      };
      // Upgrade the pending activity row for this call rather than adding a
      // second row — one line per tool call, gaining its result when it lands.
      const pending = findPendingToolRow(existing, action.toolName, action.toolCallId);
      if (pending >= 0) {
        const updated = [...existing];
        const startedAt = existing[pending]!.toolStartedAt;
        updated[pending] = {
          ...existing[pending]!,
          content: `${action.toolName} → ${action.label}`,
          ...(existing[pending]!.toolDetail !== undefined
            ? { toolDetail: existing[pending]!.toolDetail }
            : {}),
          // Only the announce/return pair can be timed. A result arriving with
          // no activity row before it (the fallback branch below) is a call
          // Forge never saw start, so it gets no duration rather than a wrong one.
          ...(startedAt !== undefined ? { toolMs: Date.now() - startedAt } : {}),
          ...filled,
        };
        return { ...state, messagesById: { ...state.messagesById, [cid]: updated } };
      }
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'tool' as const,
        content: `${action.toolName} → ${action.label}`,
        toolName: action.toolName,
        ...filled,
      });
    }

    case 'FILE_DIFF': {
      const cid = resolveConvId(state, action.convId);
      return appendToConv(state, cid, {
        id: mkId(),
        role: 'diff' as const,
        content: action.filePath,
        ...(action.toolCallId ? { toolCallId: action.toolCallId } : {}),
        diffHunks: action.hunks,
        diffIsNew: action.isNew,
        diffIsDeleted: action.isDeleted,
      });
    }

    case 'CHECKPOINT_READY': {
      const cid = resolveConvId(state, action.convId);
      return {
        ...state,
        checkpointPendingIds: new Set([...state.checkpointPendingIds, cid]),
        checkpointStatsById: new Map(state.checkpointStatsById).set(cid, action.stats),
      };
    }

    case 'CHECKPOINT_DISMISSED': {
      const cid = resolveConvId(state, action.convId);
      return { ...state, checkpointPendingIds: withoutId(state.checkpointPendingIds, cid) };
    }

    case 'CLANKER_CHANGED':
      return { ...state, clankerMode: action.enabled };

    case 'REMOTE_STATUS':
      return { ...state, remote: { transports: action.transports, paired: action.paired } };

    case 'ACTIVITY_VIEW':
      return state.activityView === action.mode ? state : { ...state, activityView: action.mode };

    case 'THINKING_DISPLAY':
      return state.thinkingDisplay === action.mode
        ? state
        : { ...state, thinkingDisplay: action.mode };

    case 'SESSION_SYNC':
      return applySessionSync(state, action);

    default:
      return state;
  }
}
