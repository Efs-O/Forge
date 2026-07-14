import type { ChatMessage } from '../llm/types';
import type { WorkerRunResult } from './types';

const DELEGATION_INSTRUCTIONS = `Worker delegation is available through Forge tools.
When the user's objective can be split into bounded independent work, choose configured workers yourself: call list_worker_models for exact model names, then call dispatch_workers with strict structured arguments. Do not ask the user to supply tool fields that you can derive. Use read access for research or review; grant write access only with exact non-overlapping paths. After workers finish, synthesize their results and review only their verified changed paths.`;

export function addWorkerDelegationInstructions(
  messages: ChatMessage[],
  enabled: boolean,
): ChatMessage[] {
  if (!enabled || messages[0]?.role !== 'system') return messages;
  const first = messages[0];
  const content = typeof first.content === 'string' ? first.content : '';
  return [{ ...first, content: `${content}\n\n${DELEGATION_INSTRUCTIONS}` }, ...messages.slice(1)];
}

export function buildWorkerReviewPrompt(result: WorkerRunResult, requestedTask?: string): string {
  const task =
    requestedTask ??
    'Review the completed worker changes for correctness, consistency, and obvious missing tests.';
  const changedPaths = [...new Set(result.workers.flatMap((worker) => worker.changedPaths))];
  const scope =
    changedPaths.length > 0
      ? `Verified worker-changed paths:\n${changedPaths.map((entry) => `- ${entry}`).join('\n')}\nInspect these paths first. Do not attribute unrelated pre-existing worktree changes to this worker run.`
      : 'Workers reported no verified file changes. Summarize their statuses and outputs. Do not run repository-wide git status or diff merely to look for changes.';
  return `${task}\n\n${scope}\n\nWorker run result:\n${JSON.stringify(result, null, 2)}`;
}
