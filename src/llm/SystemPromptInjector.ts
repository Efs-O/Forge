import type { ChatMessage } from './types';
import type { TemplateEngine, TemplateContext } from './TemplateEngine';

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
 */
export function injectSystemPrompt(
  messages: ChatMessage[],
  templateEngine?: TemplateEngine,
  context?: Partial<TemplateContext>,
  modelSystemPrompt?: string,
): ChatMessage[] {
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

  if (modelSystemPrompt?.trim()) {
    content = `${content}\n\n${modelSystemPrompt.trim()}`;
  }

  const systemMsg: ChatMessage = { role: 'system', content };
  if (messages[0]?.role === 'system') {
    return [systemMsg, ...messages.slice(1)];
  }
  return [systemMsg, ...messages];
}
