import type { ChatMessage } from './types';
import type { TemplateEngine, TemplateContext } from './TemplateEngine';
import type { SystemPromptMode } from '../config/types';

const FORGE_TEMPLATE = 'execute';

export class SystemPromptRenderError extends Error {
  constructor(
    readonly templateName: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Forge: system prompt template '${templateName}' failed to render: ${detail}`);
    this.name = 'SystemPromptRenderError';
  }
}

/**
 * Prepends the Forge system prompt to a message list.
 * Renders the built-in template. Rendering failures are surfaced to the turn.
 * If messages already starts with a system message, it is replaced.
 *
 * `mode: 'replace'` sends `modelSystemPrompt` alone and skips the template
 * entirely — the built-in coding-agent persona is inappropriate for models
 * with a different purpose.
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

  if (!templateEngine) {
    throw new SystemPromptRenderError(FORGE_TEMPLATE, 'no template engine is available');
  }

  let content: string;
  try {
    content = templateEngine.render(FORGE_TEMPLATE, { ...context });
  } catch (error) {
    throw new SystemPromptRenderError(FORGE_TEMPLATE, error);
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
