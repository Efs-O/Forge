import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  makeAgentToAgentRelay,
  makeAgentToAgentSteer,
  inFlightRelayCount,
  abortInFlightRelays,
} from '../../src/agentLinks/agentToAgentRelay';
import { rebuildIndex } from '../../src/agentLinks/chatAgentLinks';
import { isTerminal } from '../../src/agentMesh/deliveryState';
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
  it('resolves through the chat this window holds for the sender, not the newest chat anywhere', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-linked-relay-'));
    dirs.push(root);
    const busRoot = path.join(root, '.forge', 'agent-bus');
    rebuildIndex([
      {
        // The newest chat is one this window does not have: reading
        // `findBySession` alone here used to answer "you are not linked" to a
        // session that is linked in this window (lane 4 phase 5).
        id: 'elsewhere',
        title: 'Another window',
        agentLinks: {
          claude: { ...codex, kind: 'claude', sessionId: sender.sessionId, lastUsedAt: 99 },
          codex,
        },
      },
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
      getAgentLink: vi.fn((id: string) => (id === 'chat-1' ? senderLink : undefined)),
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

describe('steering a linked agent (audit F2)', () => {
  /** The delegated ask held open the way a real one is: each call reports the
   *  signal it was given and resolves `cancelled` when that signal aborts.
   *  That is how a turn Forge runs actually stops — the CLI process Forge
   *  started is terminated, and a warm Codex app-server turn receives
   *  `turn/interrupt` through this same signal — so aborting the signal is the
   *  honest test of "the steer stopped the earlier request". */
  function heldOpenAsk(): {
    askAgent: ReturnType<typeof vi.fn>;
    signals: AbortSignal[];
    finish: (index: number, result: AskAgentResult) => void;
  } {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(result: AskAgentResult) => void> = [];
    const askAgent = vi.fn((_cid: string, _req: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<AskAgentResult>((resolve) => {
        resolvers.push(resolve);
        signal.addEventListener(
          'abort',
          () =>
            resolve({
              agent: 'codex',
              status: 'cancelled',
              finalText: '',
              error: 'Cancelled.',
              sessionTitle: 'Forge · Review',
              subject: '',
              live: false,
            }),
          { once: true },
        );
      });
    });
    return {
      askAgent,
      signals,
      // The ask is started by the relay's background half, so it can land a
      // beat after the send returns; wait for it instead of assuming the slot.
      finish: async (index: number, result: AskAgentResult) => {
        await vi.waitFor(() => expect(typeof resolvers[index]).toBe('function'));
        resolvers[index]!(result);
      },
    };
  }

  /** The same chat and links as the relay tests above, with the ask supplied by
   *  the caller so each test can control when the delegated turn ends. */
  async function steeringHarness(askAgent: ReturnType<typeof vi.fn>) {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-linked-steer-'));
    dirs.push(home);
    const busRoot = path.join(home, '.forge', 'agent-bus');
    rebuildIndex([
      {
        id: 'chat-1',
        title: 'Review',
        agentLinks: { claude: { ...codex, kind: 'claude', sessionId: sender.sessionId }, codex },
      },
    ]);
    const senderLink = {
      kind: 'claude' as const,
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
      isLive: vi.fn(async () => false),
      sendLive: vi.fn(async () => ({ status: 'completed', finalText: '' })),
    } as unknown as AskAgentRuntime;
    return {
      home,
      facade,
      relay: makeAgentToAgentRelay(() => facade, busRoot, 'C:/workspace', runtime),
      steer: makeAgentToAgentSteer(() => facade, busRoot, 'C:/workspace', runtime),
      events: () => readEvents(path.join(busRoot, 'exchanges.jsonl')),
    };
  }

  const completed = (finalText: string): AskAgentResult => ({
    agent: 'codex',
    status: 'completed',
    finalText,
    sessionTitle: 'Forge · Review',
    subject: 'Review',
    live: false,
  });

  /** Every `showConversationNotice` call, as plain strings, so a test can say
   *  "no call said this" without guessing which notice landed first. */
  function facadeCalls(facade: ForgeHostFacade): unknown[][] {
    return (facade.showConversationNotice as unknown as ReturnType<typeof vi.fn>).mock.calls;
  }

  // The relay registry is this window's state, and the suites above leave
  // relays open on purpose (a hung live delivery is one of them). Withdraw
  // whatever is still held before and after each test here so the registry
  // counts mean what they say.
  beforeEach(() => abortInFlightRelays());
  afterEach(() => abortInFlightRelays());

  it('with nothing in flight, a steer is an ordinary relay', async () => {
    const { askAgent, finish } = heldOpenAsk();
    const harness = await steeringHarness(askAgent);
    const steered = await harness.steer(sender, 'codex', 'do this instead');
    if (!steered.ok || !steered.exchangeId) throw new Error('steer created no exchange');
    expect(steered).toMatchObject({ ok: true, deliveredTo: 'Codex link in chat chat-1' });
    expect(steered.note).toBeUndefined(); // there was no earlier request to withdraw
    await vi.waitFor(() =>
      expect(askAgent).toHaveBeenCalledWith(
        'chat-1',
        { agent: 'codex', message: 'do this instead' },
        expect.any(AbortSignal),
      ),
    );
    await finish(0, completed('Steered answer'));
    await vi.waitFor(() =>
      expect(
        readVerdictArtifact(busPaths(harness.home), steered.exchangeId, 'claude', sender.sessionId),
      ).toBe('Steered answer\n'),
    );
    expect(inFlightRelayCount()).toBe(0);
  });

  it('withdraws the request already in flight, records it cancelled, and runs its own', async () => {
    const { askAgent, signals, finish } = heldOpenAsk();
    const harness = await steeringHarness(askAgent);
    const first = await harness.relay(sender, 'codex', 'Review the patch');
    if (!first.ok || !first.exchangeId) throw new Error('relay created no exchange');
    await vi.waitFor(() => expect(inFlightRelayCount()).toBe(1));
    // Wait for the ask itself to be in flight, not just for the registry entry:
    // the entry is registered before the relay's first log write, so a steer
    // that lands in the same beat aborts a signal no fake has listened to yet,
    // and the test would prove nothing about what the aborted ask does.
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const steered = await harness.steer(sender, 'codex', 'stop that; review the tests instead');
    if (!steered.ok || !steered.exchangeId) throw new Error('steer created no exchange');
    expect(steered.exchangeId).not.toBe(first.exchangeId);
    expect(steered.note).toContain('was withdrawn before it answered');
    expect(steered.note).toContain('may still be running');
    // The ask Forge started for the withdrawn request is aborted: that is what
    // ends a turn Forge runs (CLI process terminated, warm app-server turn
    // interrupted), and it is all Forge can claim about an agent it does not run.
    expect(signals[0]!.aborted).toBe(true);
    expect(
      harness
        .events()
        .some((event) => event.exchangeId === first.exchangeId && event.state === 'cancelled'),
    ).toBe(true);
    await finish(0, completed('ignored')); // the withdrawn one, already cancelled by the abort
    await finish(1, completed('Steered answer'));
    await vi.waitFor(() => {
      expect(inFlightRelayCount()).toBe(0);
      expect(
        readVerdictArtifact(busPaths(harness.home), steered.exchangeId, 'claude', sender.sessionId),
      ).toBe('Steered answer\n');
    });
    // The withdrawn exchange stays cancelled: a late crash row for it cannot
    // make the board read it as work that will still happen.
    const late = harness.events().filter((event) => event.exchangeId === first.exchangeId);
    expect(late.some((event) => event.state === 'crashed')).toBe(false);
    // Bridge review (phase 2.0): exactly one terminal row, the steer's own
    // `cancelled`, and no failure notice. The aborted ask resolves `cancelled`,
    // so the relay's catch used to append its own row and tell the chat
    // "Codex relay failed: Cancelled." — a withdrawn request read as a broken
    // link, and the next send looked like the same failure all over again.
    const terminal = late.filter((event) => isTerminal(event.state));
    expect(terminal.map((event) => event.state)).toEqual(['cancelled']);
    expect(
      (facadeCalls(harness.facade) as string[][]).some((call) => call[1]?.includes('relay failed')),
    ).toBe(false);
  });

  it("runs the live delivery on the relay's own signal, so a withdrawal stops it", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-linked-delivery-'));
    dirs.push(home);
    const busRoot = path.join(home, '.forge', 'agent-bus');
    rebuildIndex([
      {
        id: 'chat-1',
        title: 'Review',
        agentLinks: { claude: { ...codex, kind: 'claude', sessionId: sender.sessionId }, codex },
      },
    ]);
    const senderLink = {
      kind: 'claude' as const,
      sessionId: sender.sessionId,
      cwd: '.',
      title: 'Claude',
      linkedAt: 1,
      lastUsedAt: 1,
      origin: 'user-set' as const,
    };
    // The ask answers, so the relay reaches its live delivery; the delivery is
    // the part that hangs until something aborts the signal it was handed.
    const askSignals: AbortSignal[] = [];
    const facade = {
      getAgentLink: vi.fn(() => senderLink),
      status: vi.fn(() => ({ conversations: [{ id: 'chat-1', title: 'Review' }] })),
      askAgent: vi.fn((_cid: string, _req: unknown, signal: AbortSignal) => {
        askSignals.push(signal);
        return Promise.resolve(completed('Codex reply'));
      }),
      showConversationNotice: vi.fn(),
    } as unknown as ForgeHostFacade;
    const deliverySignals: AbortSignal[] = [];
    const runtime = {
      isLive: vi.fn(async () => true),
      sendLive: vi.fn((_agent: unknown, _link: unknown, _prompt: unknown, signal: AbortSignal) => {
        deliverySignals.push(signal);
        return new Promise<AskAgentResult>((resolve) => {
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                agent: 'claude',
                status: 'cancelled',
                finalText: '',
                error: 'Cancelled.',
                sessionTitle: 'Claude',
                subject: '',
                live: true,
              }),
            { once: true },
          );
        });
      }),
    } as unknown as AskAgentRuntime;
    const relay = makeAgentToAgentRelay(() => facade, busRoot, 'C:/workspace', runtime);
    const sent = await relay(sender, 'codex', 'Review the patch');
    if (!sent.ok || !sent.exchangeId) throw new Error('relay created no exchange');
    await vi.waitFor(() => expect(runtime.sendLive).toHaveBeenCalledOnce());
    // Phase 2.0, fix 3: the delivery runs on the relay's controller, not on a
    // fresh controller nobody can ever abort. Same signal object means the
    // steer and the window's disposal can stop a hung delivery too.
    expect(deliverySignals[0]).toBe(askSignals[0]);
    abortInFlightRelays(); // what disposing this window's agent-bus wiring does
    // The abort is synchronous; the relay's continuation after it is not, so
    // wait for the line the withdrawal is supposed to leave behind rather than
    // reading the notices a tick too early.
    await vi.waitFor(() => {
      expect(deliverySignals[0]!.aborted).toBe(true);
      expect(inFlightRelayCount()).toBe(0);
      expect((facadeCalls(facade) as string[][]).map((call) => call[1]).join('\n')).toContain(
        'was not seen live',
      );
    });
    const notices = (facadeCalls(facade) as string[][]).map((call) => call[1]).join('\n');
    // The answer is retained, so the honest line is the "not seen live" one;
    // neither a delivery-failure complaint nor a relay-failure notice applies
    // to a withdrawal Forge itself caused.
    expect(notices).toContain('was not seen live');
    expect(notices).not.toContain('Could not deliver');
    expect(notices).not.toContain('relay failed');
    const events = readEvents(path.join(busRoot, 'exchanges.jsonl'));
    expect(events.some((event) => event.state === 'crashed')).toBe(false);
    expect(
      readVerdictArtifact(busPaths(home), sent.exchangeId, sender.kind, sender.sessionId),
    ).toBe('Codex reply\n');
  });

  it("a steer aimed at another agent leaves this chat's Codex request running", async () => {
    const { askAgent, signals } = heldOpenAsk();
    const harness = await steeringHarness(askAgent);
    const first = await harness.relay(sender, 'codex', 'Review the patch');
    if (!first.ok || !first.exchangeId) throw new Error('relay created no exchange');
    await vi.waitFor(() => expect(inFlightRelayCount()).toBe(1));
    await harness.steer(sender, 'copilot', 'ask something else');
    expect(signals[0]!.aborted).toBe(false);
    expect(
      harness
        .events()
        .some((event) => event.exchangeId === first.exchangeId && event.state === 'cancelled'),
    ).toBe(false);
  });

  it('a relay that fails leaves nothing in flight either', async () => {
    const askAgent = vi.fn(async () => ({
      agent: 'codex',
      status: 'failed',
      finalText: '',
      error: 'auth expired',
      sessionTitle: 'Forge · Review',
      subject: 'Review',
      live: false,
    })) as unknown as ReturnType<typeof vi.fn>;
    const harness = await steeringHarness(askAgent);
    await harness.relay(sender, 'codex', 'Review the patch');
    await vi.waitFor(() =>
      expect(harness.events().some((event) => event.state === 'crashed')).toBe(true),
    );
    expect(inFlightRelayCount()).toBe(0);
  });

  it('disposing the agent-bus wiring withdraws every relay still in flight', async () => {
    const { askAgent, signals } = heldOpenAsk();
    const harness = await steeringHarness(askAgent);
    await harness.relay(sender, 'codex', 'Review the patch');
    await vi.waitFor(() => expect(inFlightRelayCount()).toBe(1));
    abortInFlightRelays(); // what the window's disposal subscription now calls
    expect(inFlightRelayCount()).toBe(0);
    await vi.waitFor(() => expect(signals[0]!.aborted).toBe(true));
  });
});
