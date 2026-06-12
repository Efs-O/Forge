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

function makeLoop(pool: IBackendPool, config: ForgeConfig): AgentLoop {
  const checkpoints = {
    beginTurn: vi.fn(),
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
    new ToolRegistry(),
    checkpoints,
    codeLens,
    diffDecorations,
    failureTracker,
    events,
    vi.fn(),
    () => undefined,
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
});
