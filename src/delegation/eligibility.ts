import type { ForgeConfig, ModelConfig } from '../config/types';
import { expandAlias, resolveRequestModel, splitModelProfile } from '../config/ConfigResolver';
import { isCloudProvider, getCloudProviderLabel } from '../llm/CloudProviders';
import { isOllamaCloudModel } from '../llm/ModelRouteClassifier';

export interface DelegationTarget {
  requested: string;
  resolvedId: string;
  baseModel: string;
  model: ModelConfig;
  provider: 'llama.cpp' | 'ollama';
}

function isLocalOllamaEndpoint(endpoint: string | undefined): boolean {
  if (!endpoint) return true;
  try {
    const url = new URL(endpoint);
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

function providerLabel(provider: ModelConfig['provider']): string {
  if (isCloudProvider(provider)) return getCloudProviderLabel(provider);
  return provider ?? 'llama.cpp';
}

export function resolveDelegationTarget(config: ForgeConfig, requested: string): DelegationTarget {
  let model: ModelConfig;
  let resolvedId: string;
  try {
    resolvedId = expandAlias(config, requested);
    model = resolveRequestModel(config, requested);
  } catch (err) {
    throw new Error(`Unknown delegation target "${requested}": ${(err as Error).message}`);
  }

  const { base } = splitModelProfile(resolvedId);
  const provider = model.provider ?? 'llama.cpp';

  if (provider === 'llama.cpp') {
    return { requested, resolvedId, baseModel: base, model, provider };
  }

  if (provider === 'ollama') {
    if (!isLocalOllamaEndpoint(model.endpoint)) {
      throw new Error(
        `Delegation target "${requested}" is Ollama cloud or non-local Ollama endpoint (${model.endpoint}); only local Ollama daemon targets are allowed.`,
      );
    }
    // Ollama cloud models route THROUGH the local daemon (localhost:11434) but
    // execute remotely; only their "-cloud"/":cloud" tag suffix marks them
    // (the model name is what gets sent to the daemon). The endpoint check
    // above cannot catch them.
    if (isOllamaCloudModel(model)) {
      throw new Error(
        `Delegation target "${requested}" is an Ollama cloud-routed model ("${model.name}"); only local Ollama daemon targets are allowed.`,
      );
    }
    return { requested, resolvedId, baseModel: base, model, provider };
  }

  if (isCloudProvider(provider)) {
    throw new Error(
      `Delegation target "${requested}" uses ${providerLabel(provider)}; cloud providers are not allowed for local delegation.`,
    );
  }

  throw new Error(
    `Delegation target "${requested}" uses unsupported provider "${String(provider)}"; only local llama.cpp and local Ollama targets are allowed.`,
  );
}
