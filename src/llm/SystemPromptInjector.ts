import type { ChatMessage } from './types';
import type { TemplateEngine, TemplateContext } from './TemplateEngine';
import type { SystemPromptMode } from '../config/types';

// Hardcoded fallbacks used when no TemplateEngine is provided or rendering fails.
const FORGE_TEMPLATE = 'execute';
const SYSTEM_PROMPT = `You are Forge, a coding assistant running in the user's VS Code.
You have access to tools to read and edit files, run commands, and interact with git.
Read a file before editing it, unless its current content is already in a recent tool result.
The user's direct request may override repository-local style, brevity, length, or workflow guidance, including a FORGE.md instruction, when the user explicitly asks. Do not override system/developer instructions, Forge safety controls, tool permissions, workspace boundaries, or destructive-action confirmation requirements.
Do not claim anything you have not seen in a tool result.`;

/**
 * Prepends the Forge system prompt to a message list.
 * Uses TemplateEngine when provided; falls back to hardcoded strings.
 * If messages already starts with a system message, it is replaced.
 *
 * `mode: 'replace'` sends `modelSystemPrompt` alone and skips the template
 * entirely — the template is a strong coding-agent persona ("You are Forge",
 * "Act with tools"), which a model with a different purpose must not receive.
 */
export function injectSystemPrompt(
  messages: ChatMessage[],
  templateEngine?: TemplateEngine,
  context?: Partial<TemplateContext>,
  modelSystemPrompt?: string,
  mode: SystemPromptMode = 'append',
): ChatMessage[] {
  const override = modelSystemPrompt?.trim();

  // `replace` without a prompt would send an empty system message — fall
  // through to the template instead.
  if (mode === 'replace' && override) {
    const systemMsg: ChatMessage = { role: 'system', content: override };
    return messages[0]?.role === 'system'
      ? [systemMsg, ...messages.slice(1)]
      : [systemMsg, ...messages];
  }

  let content: string;

  if (templateEngine) {
    try {
      content = templateEngine.render(FORGE_TEMPLATE, { ...context });
    } catch {
      // Template render failed - fall back to hardcoded prompt.
      content = SYSTEM_PROMPT;
    }
  } else {
    content = SYSTEM_PROMPT;
  }

  if (override) {
    content = `${content}\n\n${override}`;
  }

  const systemMsg: ChatMessage = { role: 'system', content };
  if (messages[0]?.role === 'system') {
    return [systemMsg, ...messages.slice(1)];
  }
  return [systemMsg, ...messages];
}
