import type { ForgeConfig, ModelConfig } from '../config/types';
import { expandAlias, resolveRequestModel, splitModelProfile } from '../config/ConfigResolver';
import { isCloudProvider } from '../llm/CloudProviders';
import { classifyModelRoute, type ModelRoute } from '../llm/ModelRouteClassifier';

export interface DelegationTarget {
  requested: string;
  resolvedId: string;
  baseModel: string;
  model: ModelConfig;
  provider: 'llama.cpp' | 'ollama' | 'cli' | 'cloud';
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

export function resolveDelegationTarget(config: ForgeConfig, requested: string): DelegationTarget {
  let model: ModelConfig;
  let resolvedId: string;
  try {
    model = resolveRequestModel(config, requested);
    // `model.name` is the fuzzy resolver's canonical match (ConfigResolver),
    // which may differ from the alias-only expansion below when `requested`
    // was a short_name/prefix/substring rather than an exact name or alias —
    // rebuild resolvedId from the canonical name so downstream BackendPool
    // keying (which only expands exact aliases) stays correct.
    const { profile } = splitModelProfile(expandAlias(config, requested));
    resolvedId = profile ? `${model.name}@${profile}` : model.name;
  } catch (err) {
    throw new Error(`Unknown delegation target "${requested}": ${(err as Error).message}`);
  }

  const base = model.name;
  const provider = model.provider ?? 'llama.cpp';

  if (provider === 'llama.cpp') {
    return { requested, resolvedId, baseModel: base, model, provider };
  }

  if (provider === 'ollama') {
    // A non-local Ollama endpoint is someone else's daemon: Forge holds no
    // auth for it and the backend pool cannot manage its lifecycle. Still
    // rejected. Cloud-ROUTED models (the "-cloud"/":cloud" tag) are fine —
    // they reach the local daemon like any other Ollama target, and auth is
    // the user's own `ollama auth login`.
    if (!isLocalOllamaEndpoint(model.endpoint)) {
      throw new Error(
        `Delegation target "${requested}" uses a non-local Ollama endpoint (${model.endpoint}); only local Ollama daemon targets are allowed.`,
      );
    }
    return { requested, resolvedId, baseModel: base, model, provider };
  }

  if (provider === 'cli') {
    // Local by definition — the CLI handles its own subscription auth, never
    // Forge's backend pool. No capacity check needed: it spawns its own process.
    return { requested, resolvedId, baseModel: base, model, provider };
  }

  if (isCloudProvider(provider)) {
    // Opt-in, user-configured cloud providers only (config.yaml entry + a key
    // in SecretStorage). The exclusion these targets used to hit was a VRAM
    // capacity rule, and a cloud target occupies no local slot — it takes the
    // no-hold path in LocalDelegationService instead.
    return { requested, resolvedId, baseModel: base, model, provider: 'cloud' };
  }

  throw new Error(
    `Delegation target "${requested}" uses unsupported provider "${String(provider)}"; supported targets are llama.cpp, local Ollama, configured cloud providers, and provider: cli agents.`,
  );
}

/** One advertisable delegation target: the name to pass as `model`, plus the
 *  kind that tells the caller what it will get (tool-less vs its own tools). */
export interface EligibleDelegationTarget {
  name: string;
  provider: DelegationTarget['provider'];
  /** Canonical route, from ModelRouteClassifier — the sole owner of the
   *  cloud-routed-Ollama distinction `provider` alone cannot express. */
  route: ModelRoute;
  /** True when running this target loads weights into local VRAM.
   *
   *  Not derivable from `provider`: an Ollama entry tagged `:cloud` reaches the
   *  daemon like any other but runs remotely and costs no VRAM, while a plain
   *  Ollama entry with no endpoint set is local and does. DelegationGate counts
   *  free SLOTS (max_simultaneous_models), not gigabytes, so on a single card
   *  it will permit a second large local model the hardware cannot hold. */
  localWeights: boolean;
}

/** Whether a delegation target loads weights into local VRAM. */
export function targetUsesLocalWeights(route: ModelRoute): boolean {
  return route === 'local-llama' || route === 'local-ollama';
}

/**
 * Every configured model that can accept a delegation, with its kind.
 *
 * Exists so `ask_local_agent` can NAME its valid targets in its schema. Without
 * it the model's only way to learn that `qwen/qwen3.8-max` is a legal value is
 * to read config.yaml — which costs ~23k tokens of context before the first
 * delegation and invites hallucinated model names.
 */
export function listEligibleDelegationTargets(config: ForgeConfig): EligibleDelegationTarget[] {
  const targets: EligibleDelegationTarget[] = [];
  for (const model of config.models) {
    try {
      const target = resolveDelegationTarget(config, model.name);
      const route = classifyModelRoute(target.model);
      targets.push({
        name: model.name,
        provider: target.provider,
        route,
        localWeights: targetUsesLocalWeights(route),
      });
    } catch {
      // not an eligible delegation target
    }
  }
  return targets;
}
