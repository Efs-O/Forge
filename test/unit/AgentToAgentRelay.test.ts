import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeAgentToAgentRelay } from '../../src/agentLinks/agentToAgentRelay';
import { rebuildIndex } from '../../src/agentLinks/chatAgentLinks';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import { busPaths } from '../../src/agentBus/agentBus';
import { readVerdictArtifact } from '../../src/agentMesh/verdictArtifact';
import type { AskAgentRuntime, AskAgentResult } from '../../src/agentLinks/askAgentService';
import { readEvents } from '../../src/agentMesh/exchangeLog';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const sender = { kind: 'claude' as const, sessionId: '8e395649-705e-47f9-b499-03a36e908f51' };
const codex = {
  kind: 'codex' as const,
  sessionId: '8e395649-705e-47f9-b499-03a36e908f52',
  cwd: 'C:/workspace',
  title: 'Forge · Review',
  linkedAt: 1,
  lastUsedAt: 2,
  origin: 'forge-created' as const,
};

describe('agent-to-agent links', () => {
  it('resolves through the sender chat and delegates through the ask-agent facade', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-linked-relay-'));
    dirs.push(root);
    const busRoot = path.join(root, '.forge', 'agent-bus');
    rebuildIndex([
      {
        id: 'chat-1',
        title: 'Review',
        agentLinks: { claude: { ...codex, kind: 'claude', sessionId: sender.sessionId }, codex },
      },
    ]);
    let completeAsk!: (result: AskAgentResult) => void;
    const askAgent = vi.fn(() => new Promise<AskAgentResult>((resolve) => (completeAsk = resolve)));
    const senderLink = {
      kind: 'claude',
      sessionId: sender.sessionId,
      cwd: '.',
      title: 'Claude',
      linkedAt: 1,
      lastUsedAt: 1,
      origin: 'user-set' as const,
    };
    const facade = {
      getAgentLink: vi.fn(() => senderLink),
      status: vi.fn(() => ({ conversations: [{ id: 'chat-1', title: 'Review' }] })),
      askAgent,
      showConversationNotice: vi.fn(),
    } as unknown as ForgeHostFacade;
    const runtime = {
      isLive: vi.fn(async () => true),
      sendLive: vi.fn(async () => ({ status: 'completed', finalText: '' })),
    } as unknown as AskAgentRuntime;
    const relay = makeAgentToAgentRelay(() => facade, busRoot, 'C:/workspace', runtime);
    const result = await relay(sender, 'codex', 'Review the patch');
    expect(result).toMatchObject({ ok: true, deliveredTo: 'Codex link in chat chat-1' });
    if (!result.ok || !result.exchangeId)
      throw new Error('relay did not create a verdict exchange');
    await vi.waitFor(() => expect(askAgent).toHaveBeenCalledOnce());
    expect(() =>
      readVerdictArtifact(busPaths(root), result.exchangeId, sender.kind, sender.sessionId),
    ).toThrow();
    completeAsk({
      agent: 'codex',
      status: 'completed',
      finalText: 'Codex reply',
      sessionTitle: 'Forge · Review',
      subject: 'Review the patch',
      live: false,
    });
    await vi.waitFor(() =>
      expect(
        readVerdictArtifact(busPaths(root), result.exchangeId, sender.kind, sender.sessionId),
      ).toBe('Codex reply\n'),
    );
    expect(runtime.sendLive).toHaveBeenCalledWith(
      'claude',
      senderLink,
      'Forge (chat "Review") replied:\n\nCodex reply',
      expect.any(AbortSignal),
      'reply',
    );
    expect(askAgent).toHaveBeenCalledWith(
      'chat-1',
      { agent: 'codex', message: 'Review the patch' },
      expect.any(AbortSignal),
    );
  });

  it('records the verdict before awaiting the live delivery (U03-02)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-linked-relay-'));
    dirs.push(root);
    rebuildIndex([
      {
        id: 'chat-1',
        title: 'Review',
        agentLinks: { claude: { ...codex, kind: 'claude', sessionId: sender.sessionId }, codex },
      },
    ]);
    const senderLink = { ...codex, kind: 'claude', sessionId: sender.sessionId };
    const facade = {
      getAgentLink: vi.fn(() => senderLink),
      status: vi.fn(() => ({ conversations: [{ id: 'chat-1', title: 'Review' }] })),
      askAgent: vi.fn(async () => ({
        agent: 'codex',
        status: 'completed',
        finalText: 'Codex reply',
        sessionTitle: 'Forge · Review',
        subject: 'Review the patch',
        live: false,
      })),
      showConversationNotice: vi.fn(),
    } as unknown as ForgeHostFacade;
    // The live delivery never settles: a crash at this point used to strand the file.
    const runtime = {
      isLive: vi.fn(async () => true),
      sendLive: vi.fn(() => new Promise(() => undefined)),
    } as unknown as AskAgentRuntime;
    const relay = makeAgentToAgentRelay(
      () => facade,
      path.join(root, '.forge', 'agent-bus'),
      'C:/workspace',
      runtime,
    );
    const result = await relay(sender, 'codex', 'Review the patch');
    if (!result.ok || !result.exchangeId)
      throw new Error('relay did not create a verdict exchange');
    await vi.waitFor(() => expect(runtime.sendLive).toHaveBeenCalledOnce());
    expect(
      readVerdictArtifact(busPaths(root), result.exchangeId, sender.kind, sender.sessionId),
    ).toBe('Codex reply\n');
  });

  it('refuses an agent sender that has no linked Forge chat', async () => {
    rebuildIndex([]);
    const askAgent = vi.fn();
    const relay = makeAgentToAgentRelay(
      () => ({ askAgent }) as unknown as ForgeHostFacade,
      'unused',
      'workspace',
      {} as AskAgentRuntime,
    );
    await expect(relay(sender, 'codex', 'hello')).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('message Forge with say first'),
    });
    expect(askAgent).not.toHaveBeenCalled();
  });

  it('logs a background ask failure as crashed and surfaces it in the chat', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-linked-relay-failure-'));
    dirs.push(home);
    const root = path.join(home, '.forge', 'agent-bus');
    rebuildIndex([
      {
        id: 'chat-1',
        title: 'Review',
        agentLinks: { claude: { ...codex, kind: 'claude', sessionId: sender.sessionId }, codex },
      },
    ]);
    const facade = {
      getAgentLink: vi.fn(() => ({ kind: 'claude', sessionId: sender.sessionId })),
      status: vi.fn(() => ({ conversations: [{ id: 'chat-1', title: 'Review' }] })),
      askAgent: vi.fn(
        async (): Promise<AskAgentResult> => ({
          agent: 'codex',
          status: 'failed',
          finalText: '',
          error: 'auth expired',
          sessionTitle: 'Forge · Review',
          subject: 'Review patch',
          live: false,
        }),
      ),
      showConversationNotice: vi.fn(),
    } as unknown as ForgeHostFacade;
    const relay = makeAgentToAgentRelay(() => facade, root, 'C:/workspace', {} as AskAgentRuntime);
    const result = await relay(sender, 'codex', 'Review patch');
    if (!result.ok || !result.exchangeId) throw new Error('relay did not create an exchange');
    await vi.waitFor(() => {
      expect(readEvents(path.join(root, 'exchanges.jsonl')).map((item) => item.state)).toContain(
        'crashed',
      );
      // Inside the wait: the notice follows the crashed event, and under a
      // loaded full CI run it can land a tick after the event is written.
      expect(facade.showConversationNotice).toHaveBeenCalledWith(
        'chat-1',
        'Codex relay failed: auth expired',
      );
    });
  });
});
