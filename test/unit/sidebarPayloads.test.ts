import { describe, expect, it } from 'vitest';
import {
  buildModelsMessage,
  buildSessionMetrics,
  buildSessionSyncMessage,
} from '../../src/sidebar/sidebarPayloads';
import type { ForgeConfig } from '../../src/config/types';
import type { ModelEntry } from '../../src/sidebar/messageBridge';
import type { ConversationRuntime, SidebarRuntime } from '../../src/sidebar/sessionTypes';
import type { ArchivedSessionMeta } from '../../src/sidebar/ArchivedSessions';

const conv = (over: Partial<ConversationRuntime> = {}): ConversationRuntime =>
  ({ id: 'c1', messages: [], ...over }) as ConversationRuntime;

describe('buildModelsMessage', () => {
  it('defaults an unset provider to llama.cpp and carries the active selection', () => {
    const msg = buildModelsMessage({
      active_model: 'b',
      models: [{ name: 'a' }, { name: 'b', provider: 'ollama' }],
    } as ForgeConfig);

    expect(msg).toMatchObject({ type: 'models', active: 'b' });
    const models = (msg as { models: Array<{ name: string; provider: string }> }).models;
    expect(models.map((m) => [m.name, m.provider])).toEqual([
      ['a', 'llama.cpp'],
      ['b', 'ollama'],
    ]);
  });

  it('uses an active conversation pin instead of the config default when supplied', () => {
    const msg = buildModelsMessage(
      {
        active_model: 'no-vision',
        models: [{ name: 'vision' }, { name: 'no-vision' }],
      } as ForgeConfig,
      undefined,
      'vision',
    );

    expect(msg).toMatchObject({ type: 'models', active: 'vision' });
  });

  it('exposes configured request profiles for each base model', () => {
    const msg = buildModelsMessage({
      active_model: 'a@audit',
      profiles: { audit: { think: true } },
      models: [{ name: 'a' }, { name: 'b', provider: 'ollama' }],
    } as ForgeConfig) as { models: ModelEntry[] };

    expect(msg.models.map((model) => model.profiles)).toEqual([['audit'], ['audit']]);
  });

  it('omits residency entirely when no pool is supplied', () => {
    const msg = buildModelsMessage({ active_model: 'a', models: [{ name: 'a' }] } as ForgeConfig);
    expect((msg as { models: ModelEntry[] }).models[0]).not.toHaveProperty('residency');
  });

  it('maps a local model through cold / loading / ready', () => {
    const config = { active_model: 'a', models: [{ name: 'a' }] } as ForgeConfig;
    const at = (loaded: boolean, ready: boolean): ModelEntry | undefined =>
      (
        buildModelsMessage(config, { isLoaded: () => loaded, isModelReady: () => ready }) as {
          models: ModelEntry[];
        }
      ).models[0];

    expect(at(false, false)?.residency).toBe('cold');
    expect(at(true, false)?.residency).toBe('loading');
    expect(at(true, true)?.residency).toBe('ready');
  });

  it('reports no residency for remote routes, Ollama cloud included', () => {
    // Ollama cloud reaches the daemon on localhost but holds no VRAM here, so a
    // "cold" dot would advertise a load cost that does not exist. Note the route
    // is decided by the `-cloud`/`:cloud` NAME suffix, not by the endpoint.
    const msg = buildModelsMessage(
      {
        active_model: 'gpt-oss:120b-cloud',
        models: [
          { name: 'gpt-oss:120b-cloud', provider: 'ollama' },
          { name: 'y', provider: 'xai' },
          { name: 'z', provider: 'openrouter' },
        ],
      } as ForgeConfig,
      { isLoaded: () => false, isModelReady: () => false },
    );

    for (const model of (msg as { models: ModelEntry[] }).models) {
      expect(model).not.toHaveProperty('residency');
    }
  });

  it('gives a managed external server (Strata) a dot: ready once used, cold otherwise', () => {
    // openai-compatible routes as cloud, but an unload_path means Forge loads
    // and unloads it; without this its dot stayed grey while it served.
    const config = {
      active_model: 's',
      models: [{ name: 's', provider: 'openai-compatible', unload_path: '/unload' }],
    } as ForgeConfig;
    const at = (ready: boolean): ModelEntry | undefined =>
      (
        buildModelsMessage(config, { isLoaded: () => true, isModelReady: () => ready }) as {
          models: ModelEntry[];
        }
      ).models[0];

    expect(at(true)?.residency).toBe('ready');
    expect(at(false)?.residency).toBe('cold');
  });

  it('still reports residency for a local Ollama model', () => {
    const msg = buildModelsMessage(
      {
        active_model: 'q',
        models: [{ name: 'q', provider: 'ollama', endpoint: 'http://localhost:11434' }],
      } as ForgeConfig,
      { isLoaded: () => true, isModelReady: () => true },
    );
    expect((msg as { models: ModelEntry[] }).models[0]?.residency).toBe('ready');
  });
});

