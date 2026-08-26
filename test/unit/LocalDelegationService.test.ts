import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { ForgeConfig, ModelConfig } from '../../src/config/types';
import type { ChatCompletionRequest } from '../../src/llm/types';
import type { StreamHandlers } from '../../src/llm/OpenAIClient';
import { resolveDelegationTarget } from '../../src/delegation/eligibility';
import { LocalDelegationService } from '../../src/delegation/LocalDelegationService';
import {
  MAX_DELEGATION_CONTEXT_BYTES,
  MAX_DELEGATION_CONTEXT_FILE_BYTES,
  MAX_DELEGATION_CONTEXT_FILES,
  MAX_DELEGATION_RESULT_CHARS,
  MAX_DELEGATION_TASK_CHARS,
} from '../../src/delegation/limits';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: path.resolve('/workspace') } }] },
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
}));

const root = path.resolve('/workspace');

function model(name: string, provider?: ModelConfig['provider'], endpoint?: string): ModelConfig {
  return {
    name,
    ...(provider ? { provider } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(provider === 'llama.cpp' || provider === undefined ? { gguf_path: `/${name}.gguf` } : {}),
  };
}

function config(): ForgeConfig {
  return {
    models: [
      model('llama', 'llama.cpp'),
      model('ollama-local', 'ollama', 'http://127.0.0.1:11434'),
      model('ollama-cloud', 'ollama', 'https://ollama.com'),
      // Cloud-routed via the LOCAL daemon: only the name's tag suffix marks it.
      model('gpt-oss:20b-cloud', 'ollama', 'http://127.0.0.1:11434'),
      model('xai-model', 'xai'),
      model('openai-model', 'openai'),
      model('openrouter-model', 'openrouter'),
      model('compat-model', 'openai-compatible', 'https://api.example.test'),
    ],
    active_model: 'llama',
    aliases: { worker: 'llama@reviewer' },
    profiles: { reviewer: { sampling: { temperature: 0.2 } } },
    llama_server: {},
  };
}

interface Harness {
  service: LocalDelegationService;
  release: ReturnType<typeof vi.fn>;
  statFile: ReturnType<typeof vi.fn>;
  streamChat: ReturnType<typeof vi.fn>;
  acquireResolve: (hold?: unknown) => void;
  acquireReject: (err: unknown) => void;
  capturedRequest: ChatCompletionRequest | undefined;
  streamReject: ((err: unknown) => void) | undefined;
  timeout: AbortController;
}

function makeHarness(
  opts: Partial<{
    acquireDeferred: boolean;
    streamNever: boolean;
    streamIgnoresAbort: boolean;
    streamText: string;
    realPath: (filePath: string) => Promise<string>;
  }> = {},
): Harness {
  const release = vi.fn();
  const timeout = new AbortController();
  let acquireResolve!: (hold?: unknown) => void;
  let acquireReject!: (err: unknown) => void;
  const hold = {
    backend: { baseUrl: () => 'http://127.0.0.1:8080' },
    targetKey: 'llama',
    bestEffort: false,
    release,
  };
  const acquirePromise = opts.acquireDeferred
    ? new Promise((resolve, reject) => {
        acquireResolve = resolve;
        acquireReject = reject;
      })
    : Promise.resolve(hold);
  if (!opts.acquireDeferred) {
    acquireResolve = () => {};
    acquireReject = () => {};
  }
  let capturedRequest: ChatCompletionRequest | undefined;
  let streamReject: ((err: unknown) => void) | undefined;
  const statFile = vi.fn().mockResolvedValue({ size: 3, isFile: true });
  const streamChat = vi.fn((_base, req, _model, handlers: StreamHandlers, signal) => {
    capturedRequest = req;
    return new Promise<void>((resolve, reject) => {
      streamReject = reject;
      if (!opts.streamIgnoresAbort) {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }
      if (!opts.streamNever) {
        handlers.onToken(opts.streamText ?? 'analysis');
        handlers.onDone('stop');
        resolve();
      }
    });
  });
  const service = new LocalDelegationService({
    getConfig: config,
    workspaceRoot: root,
    backendPool: {
      canDelegate: vi.fn().mockReturnValue({ safe: true }),
      acquireForDelegation: vi.fn().mockReturnValue(acquirePromise),
    },
    statFile,
    readFile: vi.fn().mockResolvedValue(new TextEncoder().encode('abc')),
    realPath: opts.realPath ?? ((filePath) => Promise.resolve(filePath)),
    makeTimeoutSignal: () => timeout.signal,
    streamChat,
  });
  return {
    service,
    release,
    statFile,
    streamChat,
    acquireResolve,
    acquireReject,
    get capturedRequest() {
      return capturedRequest;
    },
    get streamReject() {
      return streamReject;
    },
    timeout,
  };
}

describe('delegation eligibility', () => {
  it('accepts configured local llama.cpp and local Ollama targets', () => {
    expect(resolveDelegationTarget(config(), 'llama').provider).toBe('llama.cpp');
    expect(resolveDelegationTarget(config(), 'ollama-local').provider).toBe('ollama');
  });

  it.each([
    ['xai-model'],
    ['openai-model'],
    ['openrouter-model'],
    ['compat-model'],
  ])('classifies configured cloud provider %s as a cloud target', (target) => {
    expect(resolveDelegationTarget(config(), target).provider).toBe('cloud');
  });

  it('accepts an Ollama cloud-routed model (local daemon, no local slot cost)', () => {
    expect(resolveDelegationTarget(config(), 'gpt-oss:20b-cloud').provider).toBe('ollama');
  });

  it.each([
    ['ollama-cloud', 'non-local Ollama endpoint'],
    ['missing', 'Unknown delegation target'],
  ])('rejects %s distinctly', (target, expected) => {
    expect(() => resolveDelegationTarget(config(), target)).toThrow(expected);
  });

  it('resolves aliases and model profiles through ConfigResolver', () => {
    const target = resolveDelegationTarget(config(), 'worker');
    expect(target.resolvedId).toBe('llama@reviewer');
    expect(target.baseModel).toBe('llama');
    expect(target.model.sampling?.temperature).toBe(0.2);
  });

  it('resolves a fuzzy short_name to the correct baseModel and resolvedId (F7)', () => {
    const cfg = config();
    cfg.models = cfg.models.map((m) => (m.name === 'llama' ? { ...m, short_name: 'll' } : m));
    const target = resolveDelegationTarget(cfg, 'll');
    expect(target.baseModel).toBe('llama');
    expect(target.resolvedId).toBe('llama');
    expect(target.model.name).toBe('llama');
  });

  it('resolves a fuzzy short_name with @profile to the correct resolvedId (F7)', () => {
    const cfg = config();
    cfg.models = cfg.models.map((m) => (m.name === 'llama' ? { ...m, short_name: 'll' } : m));
    const target = resolveDelegationTarget(cfg, 'll@reviewer');
    expect(target.baseModel).toBe('llama');
    expect(target.resolvedId).toBe('llama@reviewer');
    expect(target.model.sampling?.temperature).toBe(0.2);
  });

  it('rejects an ambiguous fuzzy target with a structured candidate list', () => {
    const cfg = config();
    // Both "xai-model" and "xai-model-2" would prefix-match "xai".
    cfg.models = [...cfg.models, model('xai-model-2', 'xai')];
    expect(() => resolveDelegationTarget(cfg, 'xai')).toThrow(/Ambiguous model "xai"/);
  });
});

describe('LocalDelegationService limits and dispatch', () => {
  it('rejects too many context files', async () => {
    const h = makeHarness();
    await expect(
      h.service.ask({
        primaryModel: 'llama',
        targetModel: 'llama',
        task: 'check',
        contextFiles: Array.from({ length: MAX_DELEGATION_CONTEXT_FILES + 1 }, (_, i) => `${i}.ts`),
      }),
    ).rejects.toThrow('too many files');
  });

  it('rejects per-file and combined context limits', async () => {
    const tooLarge = makeHarness();
    tooLarge.statFile.mockResolvedValue({
      size: MAX_DELEGATION_CONTEXT_FILE_BYTES + 1,
      isFile: true,
    });
    await expect(
      tooLarge.service.ask({
        primaryModel: 'llama',
        targetModel: 'llama',
        task: 'check',
        contextFiles: ['big.ts'],
      }),
    ).rejects.toThrow('too large');

    const combined = makeHarness();
    combined.statFile.mockResolvedValue({
      size: Math.floor(MAX_DELEGATION_CONTEXT_BYTES / 4),
      isFile: true,
    });
    await expect(
      combined.service.ask({
        primaryModel: 'llama',
        targetModel: 'llama',
        task: 'check',
        contextFiles: ['a', 'b', 'c', 'd', 'e'],
      }),
    ).rejects.toThrow('context is too large');
  });

  it('rejects out-of-workspace context paths', async () => {
    const h = makeHarness();
    await expect(
      h.service.ask({
        primaryModel: 'llama',
        targetModel: 'llama',
        task: 'check',
        contextFiles: [path.resolve('/outside/file.ts')],
      }),
    ).rejects.toThrow('outside the workspace');
  });

  it('rejects context paths whose symlink target resolves outside the workspace', async () => {
    const h = makeHarness({
      realPath: (filePath) =>
        Promise.resolve(
          filePath === root ? filePath : path.resolve('/outside/secret.ts'),
        ),
    });
    await expect(
      h.service.ask({
        primaryModel: 'llama',
        targetModel: 'llama',
        task: 'check',
        contextFiles: ['linked.ts'],
      }),
    ).rejects.toThrow('resolves outside the workspace');
  });

  it('rejects overlong tasks', async () => {
    const h = makeHarness();
    await expect(
      h.service.ask({
        primaryModel: 'llama',
        targetModel: 'llama',
        task: 'x'.repeat(MAX_DELEGATION_TASK_CHARS + 1),
      }),
    ).rejects.toThrow('too long');
  });

  it('caps returned text through resultCap and sends no tools', async () => {
    const h = makeHarness({
      streamText: 'x'.repeat(MAX_DELEGATION_RESULT_CHARS + 100),
    });
    const result = await h.service.ask({
      primaryModel: 'llama',
      targetModel: 'llama',
      task: 'check',
      maxOutputTokens: 99999,
    });
    expect(result.text).toContain('[truncated by Forge MCP bridge');
    expect(h.capturedRequest?.tools).toBeUndefined();
    expect(h.capturedRequest?.max_tokens).toBe(4096);
  });

  it('releases holds on success and provider error', async () => {
    const success = makeHarness();
    await success.service.ask({ primaryModel: 'llama', targetModel: 'llama', task: 'check' });
    expect(success.release).toHaveBeenCalledTimes(1);

    const failure = makeHarness({ streamNever: true });
    const p = failure.service.ask({ primaryModel: 'llama', targetModel: 'llama', task: 'check' });
    // ask() reaches streamChat only after several awaits — wait for the call
    // before rejecting, or streamReject is still undefined and the test hangs.
    await vi.waitFor(() => expect(failure.streamChat).toHaveBeenCalled());
    failure.streamReject?.(new Error('provider down'));
    await expect(p).rejects.toThrow('provider');
    expect(failure.release).toHaveBeenCalledTimes(1);
  });

  it('aborts and releases on timeout and caller cancellation during streaming', async () => {
    const timed = makeHarness({ streamNever: true });
    const timeoutRun = timed.service.ask({
      primaryModel: 'llama',
      targetModel: 'llama',
      task: 'check',
    });
    timed.timeout.abort(new DOMException('deadline', 'TimeoutError'));
    await expect(timeoutRun).rejects.toThrow('timeout');
    expect(timed.release).toHaveBeenCalledTimes(1);

    const cancelled = makeHarness({ streamNever: true });
    const caller = new AbortController();
    const cancelRun = cancelled.service.ask({
      primaryModel: 'llama',
      targetModel: 'llama',
      task: 'check',
      signal: caller.signal,
    });
    caller.abort(new DOMException('stop', 'AbortError'));
    await expect(cancelRun).rejects.toThrow('cancelled');
    expect(cancelled.release).toHaveBeenCalledTimes(1);
  });

  it('unpins immediately when a cancelled provider stream has not settled', async () => {
    const h = makeHarness({ streamNever: true, streamIgnoresAbort: true });
    const caller = new AbortController();
    const run = h.service.ask({
      primaryModel: 'llama',
      targetModel: 'llama',
      task: 'check',
      signal: caller.signal,
    });
    await vi.waitFor(() => expect(h.streamChat).toHaveBeenCalled());

    caller.abort(new DOMException('stop', 'AbortError'));
    await vi.waitFor(() => expect(h.release).toHaveBeenCalledTimes(1));

    h.streamReject?.(caller.signal.reason);
    await expect(run).rejects.toThrow('cancelled');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('releases a late startup hold after caller cancellation', async () => {
    const h = makeHarness({ acquireDeferred: true });
    const caller = new AbortController();
    const run = h.service.ask({
      primaryModel: 'llama',
      targetModel: 'llama',
      task: 'check',
      signal: caller.signal,
    });
    caller.abort(new DOMException('stop', 'AbortError'));
    await expect(run).rejects.toThrow('cancelled');
    h.acquireResolve({
      backend: { baseUrl: () => 'http://127.0.0.1:8080' },
      targetKey: 'llama',
      bestEffort: false,
      release: h.release,
    });
    // Late release is scheduled through a detached then/catch chain; exact
    // microtask depth is an implementation detail, so poll instead of ticking.
    await vi.waitFor(() => expect(h.release).toHaveBeenCalledTimes(1));
  });
});
