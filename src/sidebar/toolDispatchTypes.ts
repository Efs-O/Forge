import type { DiffHunk } from './messageBridge';
import type { ChatMessage, ToolCall } from '../llm/types';
import type { CheckpointSession } from '../checkpoint/CheckpointStack';
import type { ToolBudget } from '../tools/ToolBudget';
import type { ToolHandlerResult, ToolPermission } from '../tools/ToolRegistry';
import type { ToolOutputLimits } from '../tools/toolOutputLimits';
import type { CheckinStage } from '../agent/elapsedTimeNote';
import type { ConversationRuntime, PlanItem } from './sessionTypes';
import type { QuestionAnswerRecord } from '../util/questionAnswers';
import { recordToolArgumentRepair, type ToolArgumentRepairInfo } from '../tools/argCoercion';

export interface RecordedFileDiff {
  toolCallId: string;
  filePath: string;
  hunks: DiffHunk[] | null;
  isNew: boolean;
  isDeleted: boolean;
}

export interface ToolDispatchModelContext {
  modelName: string;
  isVisionModel: boolean;
  outputLimits?: ToolOutputLimits;
  conversation: ConversationRuntime;
  checkpoint?: CheckpointSession;
  persistConversation: () => void;
  setCheckin?: (minutes: number, byThen: CheckinStage) => { dueAt: number } | undefined;
}

export interface ToolDispatchRoundContext {
  allowed: Set<ToolPermission>;
  convId: string | undefined;
  signal: AbortSignal | undefined;
  checkpoint: CheckpointSession | undefined;
  budget: ToolBudget | undefined;
  recordFileDiff: ((diff: RecordedFileDiff) => void) | undefined;
  unavailableTools: ReadonlyMap<string, string> | undefined;
  setPlan: ((items: PlanItem[]) => void) | undefined;
  tellArrived: ((callback: () => void) => () => void) | undefined;
  modelContext: ToolDispatchModelContext | undefined;
}

export function toolResultText(result: ToolHandlerResult): string {
  return typeof result === 'string' ? result : result.text;
}

export function toolResultContent(result: ToolHandlerResult): ChatMessage['content'] {
  if (typeof result === 'string') return result;
  return 'content' in result ? result.content : result.text;
}

export function toolResultQuestionRecord(
  result: ToolHandlerResult,
): QuestionAnswerRecord | undefined {
  return typeof result === 'string' || !('questionRecord' in result)
    ? undefined
    : result.questionRecord;
}

/** The one shape of a tool result message, carrying its own measured duration. */
export function toolResultMessage(
  tc: ToolCall,
  content: ChatMessage['content'],
  startedAt: number,
  argumentRepair?: ToolArgumentRepairInfo,
): ChatMessage {
  const elapsed = Date.now() - startedAt;
  const message: ChatMessage = {
    role: 'tool',
    content,
    tool_call_id: tc.id,
    name: tc.function.name,
    ...(elapsed > 0 ? { toolMs: elapsed } : {}),
    stampedAt: Date.now(),
  };
  if (argumentRepair) recordToolArgumentRepair(message, argumentRepair);
  return message;
}
