import * as fs from 'fs';
import * as path from 'path';
import type { ChatMessage, ToolDefinition } from '../../src/llm/types';
import type {
  ToolHandlerContext,
  ToolPermission,
  ToolRegistry,
} from '../../src/tools/ToolRegistry';

interface LiveMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ChatMessage['content'];
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
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
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
            { type: 'text', text: typeof last?.content === 'string' ? last.content : '' },
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
  const recordedCalls: ToolLoopResult['toolCalls'] = [];
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
    if (!toolCalls.length) {
      return { final: assistant.content ?? '', calls, toolCalls: recordedCalls, hitStepLimit: false };
    }
    for (const call of toolCalls) {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      const tool = options.registry.get(call.function.name);
      if (!tool) throw new Error(`Live model requested unknown tool ${call.function.name}`);
      if (tool.mutation) options.context.beforeMutate(tool.mutation.paths(args));
      // A thrown tool goes back to the model as `Error: ...`, as ToolDispatch
      // sends it; throwing here ended the run on the first failed call.
      // A structured result (view_image's image parts) is unwrapped the way
      // ToolDispatch does it; sending the whole object got HTTP 400.
      let result: string;
      let content: ChatMessage['content'];
      try {
        const handled = await options.registry.dispatch(
          call.function.name,
          args,
          options.allowed,
          options.context,
        );
        result = typeof handled === 'string' ? handled : handled.text;
        content = typeof handled === 'string' ? handled : handled.content;
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
        content = result;
      }
      calls.push(call.function.name);
      recordedCalls.push({ name: call.function.name, args });
      options.onRound?.({
        call: call.function.name,
        result,
        nextDefinitions: definitionsFor().map((d) => d.function.name),
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content,
      });
    }
  }
  // Returned, not thrown -- the same call ToolCallingLoop makes for its round
  // cap: the steps already spent did real work, and throwing discards the
  // record of what the model actually chose to call.
  return { final: '', calls, toolCalls: recordedCalls, hitStepLimit: true };
}

/**
 * Resolve the real VS Code app root so the bundled ripgrep can be found.
 *
 * The vscode mock's env.appRoot is undefined, so find_files/search_code would
 * fall back to a bare `rg` that is not on PATH (and fail with `spawn rg
 * ENOENT`). The `code` shim is on PATH at <install>/bin/code(.cmd); the app
 * root is <install>/<commitHash>/resources/app — the commit-hash dir whose
 * resources/app/out/cli.js exists, most recently modified wins. An explicit
 * FORGE_LIVE_APP_ROOT override wins over discovery. Live-only: this runs in a
 * manually-invoked live test on a dev machine where VS Code is installed.
 */
export function resolveLiveAppRoot(): string | undefined {
  const override = process.env['FORGE_LIVE_APP_ROOT'];
  if (override) return override;
  const shimNames = process.platform === 'win32' ? ['code.cmd', 'code'] : ['code'];
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of shimNames) {
      const shim = path.join(dir, name);
      if (!fs.existsSync(shim)) continue;
      const installRoot = path.dirname(path.dirname(shim));
      let best: { appDir: string; mtime: number } | undefined;
      try {
        for (const entry of fs.readdirSync(installRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const appDir = path.join(installRoot, entry.name, 'resources', 'app');
          if (!fs.existsSync(path.join(appDir, 'out', 'cli.js'))) continue;
          const mtime = fs.statSync(appDir).mtimeMs;
          if (!best || mtime > best.mtime) best = { appDir, mtime };
        }
      } catch {
        continue; // install root unreadable; try the next shim hit
      }
      if (best) return best.appDir;
    }
  }
  return undefined;
}
