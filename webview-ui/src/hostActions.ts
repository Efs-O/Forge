import type { HostToWebview } from '../../src/sidebar/messageBridge';
import type { Action } from './appState';
import { toMessageAttachments } from './components/useAttachments';

type UserPromptMsg = Extract<HostToWebview, { type: 'userPrompt' }>;

/** Maps an addressed host prompt. A missing runtime id must never fall back to the active chat. */
export function hostUserPromptToAction(msg: UserPromptMsg): Action | undefined {
  if (!msg.conversationId) return undefined;
  if (msg.midTurn) {
    return {
      type: 'MID_TURN_TELL',
      text: msg.text,
      ...(msg.createdAt !== undefined ? { createdAt: msg.createdAt } : {}),
      convId: msg.conversationId,
    };
  }
  return {
    type: 'USER_SEND',
    text: msg.text,
    ...(msg.createdAt !== undefined ? { createdAt: msg.createdAt } : {}),
    convId: msg.conversationId,
    ...(msg.sender ? { sender: msg.sender } : {}),
    ...(msg.attachments?.length ? { attachments: toMessageAttachments(msg.attachments) } : {}),
  };
}

/**
 * Host messages that map one-to-one onto a reducer action. Returns `undefined`
 * for every message App handles itself (local state, side effects, or ignored
 * legacy shapes), so App's switch only lists those.
 */
export function hostMessageToAction(msg: HostToWebview): Action | undefined {
  switch (msg.type) {
    case 'generationStarted':
      return { type: 'GENERATION_STARTED', convId: msg.conversationId };
    case 'token':
      return {
        type: 'TOKEN',
        text: msg.text,
        ...(msg.createdAt !== undefined ? { createdAt: msg.createdAt } : {}),
        convId: msg.conversationId,
      };
    case 'notice':
      return {
        type: 'NOTICE',
        message: msg.message,
        convId: msg.conversationId,
        preformatted: msg.preformatted,
      };
    case 'reasoningToken':
      return {
        type: 'REASONING_TOKEN',
        text: msg.text,
        ...(msg.createdAt !== undefined ? { createdAt: msg.createdAt } : {}),
        convId: msg.conversationId,
      };
    case 'done':
      return { type: 'DONE', convId: msg.conversationId, finishReason: msg.finishReason };
    case 'toolCallProgress':
      return {
        type: 'TOOL_CALL_PROGRESS',
        convId: msg.conversationId,
        index: msg.index,
        toolName: msg.toolName,
        tokens: msg.tokens,
        ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
        ...(msg.target ? { target: msg.target } : {}),
      };
    case 'error':
      return { type: 'ERROR', message: msg.message, convId: msg.conversationId };
    case 'ready':
      return { type: 'READY', convId: msg.conversationId };
    case 'backendStarting':
      return { type: 'BACKEND_STARTING', message: msg.message, convId: msg.conversationId };
    case 'backendDown':
      return { type: 'BACKEND_DOWN', message: msg.message, convId: msg.conversationId };
    case 'models':
      return { type: 'MODELS', models: msg.models, active: msg.active };
    case 'checkpointReady':
      return { type: 'CHECKPOINT_READY', convId: msg.conversationId, stats: msg.stats };
    case 'checkpointDismissed':
      return { type: 'CHECKPOINT_DISMISSED', convId: msg.conversationId };
    case 'toolActivity':
      return {
        type: 'TOOL_ACTIVITY',
        toolName: msg.toolName,
        toolCallId: msg.toolCallId,
        detail: msg.detail,
        convId: msg.conversationId,
      };
    case 'toolResult':
      return {
        type: 'TOOL_RESULT',
        toolName: msg.toolName,
        toolCallId: msg.toolCallId,
        label: msg.label,
        text: msg.text,
        totalChars: msg.totalChars,
        ...(msg.filePath ? { filePath: msg.filePath } : {}),
        ...(msg.isError ? { isError: true } : {}),
        convId: msg.conversationId,
      };
    case 'fileDiff':
      return {
        type: 'FILE_DIFF',
        toolCallId: msg.toolCallId,
        filePath: msg.filePath,
        hunks: msg.hunks,
        isNew: msg.isNew,
        isDeleted: msg.isDeleted,
        convId: msg.conversationId,
      };
    case 'clankerChanged':
      return { type: 'CLANKER_CHANGED', enabled: msg.enabled };
    case 'remoteStatus':
      return { type: 'REMOTE_STATUS', transports: msg.transports, paired: msg.paired };
    case 'activityView':
      return { type: 'ACTIVITY_VIEW', mode: msg.mode };
    case 'thinkingDisplay':
      return { type: 'THINKING_DISPLAY', mode: msg.mode };
    default:
      return undefined;
  }
}
