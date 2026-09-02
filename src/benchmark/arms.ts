import type { ModelConfig } from '../config/types';
import { runToolCallingLoop } from '../agent/ToolCallingLoop';
import { injectSystemPrompt } from '../llm/SystemPromptInjector';
import { mergeSampling } from '../llm/SamplingMerge';
import type { ChatMessage, ToolCall, ToolDefinition } from '../llm/types';
import { CliAgentDriver } from '../agents/CliAgentDriver';
import type { CliAgentName, CliAgentRunStatus } from '../agents/types';
import type { BenchmarkToolHost } from './toolHost';

export interface QwenUsage {
  last?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  rounds: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ArmCallbacks {
  event(kind: 'text' | 'reasoning' | 'tool' | 'error' | 'status', text: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
  usage?(usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }): void;
}

export interface AgentExecution {
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  finalText: string;
  error?: string;
  qwenUsage?: QwenUsage;
  cliStatus?: CliAgentRunStatus;
  sessionId?: string;
}

function addUsage(
  target: QwenUsage,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): void {
  target.last = usage;
  target.rounds += 1;
  target.prompt_tokens += usage.prompt_tokens;
  target.completion_tokens += usage.completion_tokens;
  target.total_tokens += usage.total_tokens;
}

function callText(call: ToolCall): string {
  return `${call.function.name} ${call.function.arguments}`;
}

async function dispatchCalls(
  calls: ToolCall[],
  messages: ChatMessage[],
  host: BenchmarkToolHost,
  signal: AbortSignal,
  callbacks: ArmCallbacks,
): Promise<void> {
  for (const call of calls) {
    callbacks.event('tool', callText(call));
    let result: string;
    try {
      result = await host.dispatch(call, signal);
    } catch (error) {
      result = `Tool call failed: ${error instanceof Error ? error.message : String(error)}`;
      callbacks.event('error', result);
    }
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      name: call.function.name,
      content: result,
    });
  }
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function minimalCompletion(
  endpoint: string,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  requestModel: ModelConfig | undefined,
  signal: AbortSignal,
): Promise<CompletionResponse> {
  // Use Forge's canonical sampler merge so preserve_thinking is placed in
  // chat_template_kwargs rather than accidentally sent as a top-level API
  // field. The only minimal-arm override is its reasoning level below.
  const request = mergeSampling(
    { model, messages, stream: true, tools },
    requestModel,
    { allowPreserveThinking: true },
  );
  const reasoningEffort = requestModel?.reasoning_effort ?? 'low';
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...request,
      stream: false,
      // Keep the neutral arm's loop and prompt minimal, but match the Forge
      // arm's configured Qwen reasoning level for this controlled comparison.
      chat_template_kwargs: {
        ...request.chat_template_kwargs,
        enable_thinking: requestModel?.think !== false,
        reasoning_effort: reasoningEffort,
      },
    }),
    signal,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`llama-server HTTP ${response.status}: ${body.slice(0, 1000)}`);
  return JSON.parse(body) as CompletionResponse;
}

