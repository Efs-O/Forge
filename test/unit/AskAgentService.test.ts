import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deliverAgentReply,
  makeAskAgentHandler,
  renderAskAgentResult,
  type AskAgentRuntime,
} from '../../src/agentLinks/askAgentService';
import {
  findBySession,
  rebuildIndex,
  type AgentKind,
  type AgentLink,
} from '../../src/agentLinks/chatAgentLinks';
import type { ForgeConfig } from '../../src/config/types';
import type { ConversationRuntime } from '../../src/sidebar/sessionTypes';
import type { CheckpointSession } from '../../src/checkpoint/CheckpointStack';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';

const id = '12d37c90-6da6-4c1c-853c-13487b137fca';
const otherId = '0b1b2163-0d08-4982-aa6a-2123888404f4';
const config = { agent_bus: { enabled: true } } as ForgeConfig;

function conversation(title = 'Design chat'): ConversationRuntime {
  return { id, title, createdAt: 1, updatedAt: 1, messages: [] };
}

function linked(agent: AgentKind, sessionId = otherId): AgentLink {
  return {
    kind: agent,
    sessionId,
    cwd: 'C:/repo',
    title: 'Forge · Design chat',
    linkedAt: 1,
    lastUsedAt: 1,
    origin: 'forge-created',
  };
}

function setup(
  overrides: Partial<AskAgentRuntime> = {},
  openPanel: 'every_ask' | 'never' = 'every_ask',
) {
  const events: string[] = [];
  const conv = conversation();
  const runtime: AskAgentRuntime = {
    openPanel: vi.fn(async () => 'opened'),
    isLive: vi.fn(async () => false),
    sendLive: vi.fn(async () => ({ status: 'completed', finalText: 'reply' })),
    runHeadless: vi.fn(async () => ({ status: 'completed', finalText: 'reply' })),
    ...overrides,
  };
  const checkpoint = {
    prepareWorkspace: vi.fn(async () => {
      events.push('checkpoint');
      return { finish: async () => events.push('finish'), discard: async () => undefined };
    }),
  } as unknown as CheckpointSession;
  const persistConversation = vi.fn(() => events.push('persist'));
  const handler = makeAskAgentHandler({
    getConfig: () => config,
    runtime,
    getLinkConfig: () => ({ open_panel: openPanel, panel_live_timeout_ms: 2 }),
    createSessionId: () => otherId,
  });
  return { handler, runtime, conv, checkpoint, persistConversation, events };
}

