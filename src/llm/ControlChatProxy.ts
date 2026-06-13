import type * as vscode from 'vscode';
import type { ForgeConfig, ModelConfig } from '../config/types';
import type { ChatMessage } from './types';
import { streamModelChatCompletion } from './ChatClient';
import { getCloudBaseUrl, getCloudProviderLabel, isCloudProvider } from './CloudProviders';
import { resolveXaiToken } from './XaiAuth';
import { mergeSampling } from './SamplingMerge';
import type { ChatCompletionRequest, ToolCall, ToolDefinition } from './types';

/** A single buffered (non-streaming) chat request handled inside the extension
 *  host. Used by ControlServer's POST /chat so external orchestrators can reach
 *  cloud-provider workers whose API key only lives in SecretStorage. */
export interface ChatProxyRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  reasoning_effort?: 'high' | 'medium' | 'low' | 'none';
  stop?: string | string[];
  /** When set, the model may emit tool_calls — Relay reuses this for full agentic cloud workers. */
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface ChatProxyResult {
  content: string;
  reasoning: string;
  finishReason: string | null;
  /** Buffered tool calls from the completed stream, when the model emitted any. */
  toolCalls?: ToolCall[];
}

/** Carries an HTTP status so the route can map proxy failures faithfully. */
export class ProxyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ProxyError';
  }
}

export type ChatProxyFn = (req: ChatProxyRequest) => Promise<ChatProxyResult>;

async function resolveKey(
  model: ModelConfig,
  secrets: vscode.SecretStorage | undefined,
): Promise<string> {
  if (model.provider === 'xai') {
    return resolveXaiToken(model.api_key_secret, secrets);
  }
  const keyName = model.api_key_secret;
  const stored = keyName ? await secrets?.get(keyName) : undefined;
  if (!stored) {
    throw new ProxyError(
      422,
      `${getCloudProviderLabel(model.provider as 'openrouter')}: no bearer token in SecretStorage ` +
        `(key: ${keyName ?? 'unset'}). Run "Forge: Set Cloud Provider Token" and set ` +
        `api_key_secret in config.yaml.`,
    );
  }
  return stored;
}

/**
 * Builds the chatProxy function injected into ControlServer. Closes over a
 * config getter (so reloads are picked up) and SecretStorage. Routes only
 * cloud-provider models; local models must use /ensure (they have a real port).
 */
export function buildControlChatProxy(
  getConfig: () => ForgeConfig,
  secrets: vscode.SecretStorage | undefined,
): ChatProxyFn {
  return async (req: ChatProxyRequest): Promise<ChatProxyResult> => {
    const model = getConfig().models.find((m) => m.name === req.model);
    if (!model) throw new ProxyError(404, `unknown model "${req.model}" — not in config`);
    if (!isCloudProvider(model.provider)) {
      throw new ProxyError(
        422,
        `"${req.model}" is a local model — POST /ensure to load it and call its baseUrl directly. ` +
          `/chat only serves cloud-provider models.`,
      );
    }

    const baseUrl = getCloudBaseUrl(model);
    const apiKey = await resolveKey(model, secrets);

    // Apply the model's config defaults (sampling + reasoning_effort) — Relay's
    // direct-to-baseUrl dispatch bypassed this, which is the F1 root cause.
    // Build with conditional spreads so no key is set to an explicit undefined
    // (exactOptionalPropertyTypes), which would shadow the merged defaults.
    const base: ChatCompletionRequest = {
      model: model.name,
      messages: req.messages,
      stream: true,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.top_p !== undefined ? { top_p: req.top_p } : {}),
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      ...(req.reasoning_effort !== undefined ? { reasoning_effort: req.reasoning_effort } : {}),
      ...(req.stop !== undefined ? { stop: req.stop } : {}),
      ...(req.tools !== undefined ? { tools: req.tools } : {}),
    };
    const request = mergeSampling(base, model);

    let content = '';
    let reasoning = '';
    let toolCalls: ToolCall[] | undefined;
    return new Promise<ChatProxyResult>((resolve, reject) => {
      void streamModelChatCompletion(
        baseUrl,
        request,
        model,
        {
          onToken: (t) => {
            content += t;
          },
          onReasoning: (t) => {
            reasoning += t;
          },
          onToolCalls: (calls) => {
            toolCalls = calls;
          },
          onDone: (finishReason) =>
            resolve({ content, reasoning, finishReason, ...(toolCalls ? { toolCalls } : {}) }),
          onError: (err) => reject(err),
        },
        req.signal,
        apiKey,
      ).catch(reject);
    });
  };
}