export async function runQwenMinimal(
  endpoint: string,
  model: string,
  problem: string,
  host: BenchmarkToolHost,
  signal: AbortSignal,
  callbacks: ArmCallbacks,
  requestModel?: ModelConfig,
): Promise<AgentExecution> {
  // No Forge system prompt: the direct arm is intentionally just the Qwen
  // chat template's default system behavior plus the issue text and tools.
  const messages: ChatMessage[] = [{ role: 'user', content: problem }];
  const usage: QwenUsage = { rounds: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  try {
    for (let round = 0; round < 100; round += 1) {
      signal.throwIfAborted();
      const response = await minimalCompletion(
        endpoint,
        model,
        messages,
        host.definitions(),
        requestModel,
        signal,
      );
      callbacks.stdout(`${JSON.stringify(response)}\n`);
      const message = response.choices?.[0]?.message;
      if (!message) throw new Error('llama-server returned no assistant message.');
      const promptTokens = response.usage?.prompt_tokens;
      const completionTokens = response.usage?.completion_tokens;
      const totalTokens = response.usage?.total_tokens;
      if (
        [promptTokens, completionTokens, totalTokens].every((value) => typeof value === 'number')
      ) {
        const exact = {
          prompt_tokens: promptTokens!,
          completion_tokens: completionTokens!,
          total_tokens: totalTokens!,
        };
        addUsage(usage, exact);
        callbacks.usage?.(exact);
      }
      const calls = message.tool_calls ?? [];
      messages.push({
        role: 'assistant',
        content: message.content ?? null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      if (message.content) callbacks.event('text', message.content);
      if (!calls.length)
        return { status: 'completed', finalText: message.content ?? '', qwenUsage: usage };
      await dispatchCalls(calls, messages, host, signal, callbacks);
    }
    return {
      status: 'completed',
      finalText: 'The agent reached the 100-round limit.',
      qwenUsage: usage,
    };
  } catch (error) {
    if (signal.aborted)
      return {
        status: 'timed_out',
        finalText: '',
        qwenUsage: usage,
        error: 'Qwen minimal arm timed out.',
      };
    return {
      status: 'failed',
      finalText: '',
      qwenUsage: usage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runQwenForge(
  endpoint: string,
  modelName: string,
  problem: string,
  host: BenchmarkToolHost,
  signal: AbortSignal,
  callbacks: ArmCallbacks,
  configuredModel?: ModelConfig,
): Promise<AgentExecution> {
  const messages: ChatMessage[] = [{ role: 'user', content: problem }];
  const usage: QwenUsage = { rounds: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const model: ModelConfig = {
    ...configuredModel,
    name: modelName,
    provider: 'llama.cpp',
    // These are resolved from the live Qwen config by the lifecycle owner.
    think: configuredModel?.think ?? true,
    reasoning_effort: configuredModel?.reasoning_effort ?? 'low',
    strip_thinking_channels: configuredModel?.strip_thinking_channels ?? true,
    capabilities: ['tool-call'],
    sampling: { ...(configuredModel?.sampling ?? {}) },
  };
  try {
    const result = await runToolCallingLoop({
      baseUrl: endpoint,
      model,
      messages,
      getToolDefinitions: host.definitions,
      signal,
      maxRounds: model.max_tool_rounds ?? 500,
      ...(model.sampling?.max_tokens !== undefined
        ? { maxOutputTokens: model.sampling.max_tokens }
        : {}),
      nativeTools: true,
      canUseThinkingKwargs: true,
      stripThinkingChannels: model.strip_thinking_channels ?? true,
      includeUsage: true,
      prepareMessages: (current) =>
        injectSystemPrompt(
          current,
          undefined,
          undefined,
          model.system_prompt,
          model.system_prompt_mode,
        ),
      onToken: (text) => {
        callbacks.stdout(text);
        callbacks.event('text', text);
      },
      onReasoning: (text) => callbacks.event('reasoning', text),
      onUsage: (value) => {
        const exact = {
          prompt_tokens: value.prompt_tokens,
          completion_tokens: value.completion_tokens,
          total_tokens: value.total_tokens,
        };
        addUsage(usage, exact);
        callbacks.usage?.(exact);
      },
      dispatchToolCalls: async (calls, current) =>
        dispatchCalls(calls, current, host, signal, callbacks),
      onMessagesChanged: () => undefined,
    });
    return { status: 'completed', finalText: result.finalText, qwenUsage: usage };
  } catch (error) {
    if (signal.aborted)
      return {
        status: 'timed_out',
        finalText: '',
        qwenUsage: usage,
        error: 'Qwen Forge arm timed out.',
      };
    return {
      status: 'failed',
      finalText: '',
      qwenUsage: usage,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runCliArm(
  cliName: CliAgentName,
  executable: string,
  problem: string,
  workspace: string,
  timeoutMs: number,
  signal: AbortSignal,
  callbacks: ArmCallbacks,
): Promise<AgentExecution> {
  const driver = new CliAgentDriver();
  const result = await driver.run({
    cliName,
    executable,
    task: problem,
    cwd: workspace,
    timeoutMs,
    signal,
    onEvent: (event) => callbacks.event(event.kind, event.text),
    onStdoutLine: (line) => callbacks.stdout(`${line}\n`),
    onStderr: (text) => callbacks.stderr(text),
  });
  return {
    status:
      result.status === 'completed'
        ? 'completed'
        : result.status === 'timed_out'
          ? 'timed_out'
          : result.status,
    finalText: result.finalText,
    ...(result.error ? { error: result.error } : {}),
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    cliStatus: result.status,
  };
}

