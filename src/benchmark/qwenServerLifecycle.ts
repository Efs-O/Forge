import * as fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { ForgeConfigSchema } from '../config/schema';
import type { ForgeConfig, ModelConfig } from '../config/types';
import { DirectBackend } from '../backend/DirectBackend';
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

export async function ensureForgeQwen(options: QwenLifecycleOptions): Promise<QwenServerHandle> {
  const config = readConfig(options.forgeConfigPath);
  const selected = selectModel(config, options.model);
  const logicalModel = selected.name;
  const response = await controlRequest(controlUrl(config), 'ensure', logicalModel);
  if (typeof response.baseUrl !== 'string') throw new Error('Forge /ensure returned no baseUrl.');
  const endpoint = normalizeLlamaBaseUrl(response.baseUrl);
  const facts = await inspectQwenEndpoint(endpoint);
  return { phase: 'forge', endpoint, logicalModel, facts };
}

export async function unloadForgeQwen(handle: QwenServerHandle, configPath: string): Promise<void> {
  const config = readConfig(configPath);
  const baseUrl = controlUrl(config);
  await controlRequest(baseUrl, 'release', handle.logicalModel);
  await controlRequest(baseUrl, 'unload', handle.logicalModel);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${handle.endpoint}/v1/models`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return;
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Forge unloaded ${handle.logicalModel} but ${handle.endpoint} stayed reachable.`);
}

export async function startMinimalQwen(
  options: QwenLifecycleOptions,
  endpoint: string,
): Promise<QwenServerHandle> {
  const config = readConfig(options.forgeConfigPath);
  const selected = selectModel(config, options.model);
  const root = normalizeLlamaBaseUrl(endpoint);
  const parsedEndpoint = new URL(root);
  const port = Number(parsedEndpoint.port);
  if (!port) throw new Error(`Minimal Qwen endpoint has no explicit port: ${root}`);
  if (!selected.gguf_path) throw new Error(`Qwen model ${selected.name} has no gguf_path.`);
  const minimalModel: ModelConfig = { name: selected.name, gguf_path: selected.gguf_path };
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