describe('buildSessionMetrics', () => {
  it('omits counters the conversation has never recorded', () => {
    // The status bar distinguishes "zero" from "never ran", so absent stays absent.
    expect(buildSessionMetrics(conv(), 1200)).toEqual({ activeMs: 1200, contextTokens: 0 });
  });

  it('reports totals and last-request counters when present', () => {
    const snapshot = buildSessionMetrics(
      conv({ input_tokens: 90, output_tokens: 10, last_input_tokens: 40, model_request_count: 3 }),
      500,
    );
    expect(snapshot).toMatchObject({
      activeMs: 500,
      inputTokens: 90,
      outputTokens: 10,
      currentInputTokens: 40,
      requestCount: 3,
    });
    expect(snapshot).not.toHaveProperty('currentOutputTokens');
  });

  it('reports the compaction count from the compaction generation', () => {
    const snapshot = buildSessionMetrics(
      conv({ compaction: { summary: 's', fromIndex: 1, generation: 2 } }),
      500,
    );
    expect(snapshot).toMatchObject({ compactCount: 2 });
  });
});

describe('buildSessionSyncMessage transcript scope', () => {
  const withText = (id: string, text: string): ConversationRuntime =>
    ({
      id,
      title: id,
      createdAt: 0,
      updatedAt: 0,
      messages: [{ role: 'user', content: text }],
    }) as ConversationRuntime;

  const session = (): SidebarRuntime => ({
    activeConversationId: 'a',
    conversations: [withText('a', 'active'), withText('b', 'background'), withText('c', 'busy')],
    history: [withText('h', 'archived')],
  });

  it('ships only the active transcript, never the background tabs or history', () => {
    const msg = buildSessionSyncMessage(session(), new Set(), () => 0) as {
      messagesById: Record<string, unknown>;
      tabs: unknown[];
      history: unknown[];
    };

    expect(Object.keys(msg.messagesById)).toEqual(['a']);
    // The metadata for everything else still rides along - it is the megabytes
    // of transcript that were the problem, not the tab list.
    expect(msg.tabs).toHaveLength(3);
    expect(msg.history).toHaveLength(1);
  });

  it('also ships a streaming tab, which has tool rows to reconcile while hidden', () => {
    const msg = buildSessionSyncMessage(session(), new Set(['c']), () => 0) as {
      messagesById: Record<string, unknown>;
    };

    expect(Object.keys(msg.messagesById).sort()).toEqual(['a', 'c']);
  });

  it('always includes the active id, so the webview can never be shown a tab it has no rows for', () => {
    const s = session();
    s.activeConversationId = 'b';
    const msg = buildSessionSyncMessage(s, new Set(), () => 0) as {
      activeId: string;
      messagesById: Record<string, unknown>;
    };

    expect(msg.messagesById[msg.activeId]).toBeDefined();
  });
});

