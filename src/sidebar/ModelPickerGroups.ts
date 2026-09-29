import type { ModelConfig } from '../config/types';
import { getProviderDisplayName } from '../llm/CloudProviders';
import { classifyModelRoute } from '../llm/ModelRouteClassifier';

export const MODEL_PICKER_GROUP_ORDER = [
  'Local — llama.cpp',
  'Ollama Local',
  'Ollama Cloud',
  'xAI / Grok',
  'Cerebras',
  'OpenAI',
  'OpenRouter',
  'Other OpenAI-compatible',
  'CLI agents',
] as const;

export type ModelPickerGroup = (typeof MODEL_PICKER_GROUP_ORDER)[number];

/** The small model descriptor shared by the sidebar and remote pickers. */
export interface ModelPickerDescriptor {
  name: string;
  /** Config `display_name`; pickers show it in place of `name`, which stays the id. */
  displayName?: string;
  group: ModelPickerGroup;
  /** Request-time profiles the picker can apply to this base model. */
  profiles?: readonly string[];
}

/**
 * Expands the base entries into the concrete ids accepted by `/model` and the
 * remote selection pager. Profiles do not create another backend; they only
 * change request-time settings on the same base model.
 */
export function modelPickerSelectionEntries(
  entries: readonly ModelPickerDescriptor[],
): ModelPickerDescriptor[] {
  return sortModelPickerEntries(
    entries.flatMap((entry) => [
      {
        name: entry.name,
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
        group: entry.group,
      },
      ...(entry.profiles ?? []).map((profile) => ({
        name: `${entry.name}@${profile}`,
        ...(entry.displayName ? { displayName: `${entry.displayName}@${profile}` } : {}),
        group: entry.group,
      })),
    ]),
  );
}

function titleCase(label: string): string {
  return label.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Classifies a resolved model for the sidebar picker without affecting routing. */
export function modelPickerGroup(model: ModelConfig): ModelPickerGroup {
  switch (classifyModelRoute(model)) {
    case 'local-llama':
      return 'Local — llama.cpp';
    case 'local-ollama':
      return 'Ollama Local';
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

/** Builds the presentation metadata used by every model picker. */
export function describeModelPickerModel(model: ModelConfig): ModelPickerDescriptor {
  return {
    name: model.name,
    ...(model.display_name ? { displayName: model.display_name } : {}),
    group: modelPickerGroup(model),
  };
}

/** What a picker prints for an entry: the configured label, else the id. */
export function modelPickerLabel(entry: { name: string; displayName?: string }): string {
  return entry.displayName ?? entry.name;
}

/** Stable, case-insensitive ordering by displayed label for entries in one picker group. */
export function compareModelPickerEntries(
  a: { name: string; displayName?: string },
  b: { name: string; displayName?: string },
): number {
  return (
    modelPickerLabel(a).localeCompare(modelPickerLabel(b), undefined, { sensitivity: 'base' }) ||
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

/** Stable flat ordering matching the sidebar's group order and name sort. */
export function sortModelPickerEntries<T extends ModelPickerDescriptor>(
  entries: readonly T[],
): T[] {
  const groupOrder = new Map<string, number>(
    MODEL_PICKER_GROUP_ORDER.map((group, index) => [group, index]),
  );
  return [...entries].sort((a, b) => {
    const groupComparison =
      (groupOrder.get(a.group) ?? MODEL_PICKER_GROUP_ORDER.length) -
      (groupOrder.get(b.group) ?? MODEL_PICKER_GROUP_ORDER.length);
    return groupComparison || a.group.localeCompare(b.group) || compareModelPickerEntries(a, b);
  });
}
