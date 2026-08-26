export const MAX_DELEGATION_CONTEXT_FILES = 8;
export const MAX_DELEGATION_CONTEXT_FILE_BYTES = 256 * 1024;
export const MAX_DELEGATION_CONTEXT_BYTES = 1024 * 1024;
export const MAX_DELEGATION_TASK_CHARS = 4000;
export const MAX_DELEGATION_RESULT_CHARS = 24000;
export const DEFAULT_DELEGATION_OUTPUT_TOKENS = 1024;
export const HARD_MAX_DELEGATION_OUTPUT_TOKENS = 4096;
export const DELEGATION_TIMEOUT_MS = 120_000;
/**
 * `provider: cli` targets run a full external agent (Claude Code, Codex) with
 * its own tools against the real workspace — a code review legitimately takes
 * minutes. The 120s ceiling above is sized for a local model answering a
 * question from supplied context; applying it here aborted working runs and
 * threw away everything they had already spent, and the retry paid the whole
 * cold-start again.
 */
export const CLI_DELEGATION_TIMEOUT_MS = 600_000;
/**
 * Cloud targets (xAI, OpenRouter, OpenAI-compatible, Ollama cloud-routed) are
 * reasoning models behind a network hop with no local slot to hold. The 120s
 * ceiling is sized for a local model that is already resident; a cloud
 * reasoning model routinely spends longer than that on its thinking alone, and
 * an abort there wastes tokens the user has already paid for.
 */
export const CLOUD_DELEGATION_TIMEOUT_MS = 300_000;

export interface DelegationPromptContextFile {
  path: string;
  content: string;
}

export function clampDelegationOutputTokens(requested?: number): number {
  if (requested === undefined) return DEFAULT_DELEGATION_OUTPUT_TOKENS;
  return Math.max(1, Math.min(Math.floor(requested), HARD_MAX_DELEGATION_OUTPUT_TOKENS));
}

export function assertDelegationTaskLength(task: string): void {
  if (task.length > MAX_DELEGATION_TASK_CHARS) {
    throw new Error(
      `Delegation task is too long: ${task.length} chars exceeds ${MAX_DELEGATION_TASK_CHARS}.`,
    );
  }
}

export function buildConsultationSystemPrompt(files: DelegationPromptContextFile[]): string {
  const citations =
    files.length > 0
      ? files.map((file) => `- ${file.path}`).join('\n')
      : '- No context files were supplied.';
  return [
    'You are a local Forge delegation consultant.',
    'Provide analysis only. Do not call tools, request tool use, edit files, run commands, or claim that you edited files or executed anything.',
    'Base your answer only on the user task and supplied context. If context is insufficient, say what is missing.',
    'When referring to supplied context, cite the exact filename from this list:',
    citations,
  ].join('\n');
}
