import type { ForgeConfig, ModelConfig } from '../config/types';
import { runToolCallingLoop } from '../agent/ToolCallingLoop';
import type { ChatMessage } from '../llm/types';
import type { ToolRegistry } from '../tools/ToolRegistry';
import { capResultText } from '../tools/resultCap';
import { resolveToolPermissions } from '../tools/PermissionResolver';
import { ToolBudget } from '../tools/ToolBudget';
import { runCliWorker } from '../agents/CliWorkerRunner';
import { inferCliAgentName } from '../agents/types';
import {
  MAX_WORKER_FINAL_CHARS,
  MAX_WORKER_TOOL_CALLS,
  MAX_WORKER_TOOL_ROUNDS,
  clampWorkerOutputTokens,
} from './limits';
import type { WorkerResult, WorkerRunContext, WorkerSpec } from './types';
import type { WorkerAccessPolicy } from './WorkerAccessPolicy';
import { ToolLoopDetectedError } from '../agent/ToolLoopGuard';
import type { ForgeInstructionsLoader } from '../llm/ForgeInstructionsLoader';

export interface WorkerExecutionTarget {
  model: ModelConfig;
  /** Set to 'cli' for `provider: cli` workers — bypasses the LLM tool-calling
   *  loop entirely and runs CliAgentDriver instead (baseUrl/apiKey unused). */
  kind?: 'cli';
  baseUrl?: string;
  apiKey?: string;
  bestEffort: boolean;
}

class WorkerDeclinedError extends Error {}
class WorkerToolError extends Error {}

export function buildWorkerSystemPrompt(
  spec: WorkerSpec,
  workspaceRoot: string,
  projectInstructions?: string,
): string {
  return [
    'You are a Forge coding worker. Complete only the assigned task.',
    `Execution context: repo_root=${workspaceRoot}; platform=${process.platform}; arch=${process.arch}; path_style=${process.platform === 'win32' ? 'windows' : 'posix'}; command_contract=executable-plus-argv; no shell operators.`,
    process.platform === 'win32'
      ? 'Valid command example: exec_command {"command":"npm.cmd","args":["test"],"tail_lines":20}. Do not send PowerShell syntax as argv.'
      : 'Valid command example: exec_command {"command":"npm","args":["test"],"tail_lines":20}. Do not send pipes or redirects as argv.',
    spec.access === 'write'
      ? `Writable files (exact paths only):\n${spec.allowed_paths?.map((path) => `- ${path}`).join('\n')}`
      : 'This is a read-only task. You have no write tools and must not claim to modify files.',
    spec.access === 'write'
      ? 'For multiple precise changes in one file, prefer apply_line_edits after reading the current lines; expected_lines must match exactly.'
      : '',
    'Use tool calls for every write. You may read and list only inside the workspace.',
    'Do not claim a file changed unless a write tool succeeded. Do not call unavailable tools.',
    projectInstructions
      ? `--- Repository Instructions ---\n${projectInstructions}\n--- End Repository Instructions ---`
      : '',
    'Finish with a concise summary of work actually completed.',
  ]
    .filter(Boolean)
    .join('\n');
}

export class WorkerLoop {
  constructor(
    private readonly getConfig: () => ForgeConfig,
    private readonly registry: ToolRegistry,
    private readonly workspaceRoot: string,
    private readonly instructionsLoader?: ForgeInstructionsLoader,
  ) {}

  async run(
    spec: WorkerSpec,
    target: WorkerExecutionTarget,
    policy: WorkerAccessPolicy,
    context: WorkerRunContext,
    onProgress?: (line: string) => void,
  ): Promise<WorkerResult> {
    if (target.kind === 'cli') {
      const timeoutMs = this.getConfig().exec?.timeout_ms;
      return runCliWorker({
        spec,
        cliName: inferCliAgentName(target.model.cli ?? target.model.name),
        cliExecutable: target.model.cli ?? target.model.name,
        workspaceRoot: this.workspaceRoot,
        writablePaths: policy.writablePaths(),
        checkpoint: context.checkpoint,
        abortSignal: context.abortSignal,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(onProgress ? { onProgress } : {}),
      });
    }
    const scope = policy.scope();
    const allowed = resolveToolPermissions(this.getConfig());
    // One budget per worker run — target.model is already resolveRequestModel()'d
    // (group tools/tool_call_limits merged) by WorkerOrchestrationService.
    const budget = new ToolBudget(target.model);
    const toolDefinitions = budget.filterDefinitions(this.registry.definitions(allowed, scope));
    const instructionTarget = spec.context_files?.[0] ?? spec.allowed_paths?.[0];
    const projectInstructions = this.instructionsLoader?.instructionsFor(instructionTarget);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildWorkerSystemPrompt(spec, this.workspaceRoot, projectInstructions),
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
      // target.kind !== 'cli' was already handled above — every non-cli
      // target is built with a real baseUrl (WorkerOrchestrationService.buildTargets).
      const result = await runToolCallingLoop({
        baseUrl: target.baseUrl as string,
        model: target.model,
        messages,
        toolDefinitions,
        signal: context.abortSignal,
        maxRounds: MAX_WORKER_TOOL_ROUNDS,
        maxOutputTokens: clampWorkerOutputTokens(spec.max_output_tokens),
        nativeTools: !target.model.strip_tools,
        stripAllTools: false,
        stripThinkingChannels: target.model.think === false,
        isMutatingTool: (name) => this.registry.get(name)?.mutation !== undefined,
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
              undefined,
              budget,
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
      // The loop reports the round cap instead of throwing it, so the worker's
      // `exhausted_steps` verdict is decided here rather than in the catch below.
      if (result.hitRoundCap) {
        return {
          id: spec.id,
          model: spec.model,
          status: 'exhausted_steps',
          summary: capResultText(result.finalText, MAX_WORKER_FINAL_CHARS),
          changedPaths: policy.changedPaths(),
          error: `Worker stopped after ${MAX_WORKER_TOOL_ROUNDS} tool rounds without finishing.`,
          ...(target.bestEffort ? { bestEffort: true } : {}),
        };
      }
      if (result.finishReason === 'length' && !result.finalText.trim()) {
        return {
          id: spec.id,
          model: spec.model,
          status: 'exhausted_tokens',
          summary: '',
          changedPaths: policy.changedPaths(),
          error: 'Worker produced no output before reaching its completion-token limit.',
          ...(target.bestEffort ? { bestEffort: true } : {}),
        };
      }
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
              : err instanceof ToolLoopDetectedError
                ? 'failed_loop'
                : /exceeded maximum tool rounds/.test(message)
                  ? 'exhausted_steps'
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
