import type { ModelEntry } from '../../src/sidebar/messageBridge';

export interface ModelGroup {
  label: string;
  entries: ModelEntry[];
}

const GROUP_ORDER = [
  'Local (llama.cpp)',
  'Ollama — Local',
  'Ollama — Cloud',
  'xAI / Grok',
  'OpenRouter',
  'OpenAI',
  'Custom Endpoint',
];

function groupLabel(entry: ModelEntry): string {
  const p = entry.provider;
  if (!p || p === 'llama.cpp') return 'Local (llama.cpp)';
  if (p === 'xai') return 'xAI / Grok';
  if (p === 'openrouter') return 'OpenRouter';
  if (p === 'openai') return 'OpenAI';
  if (p === 'openai-compatible') return 'Custom Endpoint';
  if (p === 'ollama') {
    const n = entry.name;
    return n.endsWith(':cloud') || n.endsWith('-cloud') ? 'Ollama — Cloud' : 'Ollama — Local';
  }
  return p;
}

/** Groups models by provider, preserving bridge.yaml order within each group. */
export function groupModels(models: ModelEntry[]): ModelGroup[] {
  const map = new Map<string, ModelEntry[]>();
  for (const entry of models) {
    const label = groupLabel(entry);
    const existing = map.get(label);
    if (existing) {
      existing.push(entry);
    } else {
      map.set(label, [entry]);
    }
  }

  const result: ModelGroup[] = [];
  for (const label of GROUP_ORDER) {
    const entries = map.get(label);
    if (entries && entries.length > 0) {
      result.push({ label, entries });
      map.delete(label);
    }
  }
  // Append any unknown provider groups not in the fixed order
  for (const [label, entries] of map) {
    result.push({ label, entries });
  }
  return result;
}
