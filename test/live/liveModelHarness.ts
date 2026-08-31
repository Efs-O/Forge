import type { ToolDefinition } from '../../src/llm/types';
import type {
  ToolHandlerContext,
  ToolPermission,
  ToolRegistry,
} from '../../src/tools/ToolRegistry';

interface LiveMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  name?: string;
  tool_calls?: LiveToolCall[];
}

interface LiveToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface CompletionMessage {
  content?: string | null;
  tool_calls?: LiveToolCall[];
}

export interface ToolLoopResult {
  final: string;
  calls: string[];
  /** The loop ran out of steps rather than the model finishing. */
  hitStepLimit: boolean;
}

export async function callLiveModel(
  endpoint: string,
  model: string,
  messages: LiveMessage[],
  tools?: ToolDefinition[],
  imageDataUrl?: string,
): Promise<CompletionMessage> {
  const last = messages.at(-1);
  const requestMessages = imageDataUrl
    ? [
        ...messages.slice(0, -1),
        {
          role: last?.role ?? 'user',
          content: [
            { type: 'text', text: last?.content ?? '' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ]
    : messages;
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0,
      max_tokens: 256,
      chat_template_kwargs: { enable_thinking: false },
      messages: requestMessages,
      ...(tools?.length ? { tools } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Live model HTTP ${response.status}: ${body.slice(0, 500)}`);
  const payload = JSON.parse(body) as { choices?: Array<{ message?: CompletionMessage }> };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error('Live model returned no assistant message');
  return message;
}

export async function runLiveToolLoop(options: {
  endpoint: string;
  model: string;
  prompt: string;
  registry: ToolRegistry;
  allowed: Set<ToolPermission>;
  context: ToolHandlerContext;
  maxSteps?: number;
  /** Overrides the harness default agent system prompt. */
  systemPrompt?: string;
  /** Re-read before EVERY request, so a tool that changes the advertised set
   *  (load_tool_group) is exercised the way ToolCallingLoop exercises it. */
  getDefinitions?: () => ToolDefinition[];
  /** Fires after each dispatched call, with the tool list the NEXT request will carry. */
  onRound?: (info: { call: string; result: string; nextDefinitions: string[] }) => void;
}): Promise<ToolLoopResult> {
  const messages: LiveMessage[] = [
    {
      role: 'system',
      content:
        options.systemPrompt ??
        'You are a coding agent. Use the supplied tools to complete the task. Continue until complete, then answer briefly.',
    },
    { role: 'user', content: options.prompt },
  ];
  const definitionsFor = (): ToolDefinition[] =>
    options.getDefinitions?.() ?? options.registry.definitions(options.allowed);
  const calls: string[] = [];
  for (let step = 0; step < (options.maxSteps ?? 8); step += 1) {
    const assistant = await callLiveModel(
      options.endpoint,
      options.model,
      messages,
      definitionsFor(),
    );
    const toolCalls = assistant.tool_calls ?? [];
    messages.push({
      role: 'assistant',
      content: assistant.content ?? null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    if (!toolCalls.length) return { final: assistant.content ?? '', calls, hitStepLimit: false };
    for (const call of toolCalls) {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      const tool = options.registry.get(call.function.name);
      if (!tool) throw new Error(`Live model requested unknown tool ${call.function.name}`);
      if (tool.mutation) options.context.beforeMutate(tool.mutation.paths(args));
      const result = (await options.registry.dispatch(
        call.function.name,
        args,
        options.allowed,
        options.context,
      )) as string;
      calls.push(call.function.name);
      options.onRound?.({
        call: call.function.name,
        result,
        nextDefinitions: definitionsFor().map((d) => d.function.name),
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: result,
      });
    }
  }
  // Returned, not thrown -- the same call ToolCallingLoop makes for its round
  // cap: the steps already spent did real work, and throwing discards the
  // record of what the model actually chose to call.
  return { final: '', calls, hitStepLimit: true };
}
