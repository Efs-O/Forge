import type * as vscode from 'vscode';
import type { ModelConfig } from '../config/types';
import { getCloudBaseUrl, getCloudProviderLabel, isCloudProvider } from './CloudProviders';
import { resolveXaiToken } from './XaiAuth';

export interface CloudRequestTarget {
  baseUrl: string;
  apiKey: string;
}

export async function resolveCloudRequestTarget(
  model: ModelConfig,
  secrets: vscode.SecretStorage | undefined,
): Promise<CloudRequestTarget> {
  if (!isCloudProvider(model.provider)) {
    throw new Error(`Forge: model "${model.name}" is not a direct cloud provider model`);
  }
  const baseUrl = getCloudBaseUrl(model);
  if (model.provider === 'xai') {
    return { baseUrl, apiKey: await resolveXaiToken(model.api_key_secret, secrets) };
  }
  const keyName = model.api_key_secret;
  const apiKey = keyName ? await secrets?.get(keyName) : undefined;
  if (!apiKey) {
    throw new Error(
      `${getCloudProviderLabel(model.provider)}: no bearer token in SecretStorage ` +
        `(key: ${keyName ?? 'unset'}). Run "Forge: Set Cloud Provider Token" and set ` +
        'api_key_secret in config.yaml.',
    );
  }
  return { baseUrl, apiKey };
}
