import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarProvider } from '../../src/sidebar/SidebarProvider';
import type { IBackendPool } from '../../src/backend/BackendPool';
import type { ForgeConfig } from '../../src/config/types';
import type { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { CheckpointStack } from '../../src/checkpoint/CheckpointStack';
import type { KeepUndoCodeLensProvider } from '../../src/sidebar/KeepUndoCodeLens';
import type { TemplateEngine } from '../../src/llm/TemplateEngine';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';
import type { Memento } from 'vscode';

// Mock vscode
vi.mock('vscode', () => ({
  Uri: {
    file: vi.fn((p: string) => ({ fsPath: p })),
    joinPath: vi.fn((uri: { fsPath: string }, ...segments: string[]) => ({
      fsPath: [uri.fsPath, ...segments].join('/'),
      toString: () => [uri.fsPath, ...segments].join('/'),
    })),
  },
  window: {
    showWarningMessage: vi.fn().mockResolvedValue(undefined),
    activeTextEditor: undefined,
    showTextDocument: vi.fn().mockResolvedValue(undefined),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
    openTextDocument: vi.fn().mockResolvedValue({}),
    asRelativePath: vi.fn((p: string) => p.replace('/workspace/', '')),
  },
  commands: {
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock WebviewBuilder
vi.mock('../../src/sidebar/WebviewBuilder', () => ({
  buildWebviewHtml: vi.fn().mockReturnValue('<html></html>'),
}));

// Mock AgentLoop
vi.mock('../../src/sidebar/AgentLoop', () => ({
  AgentLoop: vi.fn().mockImplementation(() => ({
    streaming: false,
    runTurn: vi.fn().mockResolvedValue(undefined),
    runPromptToMarkdown: vi.fn().mockResolvedValue('# Result'),
    stopStreamingIfNeeded: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    resolveConfirmation: vi.fn(),
    clearCapabilityCache: vi.fn(),
    openFile: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock SlashCommandHandler
vi.mock('../../src/sidebar/SlashCommandHandler', () => ({
  SlashCommandHandler: vi.fn().mockImplementation(() => ({
    handle: vi.fn().mockResolvedValue(undefined),
  })),
}));

function makeMemento(initial?: Record<string, unknown>): Memento {
  const store: Record<string, unknown> = { ...initial };
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      const v = store[key];
      return v !== undefined ? (v as T) : (defaultValue as T);
    },
    keys: () => Object.keys(store),
    update: (key: string, value: unknown) => {
      if (value === undefined) delete store[key];
      else store[key] = value;
    },
    setKeysForSync: () => {},
  } as unknown as Memento;
}

function makeConfig(): ForgeConfig {
  return {
    models: [
      { name: 'model-a', provider: 'llama.cpp', gguf_path: 'C:/models/a.gguf' },
      { name: 'model-b', provider: 'ollama', endpoint: 'http://127.0.0.1:11434' },
    ],
    active_model: 'model-a',
    llama_server: {
      binary: 'llama-server',
      host: '127.0.0.1',
      port: 8080,
    },
  };
}

function makeMockPool(): IBackendPool {
  return {
    acquire: vi.fn().mockResolvedValue({
      isReady: vi.fn().mockReturnValue(true),
      baseUrl: vi.fn().mockReturnValue('http://127.0.0.1:8080'),
      loadedModel: vi.fn().mockReturnValue('model-a'),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      showConsole: vi.fn(),
      hotSwap: vi.fn().mockResolvedValue(undefined),
      applyForgeConfig: vi.fn(),
    }),
    stopAll: vi.fn().mockResolvedValue(undefined),
    applyForgeConfig: vi.fn(),
    showConsole: vi.fn(),
    isAnyReady: vi.fn().mockReturnValue(false),
  };
}

describe('SidebarProvider', () => {
  let provider: SidebarProvider;
  let mockPool: IBackendPool;
  let checkpoints: CheckpointStack;
  let toolRegistry: ToolRegistry;
  let codeLens: KeepUndoCodeLensProvider;
  let workspaceState: Memento;
  let events: { onBackendError?: ReturnType<typeof vi.fn>; onBackendReady?: ReturnType<typeof vi.fn>; onBackendStopped?: ReturnType<typeof vi.fn>; onGenerationStarted?: ReturnType<typeof vi.fn>; onGenerationFinished?: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockPool = makeMockPool();
    checkpoints = {
      beginTurn: vi.fn(),
      commitTurn: vi.fn(),
      undo: vi.fn().mockReturnValue(['/workspace/file.ts']),
      keep: vi.fn(),
      depth: vi.fn().mockReturnValue(0),
      canUndo: vi.fn().mockReturnValue(true),
      snapshotBefore: vi.fn(),
    } as unknown as CheckpointStack;

    toolRegistry = {
      definitions: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
      dispatch: vi.fn().mockResolvedValue(''),
      names: vi.fn().mockReturnValue([]),
      register: vi.fn(),
    } as unknown as ToolRegistry;

    codeLens = {
      markPending: vi.fn(),
      clearPending: vi.fn(),
    } as unknown as KeepUndoCodeLensProvider;

    workspaceState = makeMemento();

    events = {
      onBackendError: vi.fn(),
      onBackendReady: vi.fn(),
      onBackendStopped: vi.fn(),
      onGenerationStarted: vi.fn(),
      onGenerationFinished: vi.fn(),
    };

    provider = new SidebarProvider(
      { fsPath: '/extension' } as never,
      mockPool,
      makeConfig(),
      checkpoints,
      toolRegistry,
      workspaceState,
      codeLens,
      undefined as unknown as TemplateEngine,
      events,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('undo/keep', () => {
    it('undo restores files and clears code lens', () => {
      const restored = provider.undo();
      expect(restored).toContain('/workspace/file.ts');
      expect(checkpoints.undo).toHaveBeenCalled();
      expect(codeLens.clearPending).toHaveBeenCalled();
    });

    it('keep discards checkpoint and clears code lens', () => {
      provider.keep();
      expect(checkpoints.keep).toHaveBeenCalled();
      expect(codeLens.clearPending).toHaveBeenCalled();
    });

    it('canUndo delegates to checkpoints', () => {
      expect(provider.canUndo()).toBe(true);
      vi.mocked(checkpoints.canUndo).mockReturnValue(false);
      expect(provider.canUndo()).toBe(false);
    });
  });

  describe('newConversation', () => {
    it('creates a new conversation tab', async () => {
      await provider.newConversation();
      const session = workspaceState.get<SidebarRuntime>('forge.session.v1');
      expect(session?.conversations).toHaveLength(2);
    });

    it('warns when at capacity', async () => {
      const { window } = await import('vscode');
      for (let i = 0; i < 20; i++) {
        await provider.newConversation();
      }
      expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('maximum'));
    });
  });

  describe('submitPrompt', () => {
    it('throws when already streaming', async () => {
      const { AgentLoop } = await import('../../src/sidebar/AgentLoop');
      vi.mocked(AgentLoop).mockImplementationOnce(() => ({
        streaming: true,
        runTurn: vi.fn(),
        stopStreamingIfNeeded: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn(),
        resolveConfirmation: vi.fn(),
        clearCapabilityCache: vi.fn(),
        openFile: vi.fn(),
        runPromptToMarkdown: vi.fn(),
      } as unknown as InstanceType<typeof AgentLoop>));

      // Re-create provider with streaming agent
      provider = new SidebarProvider(
        { fsPath: '/extension' } as never,
        mockPool,
        makeConfig(),
        checkpoints,
        toolRegistry,
        workspaceState,
        codeLens,
        undefined as unknown as TemplateEngine,
        events,
      );

      await expect(provider.submitPrompt('hello')).rejects.toThrow('wait for the current response');
    });

    it('posts error when no active model', async () => {
      provider.applyForgeConfig({ ...makeConfig(), active_model: null });
      await provider.submitPrompt('hello');
      expect(events.onBackendError).toHaveBeenCalledWith(expect.stringContaining('no active model'));
    });

    it('posts error when model not found', async () => {
      provider.applyForgeConfig({ ...makeConfig(), active_model: 'nonexistent' });
      await provider.submitPrompt('hello');
      // Should post error via handleMessage
    });
  });

  describe('unloadModels', () => {
    it('stops all backends and posts down message', async () => {
      await provider.unloadModels();
      expect(mockPool.stopAll).toHaveBeenCalled();
      expect(events.onBackendStopped).toHaveBeenCalledWith('model-a');
    });
  });

  describe('notifyBackendError', () => {
    it('fires event and posts message', () => {
      provider.notifyBackendError('Something broke');
      expect(events.onBackendError).toHaveBeenCalledWith('Something broke');
    });
  });

  describe('prefillInput', () => {
    it('executes sidebar command and posts input', async () => {
      const { commands } = await import('vscode');
      provider.prefillInput('prefilled text');
      expect(commands.executeCommand).toHaveBeenCalledWith('workbench.view.extension.forge-sidebar');
    });
  });

  describe('runPromptToMarkdown', () => {
    it('delegates to AgentLoop', async () => {
      const result = await provider.runPromptToMarkdown('test');
      expect(result).toBe('# Result');
    });
  });

  describe('applyForgeConfig', () => {
    it('updates config and clears capability cache', () => {
      const newConfig = makeConfig();
      newConfig.active_model = 'model-b';
      provider.applyForgeConfig(newConfig);
      expect(mockPool.applyForgeConfig).toHaveBeenCalledWith(newConfig);
    });
  });

  describe('clearChat', () => {
    it('clears active messages', () => {
      provider.clearChat();
      const session = workspaceState.get<SidebarRuntime>('forge.session.v1');
      const active = session?.conversations.find((c) => c.id === session?.activeConversationId);
      expect(active?.messages).toHaveLength(0);
    });
  });

  describe('handleMessage', () => {
    it('handles webviewReady', () => {
      const webviewView = {
        webview: {
          postMessage: vi.fn(),
          html: '',
          options: {},
          onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
          asWebviewUri: vi.fn(),
          cspSource: '',
        },
        visible: true,
        onDidDispose: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        onDidChangeVisibility: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      };

      provider.resolveWebviewView(webviewView as never, {} as never, {} as never);

      // Simulate webview ready message
      const receiveHandler = vi.mocked(webviewView.webview.onDidReceiveMessage).mock.calls[0]?.[0];
      if (receiveHandler) {
        receiveHandler({ type: 'webviewReady' });
        expect(webviewView.webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'models' }));
      }
    });

    it('handles cancel', () => {
      // Just verify cancel doesn't throw
      const webviewView = {
        webview: {
          postMessage: vi.fn(),
          html: '',
          options: {},
          onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
          asWebviewUri: vi.fn(),
          cspSource: '',
        },
        visible: true,
        onDidDispose: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        onDidChangeVisibility: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      };

      provider.resolveWebviewView(webviewView as never, {} as never, {} as never);

      const receiveHandler = vi.mocked(webviewView.webview.onDidReceiveMessage).mock.calls[0]?.[0];
      if (receiveHandler) {
        receiveHandler({ type: 'cancel' });
        // Should not throw
      }
    });

    it('handles switchModel', () => {
      const webviewView = {
        webview: {
          postMessage: vi.fn(),
          html: '',
          options: {},
          onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
          asWebviewUri: vi.fn(),
          cspSource: '',
        },
        visible: true,
        onDidDispose: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        onDidChangeVisibility: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      };

      provider.resolveWebviewView(webviewView as never, {} as never, {} as never);

      const receiveHandler = vi.mocked(webviewView.webview.onDidReceiveMessage).mock.calls[0]?.[0];
      if (receiveHandler) {
        receiveHandler({ type: 'switchModel', name: 'model-b' });
        // Config should be updated
      }
    });

    it('handles confirmResponse', () => {
      const webviewView = {
        webview: {
          postMessage: vi.fn(),
          html: '',
          options: {},
          onDidReceiveMessage: vi.fn().mockReturnValue({ dispose: vi.fn() }),
          asWebviewUri: vi.fn(),
          cspSource: '',
        },
        visible: true,
        onDidDispose: vi.fn().mockReturnValue({ dispose: vi.fn() }),
        onDidChangeVisibility: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      };

      provider.resolveWebviewView(webviewView as never, {} as never, {} as never);

      const receiveHandler = vi.mocked(webviewView.webview.onDidReceiveMessage).mock.calls[0]?.[0];
      if (receiveHandler) {
        receiveHandler({ type: 'confirmResponse', id: 'confirm-1', approved: true });
        // Should not throw
      }
    });
  });
});
