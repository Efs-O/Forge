import type { CliAgentDriver } from '../agents/CliAgentDriver';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import { inferCliAgentName } from '../agents/types';
import { capResultText } from '../tools/resultCap';
import { MAX_DELEGATION_RESULT_CHARS } from './limits';
import type { DelegationTarget } from './eligibility';
import type { LocalDelegationRequest, LocalDelegationResult } from './LocalDelegationService';

/**
 * ask_local_agent for a `provider: cli` target (CONFIG_OVERHAUL_PLAN.md §2.4/§4
 * step 7): read-only analysis run by the external CLI's OWN tools — it can
 * read/list files itself (unlike a regular delegated model, which only gets
 * the task + context text). Never routes through backendPool: cli targets
 * spawn their own process. Throws plain Error; LocalDelegationService.ask()
 * wraps it as DelegationError.
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
  const executable = await resolveCliExecutable(target.model.cli, cliName);

  const focusNote = request.focus ? `\nFocus: ${request.focus}` : '';
  const contextNote = request.contextFiles?.length
    ? `Suggested starting files (read them yourself):\n${request.contextFiles.map((file) => `- ${file}`).join('\n')}`
    : '';
  const task = [
    `Task:\n${request.task}${focusNote}`,
    contextNote,
    'This is a read-only analysis task. Do not modify any files.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const result = await driver.run({
    cliName,
    executable,
    task,
    access: 'read',
    cwd: workspaceRoot,
    signal,
  });
  if (result.status !== 'completed') {
    throw new Error(`Delegation CLI agent ${result.status}: ${result.error ?? 'unknown error'}`);
  }
  return {
    text: capResultText(result.finalText, MAX_DELEGATION_RESULT_CHARS),
    targetModel: target.resolvedId,
    bestEffort: false,
  };
}
