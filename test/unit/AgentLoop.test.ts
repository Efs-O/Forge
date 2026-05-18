import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop, type SidebarProviderEvents } from '../../src/sidebar/AgentLoop';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { BackendController } from '../../src/backend/BackendController';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { ToolFailureTracker } from '../../src/tools/StripTools';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { AttachmentData } from '../../src/sidebar/messageBridge';
import type { TemplateEngine } from '../../src/llm/TemplateEngine';

// Mock vscode
vi.mock('vscode', () => ({
  window: {
    activeTextEditor: undefined,
    showWarningMessage: vi.fn(),
    showTextDocument: vi.fn().mockResolvedValue(undefined),
  },
  workspace: {
    openTextDocument: vi.fn().mockResolvedValue({}),
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
  },
  Uri: {
    file: vi.fn((p: string) => ({ fsPath: p })),
  },
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock ChatClient
vi.mock('../../src/llm/ChatClient', () => ({
  streamModelChatCompletion: vi.fn(),
}));

// Mock SystemPromptInjector
vi.mock('../../src/llm/SystemPromptInjector', () => ({
  injectSystemPrompt: vi.fn((messages) => messages),
}));

// Mock SamplingMerge
vi.mock('../../src/llm/SamplingMerge', () => ({
  mergeSampling: vi.fn((base) => base),
}));

// Mock RequestNormalizer
vi.mock('../../src/llm/RequestNormalizer', () => ({
  normalizeRequestForModel: vi.fn((req) => req),
}));

// Mock stripper utilities
vi.mock('../../src/llm/HtmlDocumentBoilerplateStripper', () => ({
  HtmlDocumentBoilerplateStripper: vi.fn().mockImplementation(() => ({
    push: vi.fn((t: string) => t),
    flush: vi.fn().mockReturnValue(''),
  })),
  stripHtmlDocumentBoilerplateFromFullText: vi.fn((t: string) => t),
}));

vi.mock('../../src/llm/ThinkingChannelStripper', () => ({
  ThinkingChannelStripper: vi.fn().mockImplementation(() => ({
    push: vi.fn((t: string) => t),
    flush: vi.fn().mockReturnValue(''),
  })),
  stripThinkingFromFullText: vi.fn((t: string) => t),
}));

vi.mock('../../src/tools/StructuredOutputParser', () => ({
  StructuredOutputStripper: vi.fn().mockImplementation(() => ({
    push: vi.fn((t: string) => t),
    flush: vi.fn().mockReturnValue(''),
  })),
  stripStructuredOutputFromFullText: vi.fn((t: string) => t),
}));

vi.mock('../../src/tools/ToolCallFallback', () => ({
  extractFallbackToolCalls: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/util/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../src/backend/ModelCapabilities', () => ({
  inspectRuntimeModelCapabilities: vi.fn().mockResolvedValue({
    source: 'heuristic',
    hasChatTemplate: true,
    likelySupportsTools: true,
    likelySupportsThinking: true,
  }),
}));

vi.mock('../../src/sidebar/ConversationOps', () => ({
  buildUserContent: vi.fn((text) => text),
}));

vi.mock('../../src/sidebar/ToolDispatch', () => ({
  ToolDispatch: vi.fn().mockImplementation(() => ({
    dispatch: vi.fn().mockResolvedValue(undefined),
    openFile: vi.fn().mockResolvedValue(undefined),
  })),
  resolveToolPath: vi.fn((p: string) => p),
}));

function makeMockBackend(): BackendController {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    showConsole: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    baseUrl: vi.fn().mockReturnValue('http://127.0.0.1:8080'),
    loadedModel: vi.fn().mockReturnValue('test-model'),
    hotSwap: vi.fn().mockResolvedValue(undefined),
    applyForgeConfig: vi.fn(),
  };
}

function makeConfig(): ForgeConfig {
  return {
    models: [
      {
        name: 'test-model',
        provider: 'llama.cpp',
        gguf_path: 'C:/models/test.gguf',
      },
    ],
    active_model: 'test-model',
    llama_server: {
      binary: 'llama-server',
      host: '127.0.0.1',
      port: 8080,
    },
  };
}

function makeModel(): ModelConfig {
  return {
    name: 'test-model',
    provider: 'llama.cpp',
    gguf_path: 'C:/models/test.gguf',
  };
}

describe('AgentLoop', () => {
  let agentLoop: AgentLoop;
  let mockPool: IBackendPool;
  let mockBackend: BackendController;
  let toolRegistry: ToolRegistry;
  let checkpoints: CheckpointStack;
  let codeLens: KeepUndoCodeLensProvider;
  let failureTracker: ToolFailureTracker;
  let events: SidebarProviderEvents;
  let post: ReturnType<typeof vi.fn>;
  let getView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockBackend = makeMockBackend();
    mockPool = {
      acquire: vi.fn().mockResolvedValue(mockBackend),
      stopAll: vi.fn().mockResolvedValue(undefined),
      applyForgeConfig: vi.fn(),
      showConsole: vi.fn(),
      isAnyReady: vi.fn().mockReturnValue(true),
    };

    toolRegistry = {
      definitions: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
      dispatch: vi.fn().mockResolvedValue(''),
      names: vi.fn().mockReturnValue([]),
      register: vi.fn(),
    } as unknown as ToolRegistry;

    checkpoints = {
      beginTurn: vi.fn(),
      commitTurn: vi.fn(),
      undo: vi.fn().mockReturnValue([]),
      keep: vi.fn(),
      depth: vi.fn().mockReturnValue(0),
      canUndo: vi.fn().mockReturnValue(false),
      snapshotBefore: vi.fn(),
    } as unknown as CheckpointStack;

    codeLens = {
      markPending: vi.fn(),
      clearPending: vi.fn(),
    } as unknown as KeepUndoCodeLensProvider;

    failureTracker = {
      record: vi.fn(),
      reset: vi.fn(),
      shouldStrip: vi.fn().mockReturnValue(false),
    } as unknown as ToolFailureTracker;

    events = {
      onGenerationStarted: vi.fn(),
      onGenerationFinished: vi.fn(),
      onBackendError: vi.fn(),
      onBackendReady: vi.fn(),
      onBackendStopped: vi.fn(),
    };

    post = vi.fn();
    getView = vi.fn().mockReturnValue({ visible: true });

    agentLoop = new AgentLoop(
      mockPool,
      () => makeConfig(),
      toolRegistry,
      checkpoints,
      codeLens,
      failureTracker,
      events,
      post,
      getView,
      undefined as unknown as TemplateEngine,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('runTurn', () => {
    it('acquires backend and posts ready message', async () => {
      const { streamModelChatCompletion } = await import('../../src/llm/ChatClient');
      vi.mocked(streamModelChatCompletion).mockImplementation((_baseUrl, _req, _model, callbacks) => {
        callbacks.onToken('Hello');
        callbacks.onDone('stop');
        return Promise.resolve();
      });

      const conv: ConversationRuntime = {
        id: 'conv-1',
        title: 'Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };

      await agentLoop.runTurn(conv, makeModel(), 'Hello');

      expect(mockPool.acquire).toHaveBeenCalledWith('test-model');
      expect(post).toHaveBeenCalledWith({ type: 'ready' });
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'token', text: 'Hello' }));
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', finishReason: 'stop' }));
    });

    it('sets conversation title on first user message', async () => {
      const { streamModelChatCompletion } = await import('../../src/llm/ChatClient');
      vi.mocked(streamModelChatCompletion).mockImplementation((_baseUrl, _req, _model, callbacks) => {
        callbacks.onToken('Hi');
        callbacks.onDone('stop');
        return Promise.resolve();
      });

      const conv: ConversationRuntime = {
        id: 'conv-1',
        title: 'Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };

      await agentLoop.runTurn(conv, makeModel(), 'First message here');
      expect(conv.title).toBe('First message here');
    });

    it('handles backend acquisition failure', async () => {
      mockPool.acquire = vi.fn().mockRejectedValue(new Error('Port in use'));

      const conv: ConversationRuntime = {
        id: 'conv-1',
        title: 'Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };

      await agentLoop.runTurn(conv, makeModel(), 'Hello');

      expect(events.onBackendError).toHaveBeenCalledWith('Backend failed to start: Port in use');
      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'backendDown' }));
    });

    it('respects cancellation during backend startup', async () => {
      mockPool.acquire = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return mockBackend;
      });

      const conv: ConversationRuntime = {
        id: 'conv-1',
        title: 'Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };

      const promise = agentLoop.runTurn(conv, makeModel(), 'Hello');
      agentLoop.cancel();
      await promise;

      expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', finishReason: 'cancelled' }));
    });

    it('commits checkpoint after streaming', async () => {
      const { streamModelChatCompletion } = await import('../../src/llm/ChatClient');
      vi.mocked(streamModelChatCompletion).mockImplementation((_baseUrl, _req, _model, callbacks) => {
        callbacks.onToken('Done');
        callbacks.onDone('stop');
        return Promise.resolve();
      });

      const conv: ConversationRuntime = {
        id: 'conv-1',
        title: 'Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };

      await agentLoop.runTurn(conv, makeModel(), 'Hello');

      expect(checkpoints.beginTurn).toHaveBeenCalled();
      expect(checkpoints.commitTurn).toHaveBeenCalled();
    });

    it('posts checkpointReady when depth increases', async () => {
      const { streamModelChatCompletion } = await import('../../src/llm/ChatClient');
      vi.mocked(streamModelChatCompletion).mockImplementation((_baseUrl, _req, _model, callbacks) => {
        callbacks.onToken('Done');
        callbacks.onDone('stop');
        return Promise.resolve();
      });

      // Simulate checkpoint depth increasing after commit
      let depth = 0;
      vi.mocked(checkpoints.depth).mockImplementation(() => depth);
      vi.mocked(checkpoints.commitTurn).mockImplementation(() => { depth = 1; });

      const conv: ConversationRuntime = {
        id: 'conv-1',
        title: 'Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };

      await agentLoop.runTurn(conv, makeModel(), 'Hello');

      expect(post).toHaveBeenCalledWith({ type: 'checkpointReady' });
    });
  });

  describe('runPromptToMarkdown', () => {
    it('returns sanitized markdown content', async () => {
      const { streamModelChatCompletion } = await import('../../src/llm/ChatClient');
      vi.mocked(streamModelChatCompletion).mockImplementation((_baseUrl, _req, _model, callbacks) => {
        callbacks.onToken('# Heading\n\nParagraph');
        callbacks.onDone('stop');
        return Promise.resolve();
      });

      const result = await agentLoop.runPromptToMarkdown('Summarize this');
      expect(result).toBe('# Heading\n\nParagraph');
      expect(events.onGenerationStarted).toHaveBeenCalledWith('test-model');
      expect(events.onGenerationFinished).toHaveBeenCalledWith('test-model');
    });

    it('throws when no active model', async () => {
      agentLoop = new AgentLoop(
        mockPool,
        () => ({ ...makeConfig(), active_model: null }),
        toolRegistry,
        checkpoints,
        codeLens,
        failureTracker,
        events,
        post,
        getView,
      );

      await expect(agentLoop.runPromptToMarkdown('test')).rejects.toThrow('no active model');
    });
  });

  describe('stopStreamingIfNeeded', () => {
    it('returns immediately when not streaming', async () => {
      await agentLoop.stopStreamingIfNeeded();
      // Should not throw
    });

    it('aborts streaming and waits for settlement', async () => {
      const { streamModelChatCompletion } = await import('../../src/llm/ChatClient');
      vi.mocked(streamModelChatCompletion).mockImplementation((_baseUrl, _req, _model, callbacks) => {
        return new Promise((resolve) => {
          // Simulate slow streaming
          setTimeout(() => {
            callbacks.onToken('token');
            callbacks.onDone('stop');
            resolve();
          }, 100);
        });
      });

      const conv: ConversationRuntime = {
        id: 'conv-1',
        title: 'Chat',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      };

      const promise = agentLoop.runTurn(conv, makeModel(), 'Hello');
      await new Promise((resolve) => setTimeout(resolve, 10)); // Let it start

      await agentLoop.stopStreamingIfNeeded();
      await promise;

      expect(mockBackend.stop).toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('aborts controller and stops backend', () => {
      agentLoop.cancel();
      expect(mockBackend.stop).toHaveBeenCalled();
    });
  });

  describe('resolveConfirmation', () => {
    it('resolves pending confirmation', async () => {
      const view = {
        visible: true,
        webview: { postMessage: vi.fn() },
      };
      getView.mockReturnValue(view);

      // Trigger a tool approval request
      const approvalPromise = (agentLoop as unknown as { requestToolApproval: (name: string, detail: string) => Promise<boolean> }).requestToolApproval('write_file', 'test');

      // Resolve it
      agentLoop.resolveConfirmation('confirm-test', true);

      const result = await approvalPromise;
      expect(result).toBe(true);
    });

    it('ignores unknown confirmation IDs', () => {
      // Should not throw
      agentLoop.resolveConfirmation('unknown-id', true);
    });
  });

  describe('clearCapabilityCache', () => {
    it('clears cached capabilities', () => {
      agentLoop.clearCapabilityCache();
      // Should not throw; subsequent runTurn will refetch
    });
  });

  describe('openFile', () => {
    it('delegates to ToolDispatch', async () => {
      await agentLoop.openFile('/workspace/file.ts');
      // ToolDispatch.openFile is mocked to resolve
    });
  });
});
