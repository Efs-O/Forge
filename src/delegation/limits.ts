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

/**
 * The system prompt a local delegate is given.
 *
 * It used to open by declaring the delegate a "consultant" and forbidding tool
 * use, edits and commands. That was a policy statement, and policy is not what
 * stops a local delegate from acting: `buildRequest` sends no `tools` array, so
 * there is no channel to call one on. Forbidding a capability the request never
 * offered spent tokens teaching the model it was junior.
 *
 * What remains is the request’s actual shape plus one guard that earns its
 * place -- a model with no tool channel is exactly the one that narrates edits
 * it never made, and a delegate that lies about writing a file costs more than
 * one that says it could not. Once a tool channel is wired this becomes an
 * ordinary agent prompt, whose only prohibitions are the destructive-command
 * denylist every other agent already answers to.
 */
export function buildConsultationSystemPrompt(files: DelegationPromptContextFile[]): string {
  const citations =
    files.length > 0
      ? files.map((file) => `- ${file.path}`).join('\n')
      : '- No context files were supplied.';
  return [
    'You are a Forge delegate working on this repository.',
    'This request carries no tool channel, so work from the task and the context files below. If they are not enough, say what you still need.',
    'Do not report having edited a file or run a command -- on this request you have no way to do either.',
    'When referring to supplied context, cite the exact filename from this list:',
    citations,
  ].join('\n');
}

/**
 * How much of a CLI delegate's answer belongs inline, before the rest belongs
 * in a file.
 *
 * `MAX_DELEGATION_RESULT_CHARS` is a ceiling, not a target, and reaching it is
 * already a failure: the cut is head-only, so an oversized review loses its
 * TAIL -- which is where "APPROVE / NOT APPROVE" and the summary of changes
 * conventionally sit. The delegate returns a verdict and the caller reads the
 * detail from disk on demand, with ranges, instead of paying for all of it
 * blind. 24,000 chars is ~6,600 tokens of a local agent's window at the
 * measured tool-result rate -- a tenth of a 64k slot spent in one tool result.
 */
export const PREFERRED_CLI_DELEGATION_REPLY_CHARS = 1500;

/**
 * The reply-shape contract given to a CLI delegate.
 *
 * CLI agents run unrestricted with their own file tools, so "write the detail
 * to a file" costs nothing to grant -- it is a request about shape, not a
 * permission change. The exception matters as much as the rule: when the task
 * IS to edit something, the edit is the deliverable and a separate report file
 * would only duplicate it into the caller's context.
 */
export function buildCliDelegationReplyContract(): string {
  return [
    'Reply shape — your answer is read by a local model with a small context window, so it pays for every character:',
    `- Keep the reply itself under ~${PREFERRED_CLI_DELEGATION_REPLY_CHARS} characters: the verdict or direct answer first, then at most the three points that change what the caller should do.`,
    '- If the full detail is longer than that, WRITE IT TO A FILE yourself and give the path on its own line as the last line, formatted exactly `REPORT: <path>`. Do not paste the file back into the reply.',
    '- If the task was to edit or create files, those edits ARE the deliverable: summarise what changed and list the paths. Do not also write a report file.',
    '- Never pad the reply to show your work. An answer that overflows is truncated from the end, so padding costs you the conclusion.',
  ].join('\n');
}
