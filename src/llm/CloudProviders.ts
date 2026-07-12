import type { ModelConfig } from '../config/types';

export type CloudProvider = 'xai' | 'openrouter' | 'openai' | 'openai-compatible';

const CLOUD_PROVIDER_LABELS: Record<CloudProvider, string> = {
  xai: 'xAI',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible',
};

const CLOUD_PROVIDER_BASE_URLS: Record<'xai' | 'openrouter' | 'openai', string> = {
  xai: 'https://api.x.ai',
  openrouter: 'https://openrouter.ai/api',
  openai: 'https://api.openai.com',
};

function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/i, '').replace(/\/$/, '');
}

export function isCloudProvider(provider: ModelConfig['provider']): provider is CloudProvider {
  return (
    provider === 'xai' ||
    provider === 'openrouter' ||
    provider === 'openai' ||
    provider === 'openai-compatible'
  );
}

export function getCloudProviderLabel(provider: CloudProvider): string {
  return CLOUD_PROVIDER_LABELS[provider];
}

/**
 * Human-readable provider name for display (e.g. in a consumer's model list).
 * For `openai-compatible` the generic label says nothing useful, so derive the
 * name from the endpoint host: `https://api.cerebras.ai` → `cerebras`.
 */
export function getProviderDisplayName(model: ModelConfig): string {
  if (model.provider === 'openai-compatible' && model.endpoint) {
    try {
      const host = new URL(model.endpoint).hostname;
      const label = host.replace(/^(api|www)\./, '').split('.')[0];
      if (label) return label;
    } catch {
      /* fall through to the generic label */
    }
  }
  if (isCloudProvider(model.provider)) return getCloudProviderLabel(model.provider);
  return model.provider ?? 'llama.cpp';
}

export function getCloudBaseUrl(model: ModelConfig): string {
  if (!isCloudProvider(model.provider)) {
    throw new Error(`Forge: ${model.name} is not a cloud provider model`);
  }
  if (model.provider === 'openai-compatible') {
    if (!model.endpoint) {
      throw new Error(
        `Forge: model "${model.name}" uses provider openai-compatible and requires endpoint in config.yaml`,
      );
    }
    return normalizeOpenAiCompatibleBaseUrl(model.endpoint);
  }
  return normalizeOpenAiCompatibleBaseUrl(CLOUD_PROVIDER_BASE_URLS[model.provider]);
}
