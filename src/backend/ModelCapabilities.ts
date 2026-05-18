import type { ModelConfig } from '../config/types';

export interface RuntimeModelCapabilities {
  source: 'runtime' | 'heuristic' | 'unknown';
  hasChatTemplate: boolean | null;
  likelySupportsTools: boolean | null;
  likelySupportsThinking: boolean | null;
  chatTemplate: string | null;
}

interface PropsPayload {
  chat_template?: unknown;
  chat_template_caps?: unknown;
}

const TOOL_HINTS = [
  'tool',
  'function',
  'parallel_tool_calls',
] as const;

const THINKING_HINTS = [
  'think',
  'reason',
  'preserve_thinking',
  'enable_thinking',
  '<think>',
  '<|thinking|>',
  'thought<|channel>',
  'reasoning_content',
  'reasoning_format',
  'bailing-think',
  'gpt-oss',
  'qwen3',
  'deepseek',
] as const;

const TOOL_TEMPLATE_HINTS = [
  'tool',
  'function',
  'command-r',
  'hermes',
  'firefunction',
  'functionary',
  'qwen',
  'mistral',
  'gpt-oss',
  'phi',
  'gemma',
  'llama-3',
  'llama3',
  'llama-4',
  'llama4',
  'deepseek',
] as const;

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function containsHint(value: unknown, hints: readonly string[]): boolean {
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    return hints.some((hint) => lower.includes(hint));
  }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.some((entry) => containsHint(entry, hints));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
      const lowerKey = key.toLowerCase();
      return hints.some((hint) => lowerKey.includes(hint)) ? Boolean(entry ?? true) : containsHint(entry, hints);
    });
  }
  return false;
}

function mergeCapabilityValues(
  runtimeValue: boolean | null,
  heuristicValue: boolean | null,
): boolean | null {
  return runtimeValue ?? heuristicValue;
}

function deriveHeuristicCapabilities(model?: ModelConfig): RuntimeModelCapabilities {
  const probe = [model?.name, model?.gguf_path, model?.endpoint].filter(Boolean).join(' ').toLowerCase();
  if (!probe) {
    return {
      source: 'unknown',
      hasChatTemplate: null,
      likelySupportsTools: null,
      likelySupportsThinking: null,
      chatTemplate: null,
    };
  }

  const explicitTools = model?.capabilities?.includes('tool-call') ? true : null;
  const likelySupportsTools = explicitTools ?? (
    TOOL_TEMPLATE_HINTS.some((hint) => probe.includes(hint)) ? true : null
  );
  const likelySupportsThinking = THINKING_HINTS.some((hint) => probe.includes(hint)) ? true : null;

  return {
    source: 'heuristic',
    hasChatTemplate: null,
    likelySupportsTools,
    likelySupportsThinking,
    chatTemplate: null,
  };
}

function deriveRuntimeCapabilities(
  props: PropsPayload,
  heuristic: RuntimeModelCapabilities,
): RuntimeModelCapabilities {
  const chatTemplate = asNonEmptyString(props.chat_template);
  const caps = props.chat_template_caps;
  const runtimeTools = containsHint(caps, TOOL_HINTS) || containsHint(chatTemplate, TOOL_HINTS)
    ? true
    : chatTemplate === null && props.chat_template !== ''
      ? null
      : false;
  const runtimeThinking = containsHint(caps, THINKING_HINTS) || containsHint(chatTemplate, THINKING_HINTS)
    ? true
    : chatTemplate === null && props.chat_template !== ''
      ? null
      : false;

  return {
    source: 'runtime',
    hasChatTemplate: typeof props.chat_template === 'string' ? chatTemplate !== null : heuristic.hasChatTemplate,
    likelySupportsTools: mergeCapabilityValues(runtimeTools, heuristic.likelySupportsTools),
    likelySupportsThinking: mergeCapabilityValues(runtimeThinking, heuristic.likelySupportsThinking),
    chatTemplate,
  };
}

async function fetchProps(baseUrl: string): Promise<PropsPayload | null> {
  const response = await fetch(`${baseUrl}/props`);
  if (!response.ok) return null;
  const payload = await response.json() as unknown;
  if (!payload || typeof payload !== 'object') return null;
  return payload as PropsPayload;
}

export async function inspectRuntimeModelCapabilities(
  baseUrl: string,
  model?: ModelConfig,
): Promise<RuntimeModelCapabilities> {
  const heuristic = deriveHeuristicCapabilities(model);
  try {
    const props = await fetchProps(baseUrl);
    if (!props) return heuristic;
    return deriveRuntimeCapabilities(props, heuristic);
  } catch {
    return heuristic;
  }
}
