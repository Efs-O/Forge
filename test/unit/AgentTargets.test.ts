import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentTargetCatalog,
  agentTargetCatalog,
  discoverAgentTargets,
} from '../../src/agentLinks/agentTargets';
import { makeAskAgentHandler, type AskAgentRuntime } from '../../src/agentLinks/askAgentService';
import { makeListAgentTargetsTool } from '../../src/tools/listAgentTargetsTool';
import { makeAskAgentTool } from '../../src/tools/askAgentTool';
import type { ForgeConfig } from '../../src/config/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { CheckpointSession } from '../../src/checkpoint/CheckpointStack';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';

const mocks = vi.hoisted(() => ({ discover: vi.fn(), claude: vi.fn() }));
vi.mock('../../src/agentMesh/codexDiscovery', () => ({
  CodexDiscovery: class {
    discoverTargets = mocks.discover;
  },
}));
vi.mock('../../src/agentBus/claudePeer', () => ({ readClaudeSessions: mocks.claude }));
vi.mock('../../src/agents/resolveCliExecutable', () => ({
  resolveCliExecutable: async () => 'codex',
}));

const cwd = process.cwd();
const config = {
  agent_bus: { enabled: true, codex_cli: 'codex', codex_model: 'saved-default' },
} as ForgeConfig;
const fresh = {
  agent: 'codex' as const,
  kind: 'new_task' as const,
  cwd,
  title: 'Runtime / ultra',
  model: 'new-runtime-model',
  effort: 'ultra',
};

beforeEach(() => {
  mocks.claude.mockReturnValue([]);
  mocks.discover.mockResolvedValue({
    models: [
      {
        id: 'runtime-id',
        model: 'new-runtime-model',
        displayName: 'Runtime',
        supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }],
      },
    ],
    threads: [],
  });
});

