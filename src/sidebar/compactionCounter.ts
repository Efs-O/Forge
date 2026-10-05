import type { ForgeConfig, ModelConfig } from '../config/types';
import { resolveRequestModel } from '../config/ConfigResolver';
import type { IBackendPool } from '../backend/BackendPool';
import { CountTokensCounter, ServerTokenCounter } from '../search/TokenCounter';
import type { TokenCounter } from '../search/embeddingBudget';
import type { ConversationRuntime } from './sessionTypes';
import type { CompactionCounterName } from './compactionHostFit';
import type * as vscode from 'vscode';

/** Selects and caches the configured tokenizer for a conversation's model. */
export function createCompactionCounter(deps: {
  getConfig: () => ForgeConfig;
  pool: IBackendPool;
  secrets?: vscode.SecretStorage | undefined;
}): {
  mode: (conv: ConversationRuntime) => CompactionCounterName;
  endpoint: (conv: ConversationRuntime) => string | undefined;
  count: (text: string, conv: ConversationRuntime) => Promise<number>;
} {
  const counters = new Map<string, TokenCounter>();
  const modelFor = (conv: ConversationRuntime): ModelConfig | undefined => {
    const config = deps.getConfig();
    const name = conv.active_model ?? config.active_model;
    return name ? resolveRequestModel(config, name) : undefined;
  };
  const mode = (conv: ConversationRuntime): CompactionCounterName => {
    const model = modelFor(conv);
    if (!model) return 'estimate';
    return (
      model.token_count ??
      ((model.provider ?? 'llama.cpp') === 'llama.cpp' ? 'tokenize' : 'estimate')
    );
  };
  return {
    mode,
    endpoint: (conv) => modelFor(conv)?.endpoint,
    count: async (text, conv) => {
      const model = modelFor(conv);
      const selected = mode(conv);
      if (!model || selected === 'estimate') {
        throw new Error('No explicit tokenizer is configured for this model.');
      }
      const endpoint =
        (model.provider ?? 'llama.cpp') === 'llama.cpp'
          ? (await deps.pool.acquire(model.name)).baseUrl()
          : model.endpoint!;
      const serverModel = model.model ?? model.name;
      const key = `${selected}|${endpoint}|${model.name}|${serverModel}`;
      let counter = counters.get(key);
      if (!counter) {
        counter =
          selected === 'count_tokens'
            ? new CountTokensCounter(
                () => endpoint,
                () => serverModel,
                {
                  apiKeyProvider: async () =>
                    model.api_key_secret ? deps.secrets?.get(model.api_key_secret) : undefined,
                  timeoutMs: 10_000,
                },
              )
            : new ServerTokenCounter(() => endpoint, { timeoutMs: 10_000 });
        counters.set(key, counter);
      }
      try {
        return await counter.count(text);
      } catch (err) {
        throw new Error(`${endpoint}: ${(err as Error).message}`);
      }
    },
  };
}
