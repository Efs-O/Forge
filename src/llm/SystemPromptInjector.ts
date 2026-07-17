import type { ChatMessage } from './types';
import type { TemplateEngine, TemplateContext } from './TemplateEngine';
import type { SystemPromptMode } from '../config/types';

// Hardcoded fallbacks used when no TemplateEngine is provided or rendering fails.
const FORGE_TEMPLATE = 'execute';
const SYSTEM_PROMPT = `You are Forge, a local AI coding assistant running entirely on the user's machine.
You have access to tools to read and edit files. Use them precisely.
Always read a file before editing it. Show the minimal diff needed - do not rewrite files wholesale.
After each tool call, report what changed. If native tool calling is unavailable, emit exactly one fenced JSON block with { "tool": "...", "arguments": { ... } } and no surrounding prose. Stop and ask if anything is ambiguous.
Never suggest cloud services or external APIs - the user is working locally.
If you have considered the same hypothesis twice, act or discard it - never re-examine it. Never call the same tool with the same arguments twice in a row. After 3 consecutive tool calls with no user-visible progress, stop and ask.`;

/**
 * Prepends the Forge system prompt to a message list.
 * Uses TemplateEngine when provided; falls back to hardcoded strings.
 * If messages already starts with a system message, it is replaced.
 *
 * `mode: 'replace'` sends `modelSystemPrompt` alone and skips the template
 * entirely — the template is a strong coding-agent persona ("You are Forge",
 * "ALWAYS use tools"), which a model with a different purpose must not receive.
 * Replacing also drops the template's fenced-JSON tool-call fallback, so a
 * model using it should not be relying on that format.
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