describe('CLI target discovery and capabilities', () => {
  it('pins accepted queued work across expiry while refusing new uses of an expired id', () => {
    let now = 0;
    const catalog = new AgentTargetCatalog(() => now);
    const [target] = catalog.publish('chat', cwd, [fresh]);
    const request = {};
    catalog.pin(request, 'chat', cwd, target!.targetId);
    now = 600_001;
    catalog.publish('chat', cwd, []);
    expect(catalog.resolve('chat', cwd, target!.targetId, request)).toEqual(target);
    expect(() => catalog.resolve('chat', cwd, target!.targetId)).toThrow('unknown or expired');
    expect(() => catalog.resolve('other', cwd, target!.targetId, request)).toThrow(
      'unknown or expired',
    );
  });
  it('discovers new model names and efforts, with explicit errors rather than hidden fallback', async () => {
    expect(await discoverAgentTargets(config, cwd)).toEqual({ targets: [fresh], errors: [] });
    mocks.discover.mockRejectedValueOnce(new Error('not logged in'));
    expect(await discoverAgentTargets(config, cwd)).toEqual({
      targets: [],
      errors: ['Codex discovery failed: not logged in'],
    });
  });

  it('lists exact workspace sessions without guessing model from their names', async () => {
    mocks.claude.mockReturnValue([
      { sessionId: 'live', name: 'Sol high', cwd, sdk: false },
      { sessionId: 'sdk', name: 'SDK', cwd, sdk: true },
      { sessionId: 'elsewhere', cwd: `${cwd}/elsewhere`, sdk: false },
    ]);
    mocks.discover.mockResolvedValueOnce({
      models: [],
      threads: [
        { id: 'codex-live', cwd, name: 'Luna' },
        { id: 'foreign', cwd: `${cwd}/foreign` },
      ],
    });
    expect((await discoverAgentTargets(config, cwd)).targets).toEqual([
      { agent: 'claude', kind: 'existing_session', title: 'Sol high', cwd, sessionId: 'live' },
      { agent: 'codex', kind: 'existing_session', title: 'Luna', cwd, sessionId: 'codex-live' },
    ]);
  });

  it('rejects forged, cross-chat, cross-folder, expired and replaced target ids', () => {
    let now = 0;
    const catalog = new AgentTargetCatalog(() => now);
    const [target] = catalog.publish('chat', cwd, [fresh]);
    for (const args of [
      ['other', cwd, target!.targetId],
      ['chat', 'other', target!.targetId],
      ['chat', cwd, 'forged'],
    ])
      expect(() => catalog.resolve(args[0]!, args[1]!, args[2]!)).toThrow('unknown or expired');
    now = 600_000;
    expect(() => catalog.resolve('chat', cwd, target!.targetId)).toThrow('unknown or expired');
    const [old] = catalog.publish('chat', cwd, [fresh]);
    catalog.publish('chat', cwd, [fresh]);
    expect(() => catalog.resolve('chat', cwd, old!.targetId)).toThrow('unknown or expired');
  });

  it('bounds chat snapshots and does not let returned objects mutate the capability', () => {
    const catalog = new AgentTargetCatalog();
    const [target] = catalog.publish('first', cwd, [fresh]);
    target!.model = 'tampered';
    expect(catalog.resolve('first', cwd, target!.targetId).model).toBe('new-runtime-model');
    for (let i = 0; i < 128; i++) catalog.publish(String(i), cwd, []);
    expect(() => catalog.resolve('first', cwd, target!.targetId)).toThrow('unknown or expired');
  });

  it('offers discovery through the tool and passes its selected id through ask_agent', async () => {
    const context = { conversation: { id: 'tool-chat' } } as ToolHandlerContext;
    const tool = makeListAgentTargetsTool(
      () => config,
      () => cwd,
    );
    const result = JSON.parse((await tool.handler({}, context)) as string);
    expect(result.targets[0]).toMatchObject({
      agent: 'codex',
      model: 'new-runtime-model',
      effort: 'ultra',
    });
    const start = vi.fn(async () => 'started');
    await makeAskAgentTool({ getConfig: () => config, getStarter: () => start }).handler(
      {
        agent: 'codex',
        target_id: result.targets[0].target_id,
        message: 'Review',
      },
      context,
    );
    expect(start).toHaveBeenCalledWith('tool-chat', {
      agent: 'codex',
      targetId: result.targets[0].target_id,
      message: 'Review',
    });
  });

  // A laptop chat on the desktop relay found no local target and went and
  // dialed the relay's own endpoints, which load and unload the desktop's
  // models. The result now says where the targets live.
  it('adds the machine note only when this chat is on the desktop relay', async () => {
    const context = { conversation: { id: 'tool-chat' } } as ToolHandlerContext;
    const laptopConfig = {
      ...config,
      groups: { 'desktop-relay': { endpoint: 'https://desktop.example:8765' } },
    } as ForgeConfig;

    const onRelay = JSON.parse(
      (await makeListAgentTargetsTool(
        () => laptopConfig,
        () => cwd,
      ).handler({}, context)) as string,
    );
    expect(onRelay.machine_note).toBe(
      "These targets run on this machine only. Agents on the desktop this laptop connects to (its Forge chats, Codex and Claude sessions) cannot be reached from here: ask the user to run that task on the desktop. Do not call the desktop relay's endpoints yourself; they load and unload the desktop's models.",
    );

    const offRelay = JSON.parse(
      (await makeListAgentTargetsTool(
        () => config,
        () => cwd,
      ).handler({}, context)) as string,
    );
    expect('machine_note' in offRelay).toBe(false);
  });
});

function setup() {
  const conversation = {
    id: 'selection-chat',
    title: 'Design',
    messages: [],
    agentLinks: {
      codex: {
        kind: 'codex',
        sessionId: 'original-linked-session',
        cwd: 'different-folder',
        title: 'Original link',
        linkedAt: 1,
        lastUsedAt: 1,
        origin: 'forge-created',
      },
    },
  } as unknown as ConversationRuntime;
  const runtime: AskAgentRuntime = {
    isLive: vi.fn(async () => true),
    openPanel: vi.fn(async () => 'opened'),
    sendLive: vi.fn(async () => ({ status: 'completed', finalText: 'live reply' })),
    runHeadless: vi.fn(async (options) => {
      options.onSessionId('actual-session');
      return { status: 'completed', finalText: 'task reply' };
    }),
  };
  const persist = vi.fn();
  const handler = makeAskAgentHandler({
    getConfig: () => config,
    runtime,
    getLinkConfig: () => ({ open_panel: 'never', panel_live_timeout_ms: 2 }),
  });
  const context = {
    conversation,
    checkpoint: {} as CheckpointSession,
    workspaceRoot: cwd,
    signal: new AbortController().signal,
    persistConversation: persist,
  };
  return { handler, runtime, context, persist };
}

