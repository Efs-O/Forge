import type * as vscode from 'vscode';
import type { ModelConfig } from '../config/types';
import { getCloudBaseUrl, getCloudProviderLabel, isCloudProvider } from './CloudProviders';
import { resolveXaiToken } from './XaiAuth';
import { beforeExternalRequest } from '../backend/ExternalModelServers';
import { remoteStarterFor } from './RemoteStarterClient';
import { remoteRelayTarget } from './RemoteWindowRoute';
import { PER_COMPUTER_SECRET_HINT } from '../util/secretHint';

export interface CloudRequestTarget {
  baseUrl: string;
  apiKey: string;
}

export async function resolveCloudRequestTarget(
  model: ModelConfig,
  secrets: vscode.SecretStorage | undefined,
  /** The turn's cancel signal. A `remote_start` model may make the desktop wait
   *  up to 300 s for a cold start, and a Stop must cut that wait — without it,
   *  Stop would not take effect until the starter answered. It also cuts the
   *  probe of the desktop relay in a remote window. */
  signal?: AbortSignal,
  /** `image` is the one request the desktop relay does not forward, so a remote
   *  window is told that instead of being sent to a chat endpoint. */
  purpose: 'chat' | 'image' = 'chat',
): Promise<CloudRequestTarget> {
  if (!isCloudProvider(model.provider)) {
    throw new Error(`Forge: model "${model.name}" is not a direct cloud provider model`);
  }
  // In a VS Code Remote window the key is not in this window's keychain at all,
  // so a key-based model is served by the desktop's cloud relay, which resolves
  // the key and the real endpoint itself and never lets a key cross to the
  // laptop. A `remote_start` model and a keyless `openai-compatible` model are
  // skipped: neither reads a key, so both keep the path they already had.
  const readsKey =
    !model.remote_start && !(model.provider === 'openai-compatible' && !model.api_key_secret);
  if (readsKey) {
    const relay = await remoteRelayTarget(model, signal, purpose);
    if (relay) return relay;
  }
  const baseUrl = getCloudBaseUrl(model);
  if (model.provider === 'xai') {
    return { baseUrl, apiKey: await resolveXaiToken(model.api_key_secret, secrets) };
  }
  const keyName = model.api_key_secret;
  // A `remote_start` model is another machine's server: the port in its
  // `endpoint` is the one this window guessed, and the server may not even be
  // running. Ask the desktop's starter for the port it is actually answering on
  // — which also starts or loads it — and skip `beforeExternalRequest`, since
  // this window neither manages nor can free that server.
  const starter = model.remote_start ? remoteStarterFor(model) : undefined;
  // A local OpenAI-compatible server (Strata, LM Studio, vLLM) usually takes no
  // key. No api_key_secret means no Authorization header; a configured key
  // that is missing from SecretStorage is still an error below.
  if (model.provider === 'openai-compatible' && !keyName) {
    if (starter) return { baseUrl: (await starter.ensure(model, signal)).baseUrl, apiKey: '' };
    await beforeExternalRequest(model);
    return { baseUrl, apiKey: '' };
  }
  const apiKey = keyName ? await secrets?.get(keyName) : undefined;
  if (!apiKey) {
    throw new Error(
      `${getCloudProviderLabel(model.provider)}: no bearer token in SecretStorage ` +
        `(key: ${keyName ?? 'unset'}). Run "Forge: Set Cloud Provider Token" and set ` +
        `api_key_secret in config.yaml. ${PER_COMPUTER_SECRET_HINT}`,
    );
  }
  if (starter) return { baseUrl: (await starter.ensure(model, signal)).baseUrl, apiKey };
  // A local server Forge unloads (Strata) frees the local models first.
  await beforeExternalRequest(model);
  return { baseUrl, apiKey };
}
