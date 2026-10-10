import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../src/llm/types';

const { streamModelChatCompletion } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
}));
vi.mock('../../src/llm/ChatClient', () => ({ streamModelChatCompletion }));

import { runToolCallingLoop } from '../../src/agent/ToolCallingLoop';
import { injectSystemPrompt, SystemPromptRenderError } from '../../src/llm/SystemPromptInjector';

describe('system prompt render failures', () => {
  it('fails before sending a model request and preserves the template error', async () => {
    const engine = {
      render: () => {
        throw new Error('unexpected end of block');
      },
    } as never;
    const messages: ChatMessage[] = [{ role: 'user', content: 'work' }];

    await expect(
      runToolCallingLoop({
        resolveBaseUrl: async () => 'http://127.0.0.1:8080',
        model: { name: 'test' } as never,
        messages,
        getToolDefinitions: () => [],
        signal: new AbortController().signal,
        maxRounds: 1,
        nativeTools: true,
        prepareMessages: (current) => injectSystemPrompt(current, engine),
      } as never),
    ).rejects.toMatchObject({
      name: 'SystemPromptRenderError',
      message: expect.stringContaining('unexpected end of block'),
    });

    expect(streamModelChatCompletion).not.toHaveBeenCalled();
  });

  it('has no hardcoded Forge persona outside the built-in template directory', () => {
    const root = path.resolve(__dirname, '../..');
    // The coding-agent persona only; other prompts (e.g. the Telegram contact
    // policy, "You are Forge's assistant") are separate features.
    const phrase = ['You are', 'Forge,'].join(' ');
    const scanned: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target);
        else if (/\.(?:ts|tsx|yaml|yml|njk)$/u.test(entry.name)) scanned.push(target);
      }
    };
    visit(path.join(root, 'src'));
    visit(path.join(root, 'config'));
    const outsideTemplates = scanned.filter(
      (file) => !file.includes(`${path.sep}config${path.sep}templates${path.sep}`),
    );

    expect(
      outsideTemplates.filter((file) => fs.readFileSync(file, 'utf8').includes(phrase)),
    ).toEqual([]);
  });

  it('exports a typed error that names the built-in template', () => {
    expect(new SystemPromptRenderError('execute', new Error('broken')).message).toContain(
      "template 'execute' failed to render: broken",
    );
  });
});
