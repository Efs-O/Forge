import type { ForgeConfig } from '../config/types';
import type { ChatMessage } from '../llm/types';
import { classifyModelRoute, isCloudModelRoute } from '../llm/ModelRouteClassifier';
import type { WorkerRunResult } from './types';

const DELEGATION_INSTRUCTIONS = `Worker delegation is available through Forge tools.
When the user's objective can be split into bounded independent work, choose configured workers yourself: call list_worker_models for exact model names, then call dispatch_workers with strict structured arguments. Do not ask the user to supply tool fields that you can derive. Use read access for research or review; grant write access only with exact non-overlapping paths. After workers finish, synthesize their results and review only their verified changed paths.`;

/** Cap on catalog lines injected into the system prompt — keep it small; the
 *  list_worker_models tool remains available for the full/long catalog. */
const MAX_CATALOG_ENTRIES = 20;

/**
 * Build a compact one-line-per-model worker catalog ("short_name/alias →
 * full name") for eligible dispatch_workers targets, so small coordinator
 * models don't need a list_worker_models round-trip for common cases.
 * Mirrors the cloud-worker filtering in dispatchWorkersTool's
 * `list_worker_models` handler. Returns '' when there is nothing to show.
 */
export function buildWorkerCatalog(config: ForgeConfig, includeCloud: boolean): string {
  const aliasByTarget = new Map<string, string>();
  for (const [alias, target] of Object.entries(config.aliases ?? {})) {
    const base = target.split('@', 1)[0];
    if (base && !aliasByTarget.has(base)) aliasByTarget.set(base, alias);
  }

  const lines: string[] = [];
  for (const model of config.models) {
    if (lines.length >= MAX_CATALOG_ENTRIES) break;
    const cloud = isCloudModelRoute(classifyModelRoute(model));
    if (cloud && !includeCloud) continue;
    const label = model.short_name ?? aliasByTarget.get(model.name);
    lines.push(label && label !== model.name ? `${label} → ${model.name}` : model.name);
  }
  if (lines.length === 0) return '';
  return `Available workers (dispatch_workers "model" field accepts these):\n${lines.join('\n')}`;
}

export function addWorkerDelegationInstructions(
  messages: ChatMessage[],
  enabled: boolean,
  catalog?: string,
): ChatMessage[] {
  if (!enabled || messages[0]?.role !== 'system') return messages;
  const first = messages[0];
  const content = typeof first.content === 'string' ? first.content : '';
  const suffix = catalog ? `${DELEGATION_INSTRUCTIONS}\n\n${catalog}` : DELEGATION_INSTRUCTIONS;
  return [{ ...first, content: `${content}\n\n${suffix}` }, ...messages.slice(1)];
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
