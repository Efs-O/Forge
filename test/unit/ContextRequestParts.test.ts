import { describe, expect, it } from 'vitest';
import { prepareModelTurnMessages } from '../../src/sidebar/prepareModelTurnMessages';
import { createContextTrimState } from '../../src/agent/toolResultContext';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { ToolDefinition } from '../../src/llm/types';

describe('Telegram /context request parts', () => {
  it('records the injected system prompt and tool schemas, which conv.messages never holds', () => {
    const state = createContextTrimState();
    const model = {
      name: 'parts-test',
      num_ctx: 32_768,
      n_parallel: 1,
      system_prompt: 'You are Forge. Follow the repository instructions.',
      system_prompt_mode: 'replace',
    } as ModelConfig;
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a workspace file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ];
    prepareModelTurnMessages([{ role: 'user', content: 'Explain this repository.' }], {
      compaction: undefined,
      contextTrimState: state,
      isVisionModel: false,
      model,
      templateEngine: undefined,
      config: { models: [model] } as unknown as ForgeConfig,
      forgeLoader: undefined,
      activeFile: undefined,
      workspaceIsProjectRoot: true,
      turnContext: {},
      getToolDefinitions: () => tools,
    });
    expect(state.lastRequestParts?.instructions).toBeGreaterThan(0);
    expect(state.lastRequestParts?.tools).toBeGreaterThan(0);
    expect(state.lastRequestParts?.conversation).toBeGreaterThan(0);
  });
});
