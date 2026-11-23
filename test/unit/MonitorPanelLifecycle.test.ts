import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  panel: undefined as Record<string, unknown> | undefined,
  onState: undefined as ((event: { webviewPanel: { visible: boolean } }) => void) | undefined,
  onMessage: undefined as ((value: unknown) => void) | undefined,
  onDispose: undefined as (() => void) | undefined,
}));
vi.mock('vscode', () => ({
  ViewColumn: { Active: 1 },
  Uri: {
    joinPath: (_base: unknown, ...parts: string[]) => ({
      fsPath: parts.join('/'),
      toString: () => parts.join('/'),
    }),
  },
  window: { createWebviewPanel: vi.fn(() => state.panel) },
}));

import * as vscode from 'vscode';
import { MonitorPanel } from '../../src/monitor/MonitorPanel';
import type { ForgeConfig } from '../../src/config/types';
import { ExecCommandError } from '../../src/util/processSpawn';

function setup() {
  const signals: AbortSignal[] = [];
  const webview = {
    html: '',
    cspSource: 'vscode-webview:',
    asWebviewUri: (uri: { toString(): string }) => uri,
    postMessage: vi.fn(async () => true),
    onDidReceiveMessage: (handler: (value: unknown) => void) => {
      state.onMessage = handler;
      return { dispose() {} };
    },
  };
  const panel = {
    webview,
    visible: true,
    reveal: vi.fn(),
    dispose: vi.fn(() => state.onDispose?.()),
    onDidDispose: (handler: () => void) => {
      state.onDispose = handler;
      return { dispose() {} };
    },
    onDidChangeViewState: (handler: (event: { webviewPanel: { visible: boolean } }) => void) => {
      state.onState = handler;
      return { dispose() {} };
    },
  };
  state.panel = panel;
  const subscriptions: Array<{ dispose(): void }> = [];
  const context = {
    extensionUri: { fsPath: 'extension', toString: () => 'extension' },
    subscriptions,
  } as unknown as vscode.ExtensionContext;
  const options = {
    extensionUri: context.extensionUri,
    pool: { isLoaded: () => false, modelBaseUrl: () => null },
    getConfig: () => ({ models: [], monitor: undefined }) as unknown as ForgeConfig,
    getStats: () => ({ today: { turns: 0 } }) as never,
    getSecret: async () => undefined,
    probeGpus: (signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>(() => undefined);
    },
  };
  return { context, options, panel, signals, subscriptions };
}

afterEach(() => {
  MonitorPanel.current?.dispose();
  state.panel = undefined;
  state.onMessage = undefined;
  state.onState = undefined;
  state.onDispose = undefined;
  vi.clearAllMocks();
});

describe('MonitorPanel lifecycle', () => {
  it('uses one panel instance and hiding clears timers and aborts in-flight probes', () => {
    vi.useFakeTimers();
    const { context, options, panel, signals } = setup();
    const opened = MonitorPanel.createOrShow(context, options);
    expect(MonitorPanel.createOrShow(context, options)).toBe(opened);
    expect(panel.reveal).toHaveBeenCalledOnce();
    state.onState?.({ webviewPanel: { visible: true } });
    expect(signals).toHaveLength(1);
    state.onState?.({ webviewPanel: { visible: false } });
    expect(signals[0].aborted).toBe(true);
    state.onState?.({ webviewPanel: { visible: true } });
    expect(signals).toHaveLength(1);
    state.onState?.({ webviewPanel: { visible: false } });
    const diagnostics = (
      opened as unknown as {
        pollers: { diagnostics(): { timers: number; controllers: AbortController[] } };
      }
    ).pollers.diagnostics();
    expect(diagnostics.timers).toBe(0);
    expect(diagnostics.controllers).toHaveLength(0);
    vi.useRealTimers();
  });

  it('disposal clears timers and aborts in-flight probes', () => {
    vi.useFakeTimers();
    const { context, options, signals } = setup();
    const opened = MonitorPanel.createOrShow(context, options);
    state.onState?.({ webviewPanel: { visible: true } });
    opened.dispose();
    expect(signals[0].aborted).toBe(true);
    const diagnostics = (
      opened as unknown as {
        pollers: { diagnostics(): { timers: number; controllers: AbortController[] } };
      }
    ).pollers.diagnostics();
    expect(diagnostics.timers).toBe(0);
    expect(diagnostics.controllers).toHaveLength(0);
    expect(MonitorPanel.current).toBeUndefined();
    vi.useRealTimers();
  });

  it('passes every GPU row from the probe through the snapshot', async () => {
    const { context, options, panel } = setup();
    const gpus = [
      {
        index: 0,
        name: 'GPU 0',
        memoryUsedMb: 100,
        memoryTotalMb: 8000,
        utilizationPercent: 25,
        temperatureC: 40,
      },
    ];
    const configured = { ...options, probeGpus: async () => gpus };
    const opened = MonitorPanel.createOrShow(context, configured);
    state.onState?.({ webviewPanel: { visible: true } });
    await vi.waitFor(() =>
      expect(
        panel.webview.postMessage.mock.calls.some(([value]) => {
          const message = value as { snapshot?: { gpus?: { gpus?: unknown[] } } };
          return message.snapshot?.gpus?.gpus?.length === 1;
        }),
      ).toBe(true),
    );
    const snapshot = panel.webview.postMessage.mock.calls
      .map(([value]) => (value as { snapshot?: { gpus?: { gpus?: unknown[] } } }).snapshot)
      .find((value) => value?.gpus?.gpus?.length === 1);
    expect(snapshot?.gpus?.gpus).toEqual(gpus);
    opened.dispose();
  });

  it('shows the exact missing nvidia-smi message from the probe', async () => {
    const { context, options, panel } = setup();
    const configured = {
      ...options,
      probeGpus: async () => {
        throw new ExecCommandError('missing_executable', 'nvidia-smi', 'not found');
      },
    };
    MonitorPanel.createOrShow(context, configured);
    state.onState?.({ webviewPanel: { visible: true } });
    await vi.waitFor(() => expect(panel.webview.postMessage).toHaveBeenCalled());
    const message = panel.webview.postMessage.mock.calls[0][0] as {
      snapshot: { gpus: { error?: string } };
    };
    expect(message.snapshot.gpus.error).toBe('nvidia-smi is not on PATH');
  });
});