describe('buildSessionSyncMessage phone badge', () => {
  const conv = (id: string): ConversationRuntime =>
    ({ id, title: id, createdAt: 0, updatedAt: 0, messages: [] }) as ConversationRuntime;
  const phoneSession = (): SidebarRuntime => ({
    activeConversationId: 'a',
    conversations: [conv('a'), conv('b'), conv('c')],
    history: [conv('h')],
  });
  const archivedRow = (id: string): ArchivedSessionMeta => ({
    id,
    title: `archived ${id}`,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 3,
  });
  type Stamped = { id: string; origin_channel?: string };
  const syncWith = (
    originChannelOf?: (conversationId: string) => string | undefined,
  ): { tabs: Stamped[]; history: Stamped[]; archived: Stamped[] } =>
    buildSessionSyncMessage(
      phoneSession(),
      new Set<string>(),
      () => 0,
      undefined,
      new Set<string>(),
      [archivedRow('gone')],
      undefined,
      originChannelOf,
    ) as { tabs: Stamped[]; history: Stamped[]; archived: Stamped[] };

  it('stamps the phone channel on the open tab, the closed chat and the archived row alike', () => {
    const msg = syncWith((id) =>
      id === 'b' || id === 'h' || id === 'gone' ? 'telegram' : undefined,
    );
    expect(msg.tabs.map((row) => [row.id, row.origin_channel])).toEqual([
      ['a', undefined],
      ['b', 'telegram'],
      ['c', undefined],
    ]);
    expect(msg.history.map((row) => [row.id, row.origin_channel])).toEqual([['h', 'telegram']]);
    expect(msg.archived.map((row) => [row.id, row.origin_channel])).toEqual([['gone', 'telegram']]);
  });

  it('badges only the conversation the binding names, never its neighbours', () => {
    const msg = syncWith((id) => (id === 'h' ? 'whatsapp' : undefined));
    expect(msg.tabs.map((row) => row.origin_channel)).toEqual([undefined, undefined, undefined]);
    expect(msg.archived.map((row) => row.origin_channel)).toEqual([undefined]);
    expect(msg.history.map((row) => row.origin_channel)).toEqual(['whatsapp']);
  });

  it('drops a channel the panel cannot show, and badges nothing when no reader was given', () => {
    // `fake` is the test transport's channel. The host decides what may badge,
    // so an unknown value never reaches a row as a badge, and a panel with no
    // remote runtime to ask gets no phone badge at all.
    const odd = syncWith(() => 'fake');
    expect(odd.tabs.map((row) => 'origin_channel' in row)).toEqual([false, false, false]);
    expect(odd.archived.map((row) => 'origin_channel' in row)).toEqual([false]);
    expect(syncWith().tabs.map((row) => 'origin_channel' in row)).toEqual([false, false, false]);
  });
});

describe('buildSessionSyncMessage stored panel size', () => {
  const tinySession = (): SidebarRuntime => ({
    activeConversationId: 'a',
    conversations: [
      { id: 'a', title: 'a', createdAt: 0, updatedAt: 0, messages: [] } as ConversationRuntime,
    ],
    history: [],
  });

  it('carries the size the host read from globalState, and says nothing when there is none', () => {
    // This is the whole reload path: the panel size is not webview memory, it is
    // state the host keeps for every window and hands back with the sync the
    // panel already receives, so a second window or a reload opens the panel as
    // it was last sized without asking for it.
    const withSize = buildSessionSyncMessage(
      tinySession(),
      new Set<string>(),
      () => 0,
      undefined,
      new Set<string>(),
      [],
      { width: 340, height: 520 },
    ) as { historyPanelSize?: { width: number; height: number } };
    expect(withSize.historyPanelSize).toEqual({ width: 340, height: 520 });

    const without = buildSessionSyncMessage(tinySession(), new Set<string>(), () => 0) as {
      historyPanelSize?: unknown;
    };
    expect('historyPanelSize' in without).toBe(false);
  });
});
