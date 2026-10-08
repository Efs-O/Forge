import type { CliAgentDriver } from '../agents/CliAgentDriver';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import { inferCliAgentName, type CliAgentRunResult } from '../agents/types';
import { capResultText } from '../tools/resultCap';
import {
  buildCliDelegationReplyContract,
  CLI_DELEGATION_TIMEOUT_MS,
  MAX_DELEGATION_RESULT_CHARS,
} from './limits';
import type { DelegationTarget } from './eligibility';
import type { LocalDelegationRequest, LocalDelegationResult } from './LocalDelegationService';

/**
 * ask_local_agent for a `provider: cli` target (docs/plans/CONFIG_OVERHAUL_PLAN.md §2.4/§4
 * step 7): a task run by the external CLI's OWN tools — it reads and edits
 * files itself (unlike a regular delegated model, which only gets the task +
 * context text). Never routes through backendPool: cli targets
 * spawn their own process. Throws plain Error; LocalDelegationService.ask()
 * wraps it as DelegationError.
 *
 * Every delegation is an independent one-shot run; selected CLI chat models
 * use CliSessionRegistry through CliTurn and keep their conversation session.
 */
export async function runCliDelegation(
  request: LocalDelegationRequest,
  target: DelegationTarget,
  driver: CliAgentDriver,
  workspaceRoot: string,
  signal: AbortSignal,
): Promise<LocalDelegationResult> {
  if (!target.model.cli) {
    throw new Error(
      `Delegation target "${request.targetModel}" is misconfigured: provider: cli requires a "cli" field.`,
    );
  }
  const cliName = inferCliAgentName(target.model.cli);
  if (cliName === 'copilot') {
    throw new Error('Copilot is not supported as a CLI delegation target.');
  }
  const executable = await resolveCliExecutable(target.model.cli, cliName);

  const focusNote = request.focus ? `\nFocus: ${request.focus}` : '';
  const contextNote = request.contextFiles?.length
    ? `Suggested starting files (read them yourself):\n${request.contextFiles.map((file) => `- ${file}`).join('\n')}`
    : '';
  const task = [
    `Task:\n${request.task}${focusNote}`,
    contextNote,
    buildCliDelegationReplyContract(),
  ]
    .filter(Boolean)
    .join('\n\n');

  const cliModel = target.model.cli_model;
  const result: CliAgentRunResult = await driver.run({
    cliName,
    executable,
    task,
    cwd: workspaceRoot,
    timeoutMs: CLI_DELEGATION_TIMEOUT_MS,
    ...(cliModel ? { model: cliModel } : {}),
    signal,
  });
  if (result.status !== 'completed') {
    // Do not discard what the agent produced. A CLI delegate runs unrestricted
    // against the real workspace, so a run that timed out has very likely
    // already done the work -- on 2026-09-09 Claude Code edited the plan file it
    // was asked to revise and then hit the 600s ceiling, and the caller was told
    // only "timed out". The local agent had to infer from file mtimes that
    // anything had happened at all. Hand back the partial answer and say where
    // to look for the rest.
    const partial = capResultText(result.finalText ?? '', MAX_DELEGATION_RESULT_CHARS).trim();
    throw new Error(
      [
        `Delegation CLI agent ${result.status}: ${result.error ?? 'unknown error'}`,
        'This agent edits the workspace directly, so the work may already be done even though' +
          ' the report was lost: check `git status` and the mtimes of the files the task named' +
          ' before retrying it.',
        ...(partial ? [`Partial output before the cut:\n${partial}`] : []),
      ].join('\n\n'),
    );
  }
  return {
    text: capResultText(result.finalText, MAX_DELEGATION_RESULT_CHARS),
    targetModel: target.resolvedId,
    bestEffort: false,
  };
}
