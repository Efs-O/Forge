import type { ChatMessage, Mode } from './types';
import type { TemplateEngine, TemplateContext } from './TemplateEngine';

// Hardcoded fallbacks — used when no TemplateEngine is provided or rendering fails.
const SYSTEM_PROMPTS: Record<Mode, string> = {
  ask: `You are Forge, a local AI coding assistant running entirely on the user's machine.
Answer questions clearly and concisely. Prefer short explanations with code examples.
Never suggest cloud services or external APIs — the user is working locally.`,

  plan: `You are Forge, a local AI coding assistant running entirely on the user's machine.
When given a task, produce a numbered step-by-step plan before writing any code.
Each step must be specific and actionable. After the plan, ask for confirmation before proceeding.
Never suggest cloud services or external APIs — the user is working locally.`,

  execute: `You are Forge, a local AI coding assistant running entirely on the user's machine.
You have access to tools to read and edit files. Use them precisely.
Always read a file before editing it. Show the minimal diff needed — do not rewrite files wholesale.
After each tool call, report what changed. Stop and ask if anything is ambiguous.
Never suggest cloud services or external APIs — the user is working locally.`,
};

/**
 * Prepends the mode-appropriate system prompt to a message list.
 * Uses TemplateEngine when provided; falls back to hardcoded strings.
 * If messages already starts with a system message, it is replaced.
 */
export function injectSystemPrompt(
  messages: ChatMessage[],
  mode: Mode,
  templateEngine?: TemplateEngine,
  context?: Partial<TemplateContext>,
): ChatMessage[] {
  let content: string;

  if (templateEngine) {
    try {
      content = templateEngine.render(mode, { mode, ...context });
    } catch {
      // Template render failed — fall back to hardcoded prompt
      content = SYSTEM_PROMPTS[mode];
    }
  } else {
    content = SYSTEM_PROMPTS[mode];
  }

  const systemMsg: ChatMessage = { role: 'system', content };
  if (messages[0]?.role === 'system') {
    return [systemMsg, ...messages.slice(1)];
  }
  return [systemMsg, ...messages];
}
