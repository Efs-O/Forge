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
  checkpointsOverride?: CheckpointStack,
): AgentLoop {
  const checkpoint = {
    snapshotBefore: vi.fn(),
    snapshotMissingBefore: vi.fn(),
    prepareWorkspace: vi.fn(async () => ({
      finish: vi.fn(async () => {}),
      discard: vi.fn(async () => {}),
    })),
  };
  const checkpoints =
    checkpointsOverride ??
    ({
      beginTurn: vi.fn(() => checkpoint),
      commitTurn: vi.fn(),
      depth: vi.fn().mockReturnValue(0),
    } as unknown as CheckpointStack);

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

function postedTypes(post: ReturnType<typeof vi.fn>): string[] {
  return post.mock.calls.map(([m]) => (m as { type?: string }).type ?? '');
}

/** Streams nothing and ends the turn, so a test can assert on the turn's edges. */
function completeTurnImmediately(): void {
  streamModelChatCompletion.mockImplementation(
    (
      _baseUrl: string,
      _request: unknown,
      _model: ModelConfig,
      handlers: { onDone: (reason: string | null) => void; onToolCalls: (c: unknown[] | null) => void },
    ) => {
      handlers.onToolCalls(null);
      handlers.onDone('stop');
      return Promise.resolve();
    },
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

  it('says nothing about starting a backend the warm pool hands over instantly', async () => {
    completeTurnImmediately();
    const config = makeConfig();
    const post = vi.fn();
    const loop = makeLoop(makePool(), config, post);

    await loop.runTurn(makeConversation(), config.models[0]!, 'warm prompt');

    // Two permanent transcript rows per prompt, describing an acquire that took
    // no measurable time, was the whole complaint.
    expect(postedTypes(post)).not.toContain('backendStarting');
    expect(postedTypes(post)).toContain('ready');
  });

  it('announces a start once the acquire outlasts the notice window', async () => {
    completeTurnImmediately();
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const held = new Promise<BackendController>((resolve) => {
        release = () => resolve(makeBackend());
      });
      const config = makeConfig();
      const post = vi.fn();
      const loop = makeLoop(makePool(() => held), config, post);

      const turn = loop.runTurn(makeConversation(), config.models[0]!, 'cold prompt');
      await vi.advanceTimersByTimeAsync(600);
      expect(postedTypes(post)).toContain('backendStarting');

      release?.();
      // Back to real timers before awaiting: the turn itself schedules
      // intervals that a fake clock would run forever.
      vi.useRealTimers();
      await turn;
      expect(postedTypes(post)).toContain('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a cancelled turn to settle before allowing a new backend acquire', async () => {
    let finishTurn: (() => void) | undefined;
    streamModelChatCompletion.mockImplementation(
      (
        _baseUrl: string,
        _request: unknown,
        _model: ModelConfig,
        handlers: {
          onDone: (reason: string | null) => void;
          onToolCalls: (calls: unknown[] | null) => void;
        },
      ) => {
        finishTurn = () => {
          handlers.onToolCalls(null);
          handlers.onDone('cancelled');
        };
        return Promise.resolve();
      },
    );
    const conv = makeConversation();
    const config = makeConfig();
    const loop = makeLoop(makePool(), config);

    const firstTurn = loop.runTurn(conv, config.models[0]!, 'slow prompt');
    await vi.waitFor(() => expect(loop.isStreamingConv(conv.id)).toBe(true));

    const cancellation = loop.cancel(conv.id);
    let barrierPassed = false;
    const barrier = loop.waitForCancelledTurns().then(() => {
      barrierPassed = true;
    });
    await Promise.resolve();
    expect(barrierPassed).toBe(false);

    finishTurn?.();
    await cancellation;
    await firstTurn;
    await barrier;
    expect(barrierPassed).toBe(true);
  });

  it('cancels a compaction prompt owned by the selected conversation', async () => {
    streamModelChatCompletion.mockImplementation(
      (
        _baseUrl: string,
        _request: unknown,
        _model: ModelConfig,
        handlers: { onDone: (reason: string | null) => void },
        signal: AbortSignal,
      ) => {
        signal.addEventListener('abort', () => handlers.onDone('cancelled'), { once: true });
      },
    );
    const conv = makeConversation();
    const loop = makeLoop(makePool(), makeConfig());

    const compact = loop.runPromptToMarkdown('summarize the conversation', conv.id);
    await vi.waitFor(() => expect(streamModelChatCompletion).toHaveBeenCalledOnce());
    await loop.cancel(conv.id);
    await expect(compact).resolves.toBe('');
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
      {
        role: 'tool',
        content: '[codex: edit src/foo.ts]',
        name: 'claude',
      },
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

  it('does not commit or launch a CLI prompt when rollback preparation fails', async () => {
    const run = vi.fn();
    const driver = { run } as unknown as CliAgentDriver;
    const config = makeConfig({ provider: 'cli', cli: process.execPath });
    const conv = makeConversation();
    const post = vi.fn();
    const checkpoint = {
      prepareWorkspace: vi.fn(async () => {
        throw new Error('checkpoint limit exceeded');
      }),
    };
    const checkpoints = {
      beginTurn: vi.fn(() => checkpoint),
      commitTurn: vi.fn(),
      depth: vi.fn().mockReturnValue(0),
    } as unknown as CheckpointStack;
    const loop = makeLoop(makePool(), config, post, new ToolRegistry(), driver, checkpoints);

    await loop.runTurn(conv, config.models[0]!, 'do not record this');

    expect(run).not.toHaveBeenCalled();
    expect(conv.messages).toEqual([]);
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'checkpoint limit exceeded' }),
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

  it('announces backend start/ready only on the first CLI turn, not on resumes', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'completed' as const,
        finalText: 'First answer',
        sessionId: 'warm-session',
      })
      .mockResolvedValueOnce({ status: 'completed' as const, finalText: 'Second answer' });
    const config = makeConfig({ provider: 'cli', cli: process.execPath, cli_model: 'opus' });
    const conv = makeConversation();
    const post = vi.fn();
    const loop = makeLoop(
      makePool(vi.fn(async () => makeBackend())),
      config,
      post,
      new ToolRegistry(),
      { run } as unknown as CliAgentDriver,
    );

    const countType = (type: string): number =>
      post.mock.calls.filter(([m]) => (m as { type?: string }).type === type).length;
    const countRollbackWarnings = (): number =>
      post.mock.calls.filter(([m]) =>
        /rollback protection is disabled/i.test((m as { detail?: string }).detail ?? ''),
      ).length;

    await loop.runTurn(conv, config.models[0]!, 'first prompt');
    const startsAfterFirst = countType('backendStarting');
    const readysAfterFirst = countType('ready');
    const warningsAfterFirst = countRollbackWarnings();

    await loop.runTurn(conv, config.models[0]!, 'second prompt');

    expect(startsAfterFirst).toBe(1);
    expect(readysAfterFirst).toBe(1);
    expect(warningsAfterFirst).toBe(1);
    // Resumed turn adds no further start/ready/rollback chatter.
    expect(countType('backendStarting')).toBe(1);
    expect(countType('ready')).toBe(1);
    expect(countRollbackWarnings()).toBe(1);
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

  it('reports context growth once per tool round instead of only at the end of the turn', async () => {
    // The ctx bar and the HalluMeter bridge used to sit frozen for the whole
    // turn: a run that pulled tens of thousands of tokens through several tool
    // rounds showed the pre-turn number until it finished. The tick now rides
    // the server's usage frame, because that is the only thing the bar shows.
    let round = 0;
    streamModelChatCompletion.mockImplementation(
      (
        _baseUrl: string,
        _request: unknown,
        _model: ModelConfig,
        handlers: {
          onToken: (token: string) => void;
          onDone: (reason: string | null) => void;
          onToolCalls: (calls: unknown[] | null) => void;
          onUsage?: (usage: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
          }) => void;
        },
      ) => {
        round++;
        handlers.onUsage?.({
          prompt_tokens: 1000 * round,
          completion_tokens: 10,
          total_tokens: 1000 * round + 10,
        });
        if (round <= 2) {
          handlers.onToolCalls([
            {
              id: `call-${round}`,
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          ]);
          handlers.onDone('tool_calls');
        } else {
          handlers.onToken('done');
          handlers.onToolCalls(null);
          handlers.onDone('stop');
        }
      },
    );

    const registry = new ToolRegistry();
    registry.register({
      definition: {
        type: 'function',
        function: { name: 'read_file', description: 'read', parameters: { type: 'object' } },
      },
      permission: 'read',
      handler: vi.fn().mockResolvedValue('file contents'),
    });

    const conv = makeConversation();
    const config = makeConfig();
    const loop = makeLoop(makePool(), config, vi.fn(), registry);
    const ticks: string[] = [];
    loop.setContextChangedListener((convId) => ticks.push(convId));

    await loop.runTurn(conv, config.models[0]!, 'read two files');

    // One tick per usage frame (three rounds) plus the end-of-turn publish,
    // all scoped to this conversation.
    expect(ticks).toEqual(['conv-1', 'conv-1', 'conv-1', 'conv-1']);
    // The conversation carries the last request's counters, which is what every
    // context display reads.
    expect(conv.last_input_tokens).toBe(3000);
    expect(conv.last_output_tokens).toBe(10);
    expect(conv.model_request_count).toBe(3);
  });
});
