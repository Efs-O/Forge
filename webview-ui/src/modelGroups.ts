import type { ModelEntry } from '../../src/sidebar/messageBridge';
import {
  compareModelPickerEntries,
  MODEL_PICKER_GROUP_ORDER,
} from '../../src/sidebar/ModelPickerGroups';

export interface ModelGroup {
  label: string;
  entries: ModelEntry[];
}

function groupLabel(entry: ModelEntry): string {
  if (entry.group) return entry.group;
  const p = entry.provider;
  if (!p || p === 'llama.cpp') return 'Local — llama.cpp';
  if (p === 'xai') return 'xAI / Grok';
  if (p === 'openrouter') return 'OpenRouter';
  if (p === 'openai') return 'OpenAI';
  if (p === 'openai-compatible') return 'Other OpenAI-compatible';
  if (p === 'cli') return 'CLI agents';
  if (p === 'ollama') {
    const n = entry.name;
    return n.endsWith(':cloud') || n.endsWith('-cloud') ? 'Ollama Cloud' : 'Local — Ollama';
  }
  return p;
}

/** Groups models by route/provider and alphabetizes entries within each group. */
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
  for (const label of MODEL_PICKER_GROUP_ORDER) {
    const entries = map.get(label);
    if (entries && entries.length > 0) {
      result.push({ label, entries: entries.sort(compareModelPickerEntries) });
      map.delete(label);
    }
  }
  // Stale webviews or an added provider may emit an unrecognised group.
  for (const [label, entries] of [...map].sort(([a], [b]) => a.localeCompare(b))) {
    result.push({ label, entries: entries.sort(compareModelPickerEntries) });
  }
  return result;
}
