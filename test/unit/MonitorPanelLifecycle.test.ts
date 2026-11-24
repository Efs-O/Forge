import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  panel: undefined as Record<string, unknown> | undefined,
  onState: undefined as ((event: { webviewPanel: { visible: boolean } }) => void) | undefined,
  onMessage: undefined as ((value: unknown) => void) | undefined,
  onDispose: undefined as (() => void) | undefined,
}));
vi.mock('vscode', () => ({
  ViewColumn: { Active: 1 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
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
import type { MetricsDocument } from '../../src/monitor/monitorTypes';

/** What the vendored Strata page needs from the host: its own top-level keys, whole. */
const METRICS = {
  engine: { model: 'strata-demo', max_context: 262144, spec: 7 },
  live: { state: 'generating', tok_s: 42.5, queued: 0 },
  requests: [{ time: 1795519920, finish: 'stop', output_tokens: 12 }],
  requests_kept: 1,
  conversation_cache: { enabled: false, requests: 0 },
  totals: { since: 1795519000, requests: 1, prompt_tokens: 10, reused: 2, output_tokens: 12 },
  hardware: { gpu_util: 37, gpu_mem_used: 12345678, gpu_temp: 51 },
  hardware_static: { os: 'windows', gpu_name: 'Test GPU', threads: 16 },
  history: { gpu_util: [10, 20, 37], tok_s: [40, 41, 42] },
  time: 1795519934,
  ups: { 'ups.status': 'OL' },
};

function setup(loaded = true) {
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
  const config = {
    models: [
      {
        name: 'strata-demo',
        provider: 'openai-compatible',
        endpoint: 'http://127.0.0.1:8091/v1',
        stats: 'strata',
      },
    ],
    active_model: 'strata-demo',
    engines: [],
    groups: [],
  } as unknown as ForgeConfig;
  const options = {
    extensionUri: context.extensionUri,
    pool: { isLoaded: () => loaded, modelBaseUrl: () => null },
    getConfig: () => config,
    getStats: () => ({ today: { turns: 7 } }) as never,
    getSecret: async () => undefined,
  };
  return { context, options, panel, signals, subscriptions };
}

/** A fetch that answers the panel's `/metrics` read, recording the signals it is given. */
function stubMetricsFetch(signals: AbortSignal[], body: unknown = METRICS) {
  const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
    if (init?.signal) signals.push(init.signal);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;
  vi.stubGlobal('fetch', fetchImpl);
  return fetchImpl;
}

afterEach(() => {
  MonitorPanel.current?.dispose();
  state.panel = undefined;
  state.onMessage = undefined;
  state.onState = undefined;
  state.onDispose = undefined;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MonitorPanel lifecycle', () => {
  it('uses one panel instance and hiding clears timers and aborts the read in flight', async () => {
    vi.useFakeTimers();
    const { context, options, signals } = setup();
    stubMetricsFetch(signals);
    const opened = MonitorPanel.createOrShow(context, options);
    expect(MonitorPanel.createOrShow(context, options)).toBe(opened);
    expect(panelRevealCalls()).toBe(1);
    state.onState?.({ webviewPanel: { visible: true } });
    await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
    const inFlight = signals[0];
    state.onState?.({ webviewPanel: { visible: false } });
    expect(inFlight.aborted).toBe(true);
    state.onState?.({ webviewPanel: { visible: true } });
    state.onState?.({ webviewPanel: { visible: false } });
    const diagnostics = diagnosticsOf(opened);
    expect(diagnostics.timers).toBe(0);
    expect(diagnostics.controllers).toHaveLength(0);
    vi.useRealTimers();
  });

  it('disposal clears timers and aborts the read in flight', async () => {
    const { context, options, signals } = setup();
    // A read that never answers: its controller is still live when the panel goes away.
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    const opened = MonitorPanel.createOrShow(context, options);
    state.onState?.({ webviewPanel: { visible: true } });
    await vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
    opened.dispose();
    expect(signals[0].aborted).toBe(true);
    const diagnostics = diagnosticsOf(opened);
    expect(diagnostics.timers).toBe(0);
    expect(diagnostics.controllers).toHaveLength(0);
    expect(MonitorPanel.current).toBeUndefined();
  });

  it('posts the whole /metrics document, every key the page reads', async () => {
    const { context, options, signals } = setup();
    stubMetricsFetch(signals);
    MonitorPanel.createOrShow(context, options);
    state.onState?.({ webviewPanel: { visible: true } });
    await vi.waitFor(() => expect(postedMessages(state.panel).length).toBeGreaterThan(0));
    const messages = postedMessages(state.panel);
    const metrics = messages
      .map((message) => message.metrics)
      .find((value) => value !== undefined);
    expect(metrics).toEqual({ ...METRICS, forge: { today: { turns: 7 } } });
    expect(messages.every((message) => message.type === 'monitorMetrics')).toBe(true);
  });

  it("keeps the engine's own forge block when it sends one", async () => {
    const { context, options, signals } = setup();
    stubMetricsFetch(signals, { ...METRICS, forge: { today: { turns: 3 }, stale: false } });
    MonitorPanel.createOrShow(context, options);
    state.onState?.({ webviewPanel: { visible: true } });
    await vi.waitFor(() =>
      expect(
        postedMessages(state.panel)
          .map((message) => message.metrics)
          .some((metrics) => (metrics?.forge as { stale?: boolean } | undefined)?.stale === false),
      ).toBe(true),
    );
    const metrics = postedMessages(state.panel)
      .map((message) => message.metrics)
      .find((value) => (value?.forge as { stale?: boolean } | undefined)?.stale === false);
    expect(metrics?.forge).toEqual({ today: { turns: 3 }, stale: false });
  });

  it('says so in the panel when the engine answers badly', async () => {
    const { context, options, signals } = setup();
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 401 }),
    ) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchImpl);
    MonitorPanel.createOrShow(context, options);
    state.onState?.({ webviewPanel: { visible: true } });
    await vi.waitFor(() =>
      expect(postedMessages(state.panel).at(-1)).toEqual({
        type: 'monitorMetrics',
        metrics: { error: '/metrics answered HTTP 401' },
      }),
    );
  });
});

function panelRevealCalls(): number {
  const panel = state.panel as { reveal: { mock: { calls: unknown[] } } };
  return panel.reveal.mock.calls.length;
}

function postedMessages(
  panel: Record<string, unknown> | undefined,
): Array<{ type: string; metrics: MetricsDocument }> {
  const webview = panel?.webview as {
    postMessage: { mock: { calls: [unknown] } };
  };
  return webview.postMessage.mock.calls
    .map(([value]) => value as { type: string; metrics: MetricsDocument })
    .filter((value) => value !== undefined);
}

function diagnosticsOf(panel: unknown): { timers: number; controllers: AbortController[] } {
  return (
    panel as unknown as {
      pollers: { diagnostics(): { timers: number; controllers: AbortController[] } };
    }
  ).pollers.diagnostics();
}
