import type { ForgeConfig } from '../config/types';
import { mergeGroupsIntoModel } from '../config/ConfigResolver';

/** Read the TCP port from a loaded backend's client URL. */
export function modelPortFromBaseUrl(baseUrl: string): number | null {
  const port = Number(new URL(baseUrl).port);
  return Number.isInteger(port) && port > 0 ? port : null;
}

/** Return a managed external model's configured endpoint origin. */
export function externalModelBaseUrl(
  config: ForgeConfig,
  modelName: string,
  isManaged: boolean,
): string | null {
  if (!isManaged) return null;
  const entry = config.models.find((model) => model.name === modelName);
  const model = entry ? mergeGroupsIntoModel(config, entry) : undefined;
  return model?.endpoint ? new URL(model.endpoint).origin : null;
}
