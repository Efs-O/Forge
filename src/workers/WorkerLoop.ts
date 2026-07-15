import type { ForgeConfig, ModelConfig } from '../config/types';
import { runToolCallingLoop } from '../agent/ToolCallingLoop';
import type { ChatMessage } from '../llm/types';
import type { ToolRegistry } from '../tools/ToolRegistry';
import { capResultText } from '../tools/resultCap';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import {
  MAX_WORKER_FINAL_CHARS,
  MAX_WORKER_TOOL_CALLS,
  MAX_WORKER_TOOL_ROUNDS,
  clampWorkerOutputTokens,
} from './limits';
import type { WorkerResult, WorkerRunContext, WorkerSpec } from './types';
import type { WorkerAccessPolicy } from './WorkerAccessPolicy';

export interface WorkerExecutionTarget {
  model: ModelConfig;
  baseUrl: string;
  apiKey?: string;
  bestEffort: boolean;
}

class WorkerDeclinedError extends Error {}
class WorkerToolError extends Error {}

export class WorkerLoop {
  constructor(
    private readonly getConfig: () => ForgeConfig,
    private readonly registry: ToolRegistry,
  ) {}

  async run(
    spec: WorkerSpec,
    target: WorkerExecutionTarget,
    policy: WorkerAccessPolicy,
    context: WorkerRunContext,
  ): Promise<WorkerResult> {
    const scope = policy.scope();
    const allowed = resolveToolPermissions(this.getConfig());
    const toolDefinitions = this.registry.definitions(allowed, scope);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: [
          'You are a Forge coding worker. Complete only the assigned task.',
          spec.access === 'write'
            ? `Writable files (exact paths only):\n${spec.allowed_paths?.map((p) => `- ${p}`).join('\n')}`
            : 'This is a read-only task. You have no write tools and must not claim to modify files.',
          spec.access === 'write'
            ? 'For multiple precise changes in one file, prefer apply_line_edits after reading the current lines; expected_lines must match exactly.'
            : '',
          'Use tool calls for every write. You may read and list only inside the workspace.',
          'Do not claim a file changed unless a write tool succeeded. Do not call unavailable tools.',
          'Finish with a concise summary of work actually completed.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Task:\n${spec.task}`,
          spec.context_files?.length
            ? `Suggested starting files:\n${spec.context_files.map((p) => `- ${p}`).join('\n')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ];
    let toolCalls = 0;
    try {
      const result = await runToolCallingLoop({
        baseUrl: target.baseUrl,
        model: target.model,
        messages,
        toolDefinitions,
        signal: context.abortSignal,
        maxRounds: MAX_WORKER_TOOL_ROUNDS,
        maxOutputTokens: clampWorkerOutputTokens(spec.max_output_tokens),
        nativeTools: !target.model.strip_tools,
        stripAllTools: false,
        stripThinkingChannels: target.model.think === false,
        ...(target.apiKey ? { apiKey: target.apiKey } : {}),
        dispatchToolCalls: async (calls, history) => {
          toolCalls += calls.length;
          if (toolCalls > MAX_WORKER_TOOL_CALLS) {
            throw new WorkerToolError(`Worker exceeded ${MAX_WORKER_TOOL_CALLS} tool calls.`);
          }
          const before = history.length;
          try {
            await context.toolDispatch.dispatch(
              calls,
              allowed,
              history,
              context.conversationId,
              context.abortSignal,
              scope,
              context.checkpoint,
            );
          } catch (err) {
            throw new WorkerToolError(err instanceof Error ? err.message : String(err));
          }
          const declined = history
            .slice(before)
            .some(
              (message) =>
                message.role === 'tool' &&
                typeof message.content === 'string' &&
                message.content.startsWith('User declined:'),
            );
          if (declined) throw new WorkerDeclinedError('Worker write was declined by the user.');
        },
      });
      const changedPaths = policy.changedPaths();
      return {
        id: spec.id,
        model: spec.model,
        status: changedPaths.length > 0 ? 'completed' : 'completed_no_changes',
        summary: capResultText(result.finalText, MAX_WORKER_FINAL_CHARS),
        changedPaths,
        ...(target.bestEffort ? { bestEffort: true } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = context.abortSignal.aborted;
      return {
        id: spec.id,
        model: spec.model,
        status:
          err instanceof WorkerDeclinedError
            ? 'declined'
            : aborted
              ? 'cancelled'
              : err instanceof WorkerToolError
                ? 'failed_tool'
                : 'failed_model',
        summary: '',
        changedPaths: policy.changedPaths(),
        error: message,
        ...(target.bestEffort ? { bestEffort: true } : {}),
      };
    }
  }
}
