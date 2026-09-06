import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ForgeConfigSchema } from '../config/schema';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { DirectBackend } from '../backend/DirectBackend';
import { resolveRequestModel, resolveSpawnModel } from '../config/ConfigResolver';
import { inspectQwenEndpoint, normalizeLlamaBaseUrl, type QwenEndpointFacts } from './preflight';

export interface QwenLifecycleOptions {
  forgeConfigPath: string;
  model?: string | undefined;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface QwenServerHandle {
  phase: 'forge' | 'minimal';
  endpoint: string;
  logicalModel: string;
  facts: QwenEndpointFacts;
  /** Resolved request-time settings from Forge's live config. */
  requestModel: ModelConfig;
  backend?: DirectBackend;
}

function readConfig(configPath: string): ForgeConfig {
  if (!fs.existsSync(configPath)) throw new Error(`Forge config not found: ${configPath}`);
  const parsed = ForgeConfigSchema.safeParse(parseYaml(fs.readFileSync(configPath, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid Forge config: ${parsed.error.message}`);
  return parsed.data as ForgeConfig;
}

function modelProvider(config: ForgeConfig, model: ModelConfig): string {
  const group = model.group ? config.groups?.[model.group] : undefined;
  return model.provider ?? group?.provider ?? 'llama.cpp';
}

function selectModel(config: ForgeConfig, requested?: string): ModelConfig {
  const candidates = config.models.filter(
    (model) => modelProvider(config, model) === 'llama.cpp' && /qwen/iu.test(model.name),
  );
  const selected = requested
    ? config.models.find((model) => model.name === requested)
    : (candidates.find((model) => /no-vision/iu.test(model.name)) ?? candidates[0]);
  if (!selected || modelProvider(config, selected) !== 'llama.cpp' || !selected.gguf_path)
    throw new Error(
      `No configured Qwen llama.cpp model was found${requested ? ` for ${requested}` : ''}.`,
    );
  return selected;
}

async function controlRequest(
  baseUrl: string,
  route: 'ensure' | 'release' | 'unload',
  model: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Forge /${route} failed: ${JSON.stringify(body)}`);
  return body;
}

function controlUrl(config: ForgeConfig): string {
  const port = config.control_server?.port;
  if (!port) throw new Error('Forge control_server.port is required for Qwen lifecycle control.');
  return `http://127.0.0.1:${port}`;
}

interface ChatNodeEntry {
  name: string;
  loaded: boolean;
  holds: number;
}

/** Read the chat node's catalog entry for the Qwen model from the control
 *  server. Returns null when the control server is unreachable or the model is
 *  not in the catalog — in which case there is nothing to contend with. */
async function fetchChatNodeEntry(
  baseUrl: string,
  modelName: string,
): Promise<ChatNodeEntry | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => ({}))) as {
      models?: Array<{ name: string; loaded: boolean; holds: number }>;
    };
    const candidates = body.models ?? [];
    const exact = modelName ? candidates.find((m) => m.name === modelName) : undefined;
    if (exact) return exact;
    // Fall back to any loaded local Qwen model when no exact name was given.
    return candidates.find((m) => m.loaded && /qwen/iu.test(m.name)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Before spawning a standalone minimal llama-server, verify the Forge chat node
 * does not still hold the same Qwen model in VRAM. The chat node is invisible
 * to the control server's /ensure hold-counter (it loads through the pool
 * directly), so the benchmark's own /release + /unload never frees it — and a
 * minimal server that shares the GPU with a resident 13 GB model starves and
 * crashes. Without `forceUnload` this fails loudly with the exact unload
 * command. With `forceUnload` it calls /unload (safe only when holds === 0)
 * and polls until the control server reports the model as no longer loaded.
 */
export async function checkOrUnloadChatNode(
  configPath: string,
  modelName: string,
  forceUnload: boolean,
): Promise<void> {
  let config: ForgeConfig;
  let base: string;
  try {
    config = readConfig(configPath);
    base = controlUrl(config);
  } catch {
    return; // no control server configured — nothing to contend with
  }
  const entry = await fetchChatNodeEntry(base, modelName);
  if (!entry?.loaded) return;
  if (entry.holds > 0) {
    throw new QwenArmUnavailableError(
      `Cannot start the minimal Qwen server: "${entry.name}" has ${entry.holds} active hold(s) — ` +
        `a chat session owns it. Stop the active session and try again.`,
    );
  }
  if (!forceUnload) {
    throw new QwenArmUnavailableError(
      `Cannot start the minimal Qwen server: the Forge chat node has "${entry.name}" loaded in ` +
        `VRAM (holds=0). Unload it first:\n` +
        `  node -e "fetch('${base}/unload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'${entry.name}'})}).then(r=>r.json()).then(console.log)"\n` +
        `Or re-run with --unload-chat-node to let the benchmark do this automatically.`,
    );
  }
  await controlRequest(base, 'unload', entry.name);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const check = await fetchChatNodeEntry(base, entry.name);
    if (!check?.loaded) return;
    if (Date.now() >= deadline) {
      throw new QwenArmUnavailableError(
        `Unloaded "${entry.name}" but the control server still reports it loaded after 30s.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function ensureForgeQwen(options: QwenLifecycleOptions): Promise<QwenServerHandle> {
  const config = readConfig(options.forgeConfigPath);
  const selected = selectModel(config, options.model);
  const logicalModel = selected.name;
  const requestModel = resolveRequestModel(config, logicalModel);
  const response = await controlRequest(controlUrl(config), 'ensure', logicalModel);
  if (typeof response.baseUrl !== 'string') throw new Error('Forge /ensure returned no baseUrl.');
  const endpoint = normalizeLlamaBaseUrl(response.baseUrl);
  const facts = await inspectQwenEndpoint(endpoint);
  return { phase: 'forge', endpoint, logicalModel, facts, requestModel };
}

/**
 * Thrown when a Qwen arm's server cannot be brought up or torn down because
 * something outside the benchmark owns the model. The caller records the arm as
 * SKIPPED rather than ERROR: the agent never ran, so nothing about the model
 * was measured.
 */
export class QwenArmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QwenArmUnavailableError';
  }
}

/**
 * Release the benchmark's own hold and unload the model.
 *
 * The question that matters is "is the model still resident in VRAM?", not "is
 * the port still answering" — Forge's pool hands out a rotating port and keeps
 * the server process addressable independently of what is loaded, so endpoint
 * reachability answered a different question than the one asked and failed even
 * when the unload had worked. Residency is read from the control server, the
 * same signal `checkOrUnloadChatNode` already uses.
 */
/**
 * Drop the benchmark's hold and leave the model resident.
 *
 * The counterpart to `unloadForgeQwen`, and the right ending for a run whose
 * arms all share Forge's own server. Unloading exists to free VRAM for the
 * standalone minimal server; with no minimal arm it does nothing but evict the
 * chat node. That is not free: the model comes back on the NEXT pool port
 * behind a new controller, so an agent watching the run from the sidebar loses
 * its endpoint every task. On 2026-09-05 that unload ran seven times in an
 * afternoon and killed the monitoring turn outright.
 */
export async function releaseForgeQwen(
  handle: QwenServerHandle,
  configPath: string,
): Promise<void> {
  await controlRequest(controlUrl(readConfig(configPath)), 'release', handle.logicalModel);
}

export async function unloadForgeQwen(handle: QwenServerHandle, configPath: string): Promise<void> {
  const config = readConfig(configPath);
  const baseUrl = controlUrl(config);
  await controlRequest(baseUrl, 'release', handle.logicalModel);
  const held = await fetchChatNodeEntry(baseUrl, handle.logicalModel);
  if (held?.loaded && held.holds > 0)
    throw new QwenArmUnavailableError(
      `Cannot unload "${handle.logicalModel}": ${held.holds} hold(s) remain after the benchmark ` +
        `released its own — a chat session owns the model. Close it to free the GPU.`,
    );
  await controlRequest(baseUrl, 'unload', handle.logicalModel);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const entry = await fetchChatNodeEntry(baseUrl, handle.logicalModel);
    if (!entry?.loaded) return;
    if (Date.now() >= deadline)
      throw new QwenArmUnavailableError(
        `Unloaded "${handle.logicalModel}" but the control server still reports it resident ` +
          `after 30s (holds=${entry.holds}).`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function startMinimalQwen(
  options: QwenLifecycleOptions,
  endpoint: string,
): Promise<QwenServerHandle> {
  const config = readConfig(options.forgeConfigPath);
  const selected = selectModel(config, options.model);
  const requestModel = resolveRequestModel(config, selected.name);
  const root = normalizeLlamaBaseUrl(endpoint);
  const parsedEndpoint = new URL(root);
  const port = Number(parsedEndpoint.port);
  if (!port) throw new Error(`Minimal Qwen endpoint has no explicit port: ${root}`);
  if (!selected.gguf_path) throw new Error(`Qwen model ${selected.name} has no gguf_path.`);
  const resolved = resolveSpawnModel(config, selected.name);
  // The neutral arm must still fit the task plus the shared tool schema. The
  // raw DirectBackend defaults are 4096 total tokens over four slots (1024 per
  // slot), which rejects this benchmark before the model can act. Preserve the
  // configured context capacity, use one slot for an apples-to-apples run, and
  // omit Forge-specific MTP/checkpoint/other extra argv settings.
  const minimalModel: ModelConfig = {
    name: selected.name,
    gguf_path: selected.gguf_path,
    num_ctx: Math.max(resolved.num_ctx ?? config.llama_server.default_num_ctx ?? 0, 32_768),
    n_parallel: 1,
  };
  const minimalConfig: ForgeConfig = {
    ...config,
    models: config.models.map((model) =>
      model.name === selected.name ? { ...minimalModel, name: selected.name } : model,
    ),
  };
  const backend = new DirectBackend(minimalConfig, port);
  try {
    await backend.hotSwap(selected.name);
    const actualEndpoint = normalizeLlamaBaseUrl(backend.baseUrl());
    const facts = await inspectQwenEndpoint(actualEndpoint);
    options.onStdout?.(`minimal llama-server ready at ${actualEndpoint}\n`);
    return {
      phase: 'minimal',
      endpoint: actualEndpoint,
      logicalModel: selected.name,
      facts,
      requestModel,
      backend,
    };
  } catch (error) {
    await backend.stop();
    throw error;
  }
}

export async function stopMinimalQwen(handle: QwenServerHandle): Promise<void> {
  if (handle.backend) await handle.backend.stop();
}
