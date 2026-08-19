import type { ModelConfig } from '../config/types';
import { getProviderDisplayName } from '../llm/CloudProviders';
import { classifyModelRoute } from '../llm/ModelRouteClassifier';

export const MODEL_PICKER_GROUP_ORDER = [
  'Local — llama.cpp',
  'Local — Ollama',
  'Ollama Cloud',
  'xAI / Grok',
  'Cerebras',
  'OpenAI',
  'OpenRouter',
  'Other OpenAI-compatible',
  'CLI agents',
] as const;

export type ModelPickerGroup = (typeof MODEL_PICKER_GROUP_ORDER)[number];

function titleCase(label: string): string {
  return label.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Classifies a resolved model for the sidebar picker without affecting routing. */
export function modelPickerGroup(model: ModelConfig): ModelPickerGroup {
  switch (classifyModelRoute(model)) {
    case 'local-llama':
      return 'Local — llama.cpp';
    case 'local-ollama':
      return 'Local — Ollama';
    case 'ollama-cloud':
      return 'Ollama Cloud';
    case 'cli-agent':
      return 'CLI agents';
    case 'direct-cloud': {
      if (model.provider === 'xai') return 'xAI / Grok';
      if (model.provider === 'openai') return 'OpenAI';
      if (model.provider === 'openrouter') return 'OpenRouter';
      return titleCase(getProviderDisplayName(model)) === 'Cerebras'
        ? 'Cerebras'
        : 'Other OpenAI-compatible';
    }
  }
}

/** Stable, case-insensitive ordering for entries in one picker group. */
export function compareModelPickerEntries(
  a: Pick<ModelConfig, 'name'>,
  b: Pick<ModelConfig, 'name'>,
): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}
