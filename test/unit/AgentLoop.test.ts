import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop, type SidebarProviderEvents } from '../../src/sidebar/AgentLoop';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { BackendController } from '../../src/backend/BackendController';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import type { DiffDecorations } from '../../src/sidebar/DiffDecorations';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';

const { streamModelChatCompletion, inspectRuntimeModelCapabilities } = vi.hoisted(() => ({
  streamModelChatCompletion: vi.fn(),
  inspectRuntimeModelCapabilities: vi.fn().mockResolvedValue({}),
}));

vi.mock('vscode', () => ({
  window: {
    activeTextEditor: undefined,
    createOutputChannel: vi.fn(() => ({
      appendLine: vi.fn(),
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    })),
    showWarningMessage: vi.fn(),
  },
}));

vi.mock('../../src/llm/ChatClient', () => ({
  streamModelChatCompletion,
}));

vi.mock('../../src/backend/ModelCapabilities', () => ({
  inspectRuntimeModelCapabilities,
}));

function makeConfig(model: Partial<ModelConfig> = {}): ForgeConfig {
  return {
    models: [
      {
        name: 'test-model',
        provider: 'llama.cpp',
        gguf_path: '/models/test.gguf',
        ...model,
      },
    ],
    active_model: 'test-model',
    llama_server: {},
  } as ForgeConfig;
}

function makeConversation(): ConversationRuntime {
  return {
    id: 'conv-1',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
  };
}

function makeBackend(): BackendController {
  return {
    start: async () => {},
    stop: async () => {},
    showConsole: () => {},
    isReady: () => true,
    baseUrl: () => 'http://127.0.0.1:8080',
    loadedModel: () => 'test-model',
    hotSwap: async () => {},
    applyForgeConfig: () => {},
  };
}

function makePool(acquireImpl?: (modelName: string) => Promise<BackendController>): IBackendPool {
  return {
    acquire: acquireImpl ?? (async () => makeBackend()),
    release: async () => {},
    stopAll: async () => {},
    applyForgeConfig: () => {},
    showConsole: () => {},
    isAnyReady: () => false,
    loadedModelNames: () => [],
    isLoaded: () => false,
  };
}

function makeLoop(
  pool: IBackendPool,
  config: ForgeConfig,
  post: (message: unknown) => void = vi.fn(),
  registry: ToolRegistry = new ToolRegistry(),
  cliDriver?: CliAgentDriver,
): AgentLoop {
  const checkpoint = {
    snapshotBefore: vi.fn(),
    snapshotMissingBefore: vi.fn(),
  };
  const checkpoints = {
    beginTurn: vi.fn(() => checkpoint),
    commitTurn: vi.fn(),
    depth: vi.fn().mockReturnValue(0),
  } as unknown as CheckpointStack;

  const codeLens = {
    markPending: vi.fn(),
    clearPending: vi.fn(),
  } as unknown as KeepUndoCodeLensProvider;

  const diffDecorations = {} as DiffDecorations;
  const failureTracker = {
    shouldStrip: vi.fn().mockReturnValue(false),
    reset: vi.fn(),
    record: vi.fn(),
  } as unknown as ToolFailureTracker;

  const events: SidebarProviderEvents = {
    onBackendError: vi.fn(),
    onBackendReady: vi.fn(),
    onGenerationStarted: vi.fn(),
    onGenerationFinished: vi.fn(),
  };

  return new AgentLoop(
    pool,
    () => config,
    registry,
    checkpoints,
    codeLens,
    diffDecorations,
    failureTracker,
    events,
    post,
    () => undefined,
    undefined,
    undefined,
    undefined,
    process.cwd(),
    undefined,
    cliDriver,
  );
}