describe('ask_agent session resolution', () => {
  beforeEach(() => rebuildIndex([]));

  it.each(['claude', 'codex', 'copilot'] as const)('uses an exact live %s link', async (agent) => {
    const state = setup({ isLive: vi.fn(async () => true) });
    state.conv.agentLinks = { [agent]: linked(agent) };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent, message: 'Review this' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    expect(result).toMatchObject({
      agent,
      status: 'completed',
      finalText: 'reply',
      sessionTitle: 'Forge · Design chat',
      live: true,
    });
    expect(renderAskAgentResult(result)).toContain('reply');
    if (agent === 'codex')
      expect(renderAskAgentResult(result)).not.toContain('started a new background thread');
    expect(state.runtime.sendLive).toHaveBeenCalledOnce();
    expect(state.runtime.runHeadless).not.toHaveBeenCalled();
    if (agent === 'copilot') expect(state.events[0]).toBe('checkpoint');
    else expect(state.checkpoint.prepareWorkspace).not.toHaveBeenCalled();
    expect(state.events).toContain('persist');
  });

  // Laptop audit F10 (2026-10-26): a Forge-started Codex link answered once,
  // then every later send failed with "the Codex panel did not come up …; the
  // ask was not sent", while `who` and the chat header still showed the link as
  // healthy. `openExternal` on a `vscode://` link reports 'opened' whatever the
  // panel then does, so a thread that never appears in the thread list is the
  // only thing actually observed — and this branch used to make that a dead
  // end instead of the headless resume its `'unavailable'` sibling already was.
  // It used to be pinned the other way: "never falls back after timeout".
  it('resumes the same session headlessly when the opened panel never comes up', async () => {
    const state = setup({
      runHeadless: vi.fn(async (options) => {
        expect(options.createSessionId).toBeUndefined(); // a resume, not a new session
        expect(options.sessionTitle).toBe('Forge · Design chat');
        return { status: 'completed', finalText: 'resumed answer' };
      }),
    });
    state.conv.agentLinks = { codex: linked('codex') };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent: 'codex', message: 'Continue' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    const rendered = renderAskAgentResult(result);
    expect(rendered).toContain(
      'Codex panel did not come up for session "Forge · Design chat"; resumed headlessly.',
    );
    expect(rendered).toContain('resumed answer');
    expect(result).toMatchObject({ status: 'completed', live: false });
    expect(state.runtime.openPanel).toHaveBeenCalledWith('codex', otherId);
    expect(state.runtime.runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        link: expect.objectContaining({ sessionId: otherId }),
      }),
    );
    expect(state.runtime.sendLive).not.toHaveBeenCalled();
    // The link is what the resume ran on, so it stays exactly where it was.
    expect(state.conv.agentLinks?.codex?.sessionId).toBe(otherId);
  });

  it('a gone thread found by that resume unlinks the row and starts a fresh session', async () => {
    const freshThread = 'c5a7c3a1-8cb0-427d-b3b7-8ca13d739c59';
    const state = setup({
      runHeadless: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'failed',
          finalText: '',
          error: 'no such thread',
          sessionGone: true,
        })
        .mockImplementationOnce(async (options) => {
          options.onSessionId(freshThread);
          return { status: 'completed', finalText: 'new reply' };
        }),
    });
    state.conv.agentLinks = { codex: linked('codex') };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent: 'codex', message: 'Continue' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    const rendered = renderAskAgentResult(result);
    expect(rendered).toContain('no longer exists; started a new one');
    expect(rendered).toContain('new reply');
    expect(state.runtime.runHeadless).toHaveBeenCalledTimes(2);
    // The header strip's row is the new thread, not the dead one, and the dead
    // id no longer resolves to this chat.
    expect(state.conv.agentLinks?.codex?.sessionId).toBe(freshThread);
    expect(findBySession(otherId)).toBeUndefined();
    expect(findBySession(freshThread)).toBe(id);
  });

  // Suspect B of the same audit: the Codex thread list is read by spawning a
  // throwaway app-server, and `CodexDiscovery` REJECTS when that process does
  // not answer in time. Nothing caught it, so a slow app-server failed the ask
  // with a discovery message — read as "the thread is gone" when all it proves
  // is "I could not look".
  it('opens the panel once when liveness cannot be checked, then resumes headlessly if still unknown', async () => {
    const state = setup({
      isLive: vi.fn(async () => {
        throw new Error('Codex discovery timed out after 2000ms.');
      }),
      runHeadless: vi.fn(async () => ({ status: 'completed', finalText: 'resumed' })),
    });
    state.conv.agentLinks = { codex: linked('codex') };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent: 'codex', message: 'Continue' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    const rendered = renderAskAgentResult(result);
    expect(result.status).toBe('completed');
    expect(rendered).toContain('resumed');
    expect(rendered).toContain('Codex session could not be checked; resumed headlessly.');
    expect(rendered).not.toContain('did not come up');
    expect(state.runtime.openPanel).toHaveBeenCalledOnce();
    expect(state.runtime.runHeadless).toHaveBeenCalledOnce();
    expect(state.conv.agentLinks?.codex?.sessionId).toBe(otherId);
  });

  it('does not open a panel when liveness cannot be checked and panel opening is disabled', async () => {
    const state = setup(
      {
        isLive: vi.fn(async () => {
          throw new Error('Codex discovery timed out after 2000ms.');
        }),
        runHeadless: vi.fn(async () => ({ status: 'completed', finalText: 'resumed' })),
      },
      'never',
    );
    state.conv.agentLinks = { codex: linked('codex') };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent: 'codex', message: 'Continue' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    expect(renderAskAgentResult(result)).toContain(
      'could not be checked (Codex discovery timed out after 2000ms.); resumed headlessly.',
    );
    expect(state.runtime.openPanel).not.toHaveBeenCalled();
    expect(state.runtime.runHeadless).toHaveBeenCalledOnce();
  });

  it('a check that fails while waiting for the panel goes to the headless resume at once', async () => {
    const isLive = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        throw new Error('Codex app-server exited with code 1 before thread/list completed.');
      });
    const state = setup({
      isLive,
      runHeadless: vi.fn(async () => ({ status: 'completed', finalText: 'resumed' })),
    });
    state.conv.agentLinks = { codex: linked('codex') };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent: 'codex', message: 'Continue' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    const rendered = renderAskAgentResult(result);
    expect(rendered).toContain('Codex session could not be checked; resumed headlessly.');
    expect(rendered).toContain('resumed');
    expect(state.runtime.openPanel).toHaveBeenCalledOnce();
    expect(state.runtime.runHeadless).toHaveBeenCalledOnce();
  });

  it('a headless resume that also fails says what the owner can do, and keeps the link', async () => {
    const state = setup({
      runHeadless: vi.fn(async () => ({
        status: 'failed',
        finalText: '',
        error: 'auth expired',
      })),
    });
    state.conv.agentLinks = { codex: linked('codex') };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent: 'codex', message: 'Continue' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    const rendered = renderAskAgentResult(result);
    expect(rendered).toContain('auth expired');
    expect(rendered).toContain('panel did not come up');
    expect(rendered).toContain('unlink this session in the chat header');
    expect(state.conv.agentLinks?.codex?.sessionId).toBe(otherId);
  });

  it('a live-check failure keeps the answer as a verdict instead of claiming a failed delivery', async () => {
    const runtime = {
      isLive: vi.fn(async () => {
        throw new Error('Codex discovery timed out after 2000ms.');
      }),
      sendLive: vi.fn(),
    } as unknown as AskAgentRuntime;
    await expect(
      deliverAgentReply(
        runtime,
        'codex',
        linked('codex'),
        'the answer',
        new AbortController().signal,
      ),
    ).resolves.toBe(false);
    expect(runtime.sendLive).not.toHaveBeenCalled();
  });

  it('sends through the live adapter after the opened panel becomes live', async () => {
    const isLive = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const state = setup({ isLive });
    state.conv.agentLinks = { claude: linked('claude') };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent: 'claude', message: 'Review' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    expect(renderAskAgentResult(result)).toContain('reply');
    expect(state.runtime.openPanel).toHaveBeenCalledOnce();
    expect(state.runtime.sendLive).toHaveBeenCalledOnce();
    expect(state.runtime.runHeadless).not.toHaveBeenCalled();
  });

  it('resumes headlessly when panels are disabled and falls back when the opener is unavailable', async () => {
    const state = setup(
      { runHeadless: vi.fn(async () => ({ status: 'completed', finalText: 'resumed' })) },
      'never',
    );
    state.conv.agentLinks = { codex: linked('codex') };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent: 'codex', message: 'Continue' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    expect(renderAskAgentResult(result)).toContain('resumed');
    expect(state.runtime.runHeadless).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        link: expect.objectContaining({ sessionId: otherId }),
      }),
    );
    expect(state.runtime.openPanel).not.toHaveBeenCalled();

    const unavailable = setup({
      openPanel: vi.fn(async () => 'unavailable'),
      runHeadless: vi.fn(async () => ({ status: 'completed', finalText: 'resumed' })),
    });
    unavailable.conv.agentLinks = { claude: linked('claude') };
    rebuildIndex([unavailable.conv]);
    const fallback = await unavailable.handler(
      { agent: 'claude', message: 'Continue' },
      {
        conversation: unavailable.conv,
        checkpoint: unavailable.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: unavailable.persistConversation,
      },
    );
    expect(renderAskAgentResult(fallback)).toContain('panel could not be opened');
    expect(unavailable.runtime.runHeadless).toHaveBeenCalledOnce();
  });

  it.each(['claude', 'copilot'] as const)(
    'persists a new %s session before spawning',
    async (agent) => {
      const state = setup({
        runHeadless: vi.fn(async (options) => {
          expect(state.conv.agentLinks?.[agent]?.sessionId).toBe(otherId);
          expect(state.events).toContain('persist');
          expect(options.createSessionId).toBe(otherId);
          expect(options.sessionTitle).toBe('Forge · Design chat');
          return { status: 'completed', finalText: 'done' };
        }),
      });
      const result = await state.handler(
        { agent, message: 'Review' },
        {
          conversation: state.conv,
          checkpoint: state.checkpoint,
          signal: new AbortController().signal,
          workspaceRoot: 'C:/repo',
          persistConversation: state.persistConversation,
        },
      );
      expect(renderAskAgentResult(result)).toContain('done');
      if (agent === 'copilot')
        expect(state.events.indexOf('checkpoint')).toBeLessThan(state.events.indexOf('persist'));
      else expect(state.checkpoint.prepareWorkspace).not.toHaveBeenCalled();
    },
  );

  it('reports accepted only after the new headless process has started', async () => {
    const state = setup({
      runHeadless: vi.fn(async (options) => {
        options.onAccepted?.();
        options.onSessionId(otherId);
        return { status: 'completed', finalText: 'done' };
      }),
    });
    const onAccepted = vi.fn();
    await state.handler(
      { agent: 'claude', message: 'Review' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
        onAccepted,
      },
    );
    expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ sessionId: otherId }));
  });

  it('removes a pre-created Claude link when the first run fails before reporting a session', async () => {
    const state = setup({
      runHeadless: vi.fn(async () => ({
        status: 'failed',
        finalText: '',
        error: 'CLI unavailable',
      })),
    });
    const result = await state.handler(
      { agent: 'claude', message: 'Review' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    expect(renderAskAgentResult(result)).toContain('CLI unavailable');
    expect(state.conv.agentLinks?.claude).toBeUndefined();
    expect(state.persistConversation).toHaveBeenCalledTimes(2);
  });

  it('removes a pre-created Copilot link when the first run fails without output', async () => {
    const state = setup({
      runHeadless: vi.fn(async () => ({ status: 'failed', finalText: '', error: 'auth failed' })),
    });
    const result = await state.handler(
      { agent: 'copilot', message: 'Review' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    expect(renderAskAgentResult(result)).toContain('auth failed');
    expect(state.conv.agentLinks?.copilot).toBeUndefined();
    expect(state.persistConversation).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed Claude link once the CLI has confirmed its session exists', async () => {
    const state = setup({
      runHeadless: vi.fn(async (options) => {
        options.onSessionId(otherId);
        return { status: 'failed', finalText: '', error: 'turn failed' };
      }),
    });
    await state.handler(
      { agent: 'claude', message: 'Review' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    expect(state.conv.agentLinks?.claude?.sessionId).toBe(otherId);
    expect(state.persistConversation).toHaveBeenCalledOnce();
  });

  it('saves a new Codex thread at the first session id event and carries the title in the first line', async () => {
    const thread = 'c5a7c3a1-8cb0-427d-b3b7-8ca13d739c58';
    const state = setup({
      runHeadless: vi.fn(async (options) => {
        expect(state.conv.agentLinks?.codex).toBeUndefined();
        expect(options.prompt.startsWith('Forge · Design chat\n')).toBe(true);
        options.onSessionId(thread);
        expect(state.conv.agentLinks?.codex?.sessionId).toBe(thread);
        return { status: 'completed', finalText: 'done' };
      }),
    });
    const result = await state.handler(
      { agent: 'codex', message: 'Review' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    const rendered = renderAskAgentResult(result);
    expect(rendered.startsWith(
      `Codex: started a new background thread <${thread}> (not your open Codex panel chat); use /link in this chat to link a panel chat instead.\n`,
    )).toBe(true);
    expect(state.persistConversation).toHaveBeenCalledOnce();
  });

  it('replaces a gone session and tells the user', async () => {
    const state = setup(
      {
        runHeadless: vi
          .fn()
          .mockResolvedValueOnce({ status: 'failed', finalText: '', sessionGone: true })
          .mockResolvedValueOnce({ status: 'completed', finalText: 'new reply' }),
      },
      'never',
    );
    state.conv.agentLinks = { claude: linked('claude') };
    rebuildIndex([state.conv]);
    const result = await state.handler(
      { agent: 'claude', message: 'Review' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: new AbortController().signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    expect(renderAskAgentResult(result)).toContain('no longer exists; started a new one');
    expect(state.runtime.runHeadless).toHaveBeenCalledTimes(2);
  });

  it('passes stop through to the live session and reports that Claude may still work', async () => {
    const state = setup({
      isLive: vi.fn(async () => true),
      sendLive: vi.fn(async () => ({
        status: 'cancelled',
        finalText: '',
        mayStillBeWorking: true,
      })),
    });
    state.conv.agentLinks = { claude: linked('claude') };
    rebuildIndex([state.conv]);
    const controller = new AbortController();
    const result = await state.handler(
      { agent: 'claude', message: 'Review' },
      {
        conversation: state.conv,
        checkpoint: state.checkpoint,
        signal: controller.signal,
        workspaceRoot: 'C:/repo',
        persistConversation: state.persistConversation,
      },
    );
    expect(renderAskAgentResult(result)).toContain('session may still be working');
    expect(state.runtime.sendLive).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ sessionId: otherId }),
      expect.any(String),
      controller.signal,
      'ask',
      expect.any(Function),
    );
  });

  it('enforces the jobs CLI gate', async () => {
    const state = setup();
    const marker = unattendedConversations.mark(id, { jobId: 'j', jobName: 'nightly' });
    try {
      const result = await state.handler(
        { agent: 'claude', message: 'Review' },
        {
          conversation: state.conv,
          checkpoint: state.checkpoint,
          signal: new AbortController().signal,
          workspaceRoot: 'C:/repo',
          persistConversation: state.persistConversation,
        },
      );
      expect(renderAskAgentResult(result)).toContain('jobs.allow_cli_agents');
      expect(state.runtime.runHeadless).not.toHaveBeenCalled();
    } finally {
      marker.dispose();
    }
  });
});
