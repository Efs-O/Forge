import { describe, expect, it } from 'vitest';
import { injectSystemPrompt } from '../../src/llm/SystemPromptInjector';
import type { ChatMessage } from '../../src/llm/types';
import type { TemplateEngine } from '../../src/llm/TemplateEngine';

const engine = {
  render: () => 'You are Forge, a local AI coding assistant. ALWAYS use tools.',
} as unknown as TemplateEngine;

const user: ChatMessage[] = [{ role: 'user', content: 'hi' }];

describe('injectSystemPrompt', () => {
  it('appends the model prompt beneath the template by default', () => {
    const [system] = injectSystemPrompt(user, engine, {}, 'You are a helpful assistant.');
    expect(system!.content).toContain('You are Forge');
    expect(system!.content).toContain('You are a helpful assistant.');
  });

  it('uses the built-in fallback authority rule when no template engine is available', () => {
    const [system] = injectSystemPrompt(user);
    expect(system!.content).toContain('direct request may override repository-local');
    expect(system!.content).toContain('destructive-action confirmation requirements');
  });

  it('appends when mode is explicitly append', () => {
    const [system] = injectSystemPrompt(user, engine, {}, 'Custom.', 'append');
    expect(system!.content).toContain('You are Forge');
    expect(system!.content).toContain('Custom.');
  });

  it('replace sends ONLY the model prompt - no Forge persona', () => {
    // The whole point: a personal-recall tune must not be told it is Forge and
    // has tools, or it answers as a codebase assistant.
    const [system] = injectSystemPrompt(user, engine, {}, 'You are a helpful assistant.', 'replace');
    expect(system!.content).toBe('You are a helpful assistant.');
    expect(system!.content).not.toContain('Forge');
    expect(system!.content).not.toContain('tools');
  });

  it('replace without a prompt falls back to the template, never an empty prompt', () => {
    const [system] = injectSystemPrompt(user, engine, {}, undefined, 'replace');
    expect(system!.content).toContain('You are Forge');
    expect(system!.content.trim().length).toBeGreaterThan(0);
  });

  it('replace ignores a whitespace-only prompt', () => {
    const [system] = injectSystemPrompt(user, engine, {}, '   ', 'replace');
    expect(system!.content).toContain('You are Forge');
  });

  it('replaces an existing system message rather than stacking', () => {
    const withSystem: ChatMessage[] = [
      { role: 'system', content: 'stale' },
      { role: 'user', content: 'hi' },
    ];
    const result = injectSystemPrompt(withSystem, engine, {}, 'Fresh.', 'replace');
    expect(result).toHaveLength(2);
    expect(result[0]!.content).toBe('Fresh.');
    expect(result[1]!.content).toBe('hi');
  });

  it('keeps the user message after the system prompt', () => {
    const result = injectSystemPrompt(user, engine, {}, 'Custom.', 'replace');
    expect(result[1]).toEqual({ role: 'user', content: 'hi' });
  });
});
