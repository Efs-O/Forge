import type { ModelConfig } from '../config/types';
import { isCloudProvider } from './CloudProviders';

export type ModelRoute =
  | 'local-llama'
  | 'local-ollama'
  | 'ollama-cloud'
  | 'direct-cloud'
  | 'cli-agent';

export function isOllamaCloudModel(model: ModelConfig): boolean {
  return model.provider === 'ollama' && /[-:]cloud$/i.test(model.name);
}

/** `cli` is checked first: it is local (the CLI handles its own subscription
 *  auth) and must never be classified as a cloud route. */
export function classifyModelRoute(model: ModelConfig): ModelRoute {
  if (model.provider === 'cli') return 'cli-agent';
  if (isCloudProvider(model.provider)) return 'direct-cloud';
  if (isOllamaCloudModel(model)) return 'ollama-cloud';
  if (model.provider === 'ollama') return 'local-ollama';
  return 'local-llama';
}

export function isCloudModelRoute(route: ModelRoute): boolean {
  return route === 'direct-cloud' || route === 'ollama-cloud';
}
