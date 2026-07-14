import type { ModelConfig } from '../config/types';
import { isCloudProvider } from './CloudProviders';

export type ModelRoute = 'local-llama' | 'local-ollama' | 'ollama-cloud' | 'direct-cloud';

export function isOllamaCloudModel(model: ModelConfig): boolean {
  return model.provider === 'ollama' && /[-:]cloud$/i.test(model.name);
}

export function classifyModelRoute(model: ModelConfig): ModelRoute {
  if (isCloudProvider(model.provider)) return 'direct-cloud';
  if (isOllamaCloudModel(model)) return 'ollama-cloud';
  if (model.provider === 'ollama') return 'local-ollama';
  return 'local-llama';
}

export function isCloudModelRoute(route: ModelRoute): boolean {
  return route === 'direct-cloud' || route === 'ollama-cloud';
}
