import type { CliAgentDriver } from '../agents/CliAgentDriver';
import type { CliAgentSessionOptions } from '../agents/CliAgentSession';
import type { CliSessionKey, CliSessionRegistry } from '../agents/CliSessionRegistry';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import { inferCliAgentName, type CliAgentRunResult } from '../agents/types';
import { capResultText } from '../tools/resultCap';
import { CLI_DELEGATION_TIMEOUT_MS, MAX_DELEGATION_RESULT_CHARS } from './limits';
import type { DelegationTarget } from './eligibility';
import type { LocalDelegationRequest, LocalDelegationResult } from './LocalDelegationService';

/**
 * Warm delegation sessions are keyed separately from the chat sessions the
 * sidebar opens for the same (conversation, model) pair. A delegation runs
 * `access: 'read'` while a chat runs `access: 'full'`, and CliSessionRegistry
 * applies sessionOptions only when it CREATES an entry — sharing one key would
 * silently hand a read-only delegation the chat session's write rights, or
 * hand a chat turn a plan-mode session that cannot edit anything.
 */
export function delegationSessionKey(conversationId: string, resolvedId: string): CliSessionKey {
  return { conversationId, modelName: `${resolvedId}#delegate` };
}

export interface CliDelegationSessionDeps {
  registry: CliSessionRegistry;
  conversationId: string;
}

/**
 * ask_local_agent for a `provider: cli` target (CONFIG_OVERHAUL_PLAN.md §2.4/§4
 * step 7): read-only analysis run by the external CLI's OWN tools — it can
 * read/list files itself (unlike a regular delegated model, which only gets
 * the task + context text). Never routes through backendPool: cli targets
 * spawn their own process. Throws plain Error; LocalDelegationService.ask()
 * wraps it as DelegationError.
 *
 * When a registry and a conversation are available the run reuses a warm CLI
 * process: a second review in the same conversation resumes the same session
 * instead of re-paying the cold-start (system prompt, tool schemas, CLAUDE.md,
 * MCP definitions) as a prompt-cache miss. The one-shot `driver.run` path
 * remains for callers with no conversation to key a session on.
 */
export async function runCliDelegation(
  request: LocalDelegationRequest,
  target: DelegationTarget,
  driver: CliAgentDriver,
  workspaceRoot: string,
  signal: AbortSignal,
  session?: CliDelegationSessionDeps,
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

  const cliModel = target.model.cli_model;
  let result: CliAgentRunResult;
  if (session) {
    const key = delegationSessionKey(session.conversationId, target.resolvedId);
    const confirmedId = session.registry.getConfirmedSessionId(key);
    const sessionOptions: CliAgentSessionOptions = {
      cliName,
      executable,
      access: 'read',
      cwd: workspaceRoot,
      timeoutMs: CLI_DELEGATION_TIMEOUT_MS,
      ...(cliModel ? { model: cliModel } : {}),
      ...(confirmedId ? { confirmedSessionId: confirmedId } : {}),
    };
    // Every delegation sends its complete, self-contained task. Unlike chat
    // turns — which send only the latest message because the warm session
    // already holds the transcript — delegations are independent questions
    // that merely share a process.
    result = await session.registry.run(key, sessionOptions, task, { signal });
  } else {
    result = await driver.run({
      cliName,
      executable,
      task,
      access: 'read',
      cwd: workspaceRoot,
      timeoutMs: CLI_DELEGATION_TIMEOUT_MS,
      ...(cliModel ? { model: cliModel } : {}),
      signal,
    });
  }
  if (result.status !== 'completed') {
    throw new Error(`Delegation CLI agent ${result.status}: ${result.error ?? 'unknown error'}`);
  }
  return {
    text: capResultText(result.finalText, MAX_DELEGATION_RESULT_CHARS),
    targetModel: target.resolvedId,
    bestEffort: false,
  };
}