describe('AgentLoop', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not commit a user prompt when backend startup fails', async () => {
    const conv = makeConversation();
    const config = makeConfig();
    const loop = makeLoop(
      makePool(async () => {
        throw new Error('offline');
      }),
      config,
    );

    await loop.runTurn(conv, config.models[0]!, 'hello while offline');

    expect(conv.messages).toHaveLength(0);
    expect(conv.title).toBe('Chat');
  });

  it('commits a user prompt once the backend is ready and the turn begins', async () => {
    streamModelChatCompletion.mockImplementation(
      (
        _baseUrl: string,
        _request: unknown,
        _model: ModelConfig,
        handlers: {
          onToken: (token: string) => void;
          onDone: (reason: string | null) => void;
          onError: (error: Error) => void;
          onToolCalls: (calls: unknown[] | null) => void;
        },
      ) => {
        handlers.onToken('hi');
        handlers.onToolCalls(null);
        handlers.onDone('stop');
      },
    );

    const conv = makeConversation();
    const config = makeConfig();
    const loop = makeLoop(makePool(), config);

    await loop.runTurn(conv, config.models[0]!, 'hello once connected');

    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[0]).toMatchObject({ role: 'user', content: 'hello once connected' });
    expect(conv.messages[1]).toMatchObject({ role: 'assistant', content: 'hi' });
    expect(conv.title).toBe('hello once connected');
  });

  it('runs a CLI model as a full-access direct sidebar conversation without a backend', async () => {
    const run = vi.fn(async (options: Parameters<CliAgentDriver['run']>[0]) => {
      options.onEvent?.({ kind: 'status', text: '[codex: edit src/foo.ts]' });
      options.onEvent?.({ kind: 'text', text: 'Implemented it.' });
      return { status: 'completed' as const, finalText: 'Implemented it.' };
    });
    const driver = { run } as unknown as CliAgentDriver;
    const config = makeConfig({ provider: 'cli', cli: process.execPath });
    const conv = makeConversation();
    const acquire = vi.fn(async () => makeBackend());
    const post = vi.fn();
    const loop = makeLoop(makePool(acquire), config, post, new ToolRegistry(), driver);

    await loop.runTurn(conv, config.models[0]!, 'please implement this');

    expect(acquire).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ access: 'full', cwd: process.cwd() }),
    );
    expect(conv.messages).toEqual([
      { role: 'user', content: 'please implement this' },
      { role: 'assistant', content: 'Implemented it.' },
    ]);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'toolActivity',
        toolName: 'claude',
        detail: '[codex: edit src/foo.ts]',
      }),
    );
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'done', finishReason: 'stop' }),
    );
  });

  it('reuses the CLI session for later turns in the same Forge conversation', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed' as const,
        finalText: 'First answer',
        sessionId: 'persistent-session',
      })
      .mockResolvedValueOnce({
        status: 'completed' as const,
        finalText: 'Second answer',
        sessionId: 'persistent-session',
      });
    const config = makeConfig({ provider: 'cli', cli: process.execPath, cli_model: 'opus' });
    const conv = makeConversation();
    const loop = makeLoop(
      makePool(vi.fn(async () => makeBackend())),
      config,
      vi.fn(),
      new ToolRegistry(),
      { run } as unknown as CliAgentDriver,
    );

    await loop.runTurn(conv, config.models[0]!, 'first prompt');
    await loop.runTurn(conv, config.models[0]!, 'second prompt');

    expect(conv.cli_sessions?.[config.models[0]!.name]).toBe('persistent-session');
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty('sessionId');
    expect(run.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        task: 'second prompt',
        sessionId: 'persistent-session',
        model: 'opus',
      }),
    );
  });

  it('runs a second CLI conversation while the first conversation is still waiting', async () => {
    let finishFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const run = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstBlocked;
        return { status: 'completed' as const, finalText: 'First finished' };
      })
      .mockResolvedValueOnce({ status: 'completed' as const, finalText: 'Second finished' });
    const config = makeConfig({ provider: 'cli', cli: process.execPath });
    const first = makeConversation();
    const second = { ...makeConversation(), id: 'conversation-2', messages: [] };
    const loop = makeLoop(
      makePool(vi.fn(async () => makeBackend())),
      config,
      vi.fn(),
      new ToolRegistry(),
      { run } as unknown as CliAgentDriver,
    );

    const firstTurn = loop.runTurn(first, config.models[0]!, 'slow prompt');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await loop.runTurn(second, config.models[0]!, 'independent prompt');

    expect(second.messages).toContainEqual({ role: 'assistant', content: 'Second finished' });
    expect(first.messages).toHaveLength(1);
    finishFirst?.();
    await firstTurn;
    expect(first.messages).toContainEqual({ role: 'assistant', content: 'First finished' });
  });

  it('rejects image input with an actionable setup message for a text-only model', async () => {
    const conv = makeConversation();
    const config = makeConfig();
    const acquire = vi.fn(async () => makeBackend());
    const post = vi.fn();
    const loop = makeLoop(makePool(acquire), config, post);

    await loop.runTurn(conv, config.models[0]!, 'inspect this', [
      { name: 'fixture.png', mediaType: 'image/png', data: 'aW1hZ2U=' },
    ]);

    expect(acquire).not.toHaveBeenCalled();
    expect(conv.messages).toHaveLength(0);
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        conversationId: conv.id,
        message: expect.stringMatching(/vision-capable model.*mmproj_path/s),
      }),
    );
  });

  it('advertises only the resolved model tools allowlist to the backend', async () => {
    let capturedTools: Array<{ function: { name: string } }> | undefined;
    streamModelChatCompletion.mockImplementation(
      (
        _baseUrl: string,
        request: { tools?: Array<{ function: { name: string } }> },
        _model: ModelConfig,
        handlers: {
          onToken: (token: string) => void;
          onDone: (reason: string | null) => void;
          onError: (error: Error) => void;
          onToolCalls: (calls: unknown[] | null) => void;
        },
      ) => {
        capturedTools = request.tools;
        handlers.onToken('hi');
        handlers.onToolCalls(null);
        handlers.onDone('stop');
      },
    );

    const registry = new ToolRegistry();
    registry.register({
      definition: {
        type: 'function',
        function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
      },
      permission: 'read',
      handler: vi.fn().mockResolvedValue('contents'),
    });
    registry.register({
      definition: {
        type: 'function',
        function: { name: 'run_terminal', description: 'exec', parameters: { type: 'object' } },
      },
      permission: 'terminal',
      handler: vi.fn().mockResolvedValue('ran'),
    });

    const conv = makeConversation();
    const config = makeConfig({ tools: ['read_file'] });
    const loop = makeLoop(makePool(), config, vi.fn(), registry);

    await loop.runTurn(conv, config.models[0]!, 'list allowed tools');

    expect(capturedTools?.map((t) => t.function.name)).toEqual(['read_file']);
  });

  it('blocks non-allowlisted dispatch and returns the wrap-up message once a per-turn budget is spent', async () => {
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      (
        _baseUrl: string,
        _request: unknown,
        _model: ModelConfig,
        handlers: {
          onToken: (token: string) => void;
          onDone: (reason: string | null) => void;
          onError: (error: Error) => void;
          onToolCalls: (calls: unknown[] | null) => void;
        },
      ) => {
        round++;
        if (round <= 2) {
          handlers.onToolCalls([
            {
              id: `call-${round}`,
              type: 'function',
              function: { name: 'run_terminal', arguments: '{}' },
            },
          ]);
          handlers.onDone('tool_calls');
        } else {
          handlers.onToken('wrapped up');
          handlers.onToolCalls(null);
          handlers.onDone('stop');
        }
      },
    );

    const registry = new ToolRegistry();
    registry.register({
      definition: {
        type: 'function',
        function: { name: 'run_terminal', description: 'exec', parameters: { type: 'object' } },
      },
      permission: 'terminal',
      handler: vi.fn().mockResolvedValue('ran'),
    });

    const conv = makeConversation();
    const config = makeConfig({ tool_call_limits: { run_terminal: 1 } });
    const loop = makeLoop(makePool(), config, vi.fn(), registry);
    loop.setClankerMode(true); // bypass the confirm-UI gate; unrelated to the budget under test

    await loop.runTurn(conv, config.models[0]!, 'run it twice');

    const toolMessages = conv.messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toBe('ran');
    expect(toolMessages[1]?.content).toBe(
      'Budget exhausted: run_terminal was limited to 1 calls this turn (1 used). ' +
        'Do not call it again; wrap up with what you have.',
    );
  });
});
