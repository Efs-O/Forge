/**
 * The one place that knows what a VS Code Remote window does with a key-based
 * cloud model: it holds no key of its own, so the request goes to the desktop's
 * cloud relay.
 *
 * A remote window's extension host runs ON the desktop, but its SecretStorage is
 * the keychain of the machine being typed on, which by owner rule holds no API
 * keys. So OpenRouter, OpenAI and keyed `openai-compatible` models would
 * fail there with "no bearer token" — on a machine that has the desktop's
 * models, the desktop's GPUs and none of the desktop's keys. The desktop's own
 * (non-remote) Forge window already holds the keys and already runs the relay on
 * loopback, and this window is on the same machine, so it can reach that port
 * directly. No key crosses to the laptop, and none is read here.
 *
 * This is a rule, not a fallback: in a hosted window a key-based model ALWAYS
 * goes through the relay, and the window NEVER reads SecretStorage for it. In a
 * local window nothing changes, and neither does a WSL, container or Codespaces
 * window: `vscode/remoteWindowKind.ts` counts those as this computer's own,
 * because the keychain VS Code reads is this machine's, so they keep reading
 * their keys and calling the provider directly.
 *
 * `CloudRelayServer.ts` is the other half — it resolves the key and the real
 * endpoint on the desktop — and the guard in `vscode/tailnetServicesSetup.ts`
 * is what guarantees a hosted window never serves the relay itself, which would
 * mean forwarding its own requests to itself.
 */

import { getCloudProviderLabel, isCloudProvider } from './CloudProviders';
import type { ForgeConfig, ModelConfig } from '../config/types';

/** The probe is `GET /v1/models` on loopback, against a window on this same
 *  machine, so 2 s is generous: the only thing it can be waiting for is a Forge
 *  window that is not open. */
const RELAY_PROBE_TIMEOUT_MS = 2_000;

let windowHostedElsewhere = false;
let readConfig: (() => ForgeConfig) | undefined;

export interface RemoteWindowRelayTarget {
  baseUrl: string;
  apiKey: string;
}

/**
 * Called once in activation with `thisWindowHostedElsewhere()` from
 * `vscode/remoteWindowKind.ts` — whether a second computer is typing through
 * this window — and with the live config. Module state, like the logger: tests
 * reset it by passing `false`.
 */
export function configureRemoteWindowRoute(
  hostedElsewhere: boolean,
  getConfig: () => ForgeConfig,
): void {
  windowHostedElsewhere = hostedElsewhere;
  readConfig = getConfig;
}

/**
 * The relay this window should send `model` to, or `undefined` because this
 * window is not hosted on another computer's behalf — a local window, or WSL, a
 * container or a Codespaces, which read this computer's keychain and so keep
 * the path they had. Everything that would make the request fail throws, with
 * what to do about it: a hosted window must never quietly read a key that is
 * not there and then report a missing token from a machine that was never meant
 * to have one.
 */
export async function remoteRelayTarget(
  model: ModelConfig,
  signal?: AbortSignal,
  purpose: 'chat' | 'image' = 'chat',
): Promise<RemoteWindowRelayTarget | undefined> {
  if (!windowHostedElsewhere || !isCloudProvider(model.provider)) return undefined;
  const config = readConfig?.();
  // Unconfigured — which activation order rules out — reads as local, the way
  // this window behaved before the rule existed.
  if (!config) return undefined;
  const label = getCloudProviderLabel(model.provider);
  const relay = config.cloud_relay;
  const host = `127.0.0.1:${relay?.port ?? 0}`;
  const notAnswering = (): Error =>
    new Error(
      `${label}: no Forge cloud relay answers on ${host}. It runs in the desktop's ` +
        `own (non-remote) Forge window: open that window, or reload it after ` +
        `enabling cloud_relay.`,
    );

  if (purpose === 'image') {
    throw new Error(
      `${label}: image generation with a key-based provider is not available in a ` +
        `VS Code Remote window. Keys stay on the desktop, and its cloud relay ` +
        `forwards chat only.`,
    );
  }
  if (!relay?.enabled) {
    throw new Error(
      `${label}: in a VS Code Remote window, key-based cloud models go through the ` +
        `desktop's cloud relay, which is off. Set cloud_relay.enabled: true in ` +
        `config.yaml and reload the desktop's own Forge window.`,
    );
  }
  if (!relay.models.includes(model.name)) {
    throw notListed(label, model.name, relay.models, host);
  }

  const probeSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(RELAY_PROBE_TIMEOUT_MS)])
    : AbortSignal.timeout(RELAY_PROBE_TIMEOUT_MS);
  let listed: string[] | undefined;
  try {
    const response = await fetch(`http://${host}/v1/models`, { signal: probeSignal });
    const body = await response.json().catch(() => undefined);
    // A non-200 means something else is answering on the relay's port, which is
    // the same practical fault as nothing answering: this window has no relay.
    listed = response.ok ? listedIds(body) : undefined;
  } catch (err) {
    // A Stop aborts the caller's signal; that is what the user asked for, not a
    // missing relay, so report the abort and let the turn end.
    if (signal?.aborted) throw err;
    throw notAnswering();
  }
  if (!listed) throw notAnswering();
  if (!listed.includes(model.name)) throw notListed(label, model.name, listed, host);
  return { baseUrl: `http://${host}`, apiKey: '' };
}

/**
 * The relay answers `GET /v1/models` with what IT will serve, so a 200 that
 * lacks this model is a desktop window still running an older config.yaml — a
 * different fault from "not allowlisted here", and one only the desktop can fix.
 * Same sentence either way, because the fix is the same.
 */
function notListed(label: string, name: string, names: readonly string[], host: string): Error {
  return new Error(
    `${label}: "${name}" is not in the desktop cloud relay's list on ${host} ` +
      `(${names.length ? names.join(', ') : 'nothing listed'}). Add it to ` +
      `cloud_relay.models in the desktop's config.yaml and reload that window.`,
  );
}

/** The ids from an OpenAI-style `{ object: 'list', data: [{ id }] }`. */
function listedIds(body: unknown): string[] {
  const data = (body as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((entry) => (entry as { id?: unknown } | undefined)?.id)
    .filter((id): id is string => typeof id === 'string');
}