describe('explicit selection respects identity and task scope', () => {
  it('does not send when Stop arrives during the session availability check', async () => {
    const state = setup();
    const controller = new AbortController();
    vi.mocked(state.runtime.isLive).mockImplementation(async () => {
      controller.abort();
      return true;
    });
    const [target] = agentTargetCatalog.publish('selection-chat', cwd, [
      { agent: 'claude', kind: 'existing_session', cwd, title: 'Session', sessionId: 'exact' },
    ]);
    await state.handler(
      { agent: 'claude', message: 'Review', targetId: target!.targetId },
      { ...state.context, signal: controller.signal },
    );
    expect(state.runtime.sendLive).not.toHaveBeenCalled();
    expect(state.runtime.runHeadless).not.toHaveBeenCalled();
  });
  it('does not dispatch when the asking turn is already cancelled', async () => {
    const state = setup();
    const [target] = agentTargetCatalog.publish('selection-chat', cwd, [fresh]);
    const controller = new AbortController();
    controller.abort();
    await state.handler(
      { agent: 'codex', message: 'Review', targetId: target!.targetId },
      { ...state.context, signal: controller.signal },
    );
    expect(state.runtime.runHeadless).not.toHaveBeenCalled();
    expect(state.runtime.sendLive).not.toHaveBeenCalled();
  });
  it('starts a separate selected task and leaves saved defaults and chat links untouched', async () => {
    const state = setup();
    const before = JSON.stringify({ config, conversation: state.context.conversation });
    const [target] = agentTargetCatalog.publish('selection-chat', cwd, [fresh]);
    const result = await state.handler(
      { agent: 'codex', message: 'Review', targetId: target!.targetId },
      state.context,
    );
    expect(result).toMatchObject({ status: 'completed', finalText: 'task reply', live: false });
    expect(result.notice).toContain('new-runtime-model, effort ultra');
    expect(result.notice).toContain('<actual-session>');
    expect(state.runtime.runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({ startNew: true, model: 'new-runtime-model', effort: 'ultra' }),
    );
    expect(state.runtime.sendLive).not.toHaveBeenCalled();
    expect(state.runtime.isLive).not.toHaveBeenCalled();
    expect(state.persist).not.toHaveBeenCalled();
    expect(JSON.stringify({ config, conversation: state.context.conversation })).toBe(before);
  });

  it.each(['codex', 'claude'] as const)(
    'addresses the exact %s identity and never replaces links',
    async (agent) => {
      const state = setup();
      const [target] = agentTargetCatalog.publish('selection-chat', cwd, [
        {
          agent,
          kind: 'existing_session',
          title: 'Named session',
          cwd,
          sessionId: 'exact-session',
        },
      ]);
      const result = await state.handler(
        { agent, message: 'Review', targetId: target!.targetId },
        state.context,
      );
      expect(result.status).toBe('completed');
      expect(state.runtime.sendLive).toHaveBeenCalledWith(
        agent,
        expect.objectContaining({ sessionId: 'exact-session' }),
        expect.any(String),
        state.context.signal,
        'ask',
        expect.any(Function),
      );
      expect(state.runtime.runHeadless).not.toHaveBeenCalled();
      expect(state.persist).not.toHaveBeenCalled();
    },
  );

  it('refuses an unavailable exact session without starting another', async () => {
    const state = setup();
    vi.mocked(state.runtime.isLive).mockResolvedValue(false);
    const [target] = agentTargetCatalog.publish('selection-chat', cwd, [
      { agent: 'codex', kind: 'existing_session', title: 'Gone', cwd, sessionId: 'gone' },
    ]);
    const result = await state.handler(
      { agent: 'codex', message: 'Review', targetId: target!.targetId },
      state.context,
    );
    expect(result.error).toBe(
      'Selected session is unavailable; nothing was sent. Discover targets again.',
    );
    expect(state.runtime.runHeadless).not.toHaveBeenCalled();
    expect(state.runtime.sendLive).not.toHaveBeenCalled();
  });

  it('rejects a mismatched agent and an unknown target before delivery', async () => {
    const state = setup();
    const [target] = agentTargetCatalog.publish('selection-chat', cwd, [fresh]);
    expect(
      (
        await state.handler(
          { agent: 'claude', message: 'Review', targetId: target!.targetId },
          state.context,
        )
      ).error,
    ).toBe('CLI target belongs to a different agent; nothing was sent.');
    expect(
      (
        await state.handler(
          { agent: 'codex', message: 'Review', targetId: 'unknown' },
          state.context,
        )
      ).error,
    ).toBe('CLI target is unknown or expired. Call list_agent_targets again; nothing was sent.');
    expect(state.runtime.runHeadless).not.toHaveBeenCalled();
    expect(state.runtime.sendLive).not.toHaveBeenCalled();
  });
});
