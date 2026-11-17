import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { busPaths, type BusPaths } from '../../src/agentBus/agentBus';
import { CLIENT_SCRIPT } from '../../src/agentBus/busContent';
import { BusTurnWatch } from '../../src/agentBus/busTurnWatch';
import { appendEvent, EXCHANGES_LOG_NAME, type ExchangeLogPaths } from '../../src/agentMesh/exchangeLog';
import { verdictArtifactPath } from '../../src/agentMesh/verdictArtifact';
import { AgentRoutes } from '../../src/backend/agentRoutes';
import { listenLoopback } from '../support/listenLoopback';
import { inFlightRelayCount } from '../../src/agentLinks/agentToAgentRelay';
import { rebuildIndex } from '../../src/agentLinks/chatAgentLinks';
import { PendingAgentReplies } from '../../src/agentLinks/pendingAgentReplies';
import type { AskAgentRuntime } from '../../src/agentLinks/askAgentService';
import type { ForgeConfig } from '../../src/config/types';
import type { ForgeHostFacade } from '../../src/sidebar/ForgeHostFacade';
import {
  buildAgentRouteDeps,
  type AgentRouteDepsHosts,
} from '../../src/vscode/agentRouteDeps';

/**
 * The routes a Forge window actually registers, checked against what the client
 * advertises (audit F1, and the cheap CI guard for the whole class of bug it
 * found): `forge.sh` and the bus README promise `read-verdict` and
 * `ack-verdict`, and in 0.17.86 every window answered `no route` for both,
 * because registration was gated on `validateFrom` — an optional dependency
 * neither handler uses — and the production wiring never supplied it.
 *
 * Both tests build the routes from `buildAgentRouteDeps`, the same construction
 * `setupAgentMessaging` runs, with fakes for the window. Neither copies the
 * dependency list: a route added to the client without its route here, or a
 * route gated on something the window does not supply, fails here.
 */

const CODEX_SESSION = '00000000-0000-4000-8000-000000000071';
const CLAUDE_SESSION = '8e395649-705e-47f9-b499-03a36e908f51';
const CLAUDE_SESSION_B = '8e395649-705e-47f9-b499-03a36e908f52';
const REMOTE_EXCHANGE = '2f4d1a3e-0000-4000-8000-0000000000aa';

/** The verbs the client prints in its usage header — derived from the shipped
 *  script, the same text `forge.sh` prints when called with no arguments. */
function advertisedVerbs(script: string): string[] {
  const lines = script.split('\n');
  const out: string[] = [];
  for (const line of lines.slice(1)) {
    if (!line.startsWith('#')) break; // the header ends at the first non-comment line
    const match = /^#\s+forge\.sh ([a-z][a-z-]*)\b/u.exec(line);
    if (match) out.push(match[1] as string);
  }
  return [...new Set(out)].sort();
}

/** verb → the HTTP call that verb makes. `wait` polls `status` then `view`;
 *  `send`/`steer` share `/agent/message` with `say`, differing only in fields. */
const ROUTE_FOR_VERB: Record<
  string,
  { method: 'GET' | 'POST'; path: string; query?: string; body?: string; form?: boolean }
> = {
  // Insertion order is the order the loop calls these in, and it matters:
  // `ack-verdict` removes the retained copy `read-verdict` reads, so the read
  // goes first and both can be expected to answer 200.
  //
  // Both carry the kind-specific identity, because that is what the real client
  // sends: `set_sender_identity` in `forge.sh` adds `kind` and `sessionId` for
  // every agent name, and this table is the model of that script. A session-bound
  // exchange now refuses a reader that leaves the identity out, so a table that
  // sent only `from` would be testing a request no agent ever makes.
  'read-verdict': {
    method: 'GET',
    path: '/agent/read-verdict',
    query: `?from=codex&id=x1&kind=codex&sessionId=${CODEX_SESSION}`,
  },
  'ack-verdict': {
    method: 'POST',
    path: '/agent/ack-verdict',
    body: `from=codex&id=x1&kind=codex&sessionId=${CODEX_SESSION}`,
    form: true,
  },
  reload: {
    method: 'POST',
    path: '/agent/reload',
    query: '?from=codex&conversation_id=c1',
    body: '',
  },
  cancel: { method: 'POST', path: '/agent/cancel', query: '?from=codex&id=m1', body: '' },
  'remote-ask': {
    method: 'POST',
    path: '/agent/remote-ask',
    query: `?from=codex&exchange_id=${REMOTE_EXCHANGE}&sender=${encodeURIComponent(
      JSON.stringify({ kind: 'codex', sessionId: CODEX_SESSION }),
    )}`,
    body: 'a note',
  },
  'remote-notify': {
    method: 'POST',
    path: '/agent/remote-notify',
    query: `?from=codex&exchange_id=${REMOTE_EXCHANGE}&sender=${encodeURIComponent(
      JSON.stringify({ kind: 'codex', sessionId: CODEX_SESSION }),
    )}`,
    body: 'a note',
  },
  notify: { method: 'POST', path: '/agent/notify', query: '?from=codex', body: 'a note' },
  reply: { method: 'POST', path: '/agent/reply', query: '?id=q7', body: 'the answer' },
  say: { method: 'POST', path: '/agent/message', query: '?from=codex', body: 'hello forge' },
  send: {
    method: 'POST',
    path: '/agent/message',
    query: '?from=codex&to=forge',
    body: 'hello forge',
  },
  'send-file': {
    method: 'POST',
    path: '/agent/send-file',
    body: [
      'from=codex',
      'sender_kind=codex',
      `sender_session_id=${CODEX_SESSION}`,
      'conversation_id=c1',
      'path=notes.txt',
    ].join('&'),
    form: true,
  },
  status: { method: 'GET', path: '/agent/status', query: `?from=codex&kind=codex&sessionId=${CODEX_SESSION}` },
  steer: {
    method: 'POST',
    path: '/agent/message',
    query: '?from=codex&to=forge&priority=steer',
    body: 'do this instead',
  },
  stop: { method: 'POST', path: '/agent/stop', query: '?from=codex', body: '' },
  view: { method: 'GET', path: '/agent/view', query: `?from=codex&kind=codex&sessionId=${CODEX_SESSION}` },
  wait: { method: 'GET', path: '/agent/status', query: `?from=codex&kind=codex&sessionId=${CODEX_SESSION}` },
  who: { method: 'GET', path: '/agent/who' },
};

describe('the routes a production window registers', () => {
  let home: string;
  let workspace: string;
  let paths: BusPaths;
  let routes: AgentRoutes;
  let server: http.Server;
  let base: string;
  let token: string;
  let logPaths: ExchangeLogPaths;
  const cancelled = new Set<string>();
  const interrupted = new Set<string>();
  /** Steer ids the route released from hold, so a test can say whether the
   *  queue was ever allowed to start a message its guard later refused. */
  const released = new Set<string>();
  /** Which chat a `/agent/send-file` actually delivered to, in call order. */
  const sentTo: string[] = [];

  /** The window, as little of it as the routes actually touch: one chat, holding
   *  the sender's chat by title, streaming, with the two agent sessions the
   *  client can identify itself as. */
  const links = {
    claude: {
      kind: 'claude' as const,
      sessionId: CLAUDE_SESSION,
      cwd: 'C:/workspace',
      title: 'Claude',
      linkedAt: 1,
      lastUsedAt: 1,
      origin: 'forge-created' as const,
    },
    codex: {
      kind: 'codex' as const,
      sessionId: CODEX_SESSION,
      cwd: 'C:/workspace',
      title: 'Codex',
      linkedAt: 1,
      lastUsedAt: 1,
      origin: 'forge-created' as const,
    },
  };
  const askAgent = vi.fn(async () => ({
    agent: 'codex',
    status: 'completed' as const,
    finalText: 'the agent answer',
    sessionTitle: 'Codex',
    subject: 'a request',
    live: false,
  }));
  /** What the inbox holds for `carol`, a sender that has never written to this
   *  window: audit F3 is exactly this state, and `status` answered 404 for it. */
  const queued = { count: 0, conversationId: undefined as string | undefined };
  let runningNewChat = false;
  let twoClaudeChats = false;
  /** One closed chat, so `--to` has a chat that is named and gone. */
  let archivedReadChat = false;
  /** A chat holding a request chain, and one sitting on a card the owner must
   *  answer: the two states a cross-window steer compares against or refuses on,
   *  which `GET /agent/chats` has to report because the guard runs on peer data. */
  let peerChainChat = false;
  let peerApprovalChat = false;
  /** A chain on the chat a steer is aimed at, at the epoch it carries: the
   *  receiving window compares the chain the sender read against this. */
  let targetChainEpoch: number | undefined;
  /** How many messages this window's inbox was ever asked to hold. */
  let accepts = 0;
  /** A card on the chat a steer is aimed at — the state the receiving window
   *  has to re-check for itself, because the sender read a chat list a tool
   *  round ago and the owner may have been asked something since. */
  let approvalForTarget = false;
  /** The steer's chat vanishing or going idle — the transitions between the
   *  first guard and the interrupt that the final check must not skip. */
  let closedForTarget = false;
  let idleForTarget = false;
  const claudeBLink = { ...links.claude, sessionId: CLAUDE_SESSION_B, title: 'Claude B', lastUsedAt: 3 };
  const newChatLink = { ...links.claude, lastUsedAt: 2 };
  const fakeFacade = {
    status: () => ({
      activeConversationId: runningNewChat ? 'new-chat' : 'c1',
      streamingConversationIds: idleForTarget
        ? []
        : [runningNewChat ? 'new-chat' : 'c1'],
      conversations: twoClaudeChats
        ? [
            { id: 'claude-a', title: 'Untitled A', updatedAt: 2, activeModel: 'alpha' },
            { id: 'claude-b', title: 'Untitled B', updatedAt: 3, activeModel: 'alpha' },
            ...(archivedReadChat
              ? [
                  {
                    id: 'claude-c',
                    title: 'Untitled C',
                    updatedAt: 4,
                    activeModel: 'alpha',
                    archived: true,
                  },
                ]
              : []),
          ]
        : closedForTarget
          ? ([] as { id: string; title: string; updatedAt: number; activeModel: string }[])
          : [
        runningNewChat
          ? { id: 'new-chat', title: 'Untitled chat', updatedAt: 3, activeModel: 'alpha' }
          : { id: 'c1', title: 'codex: task', updatedAt: 2, activeModel: 'alpha' },
      ],
      requestChains: targetChainEpoch
        ? [
            {
              conversationId: 'c1',
              userIntentEpoch: targetChainEpoch,
              stage: 'model' as const,
              managed: false,
            },
          ]
        : peerChainChat
          ? [
              {
                conversationId: 'claude-a',
                userIntentEpoch: 7,
                stage: 'model' as const,
                managed: false,
              },
            ]
          : [],
      pendingApproval: peerApprovalChat
        ? { id: 'a1', toolName: 'shell', detail: '', dangerous: false, conversationId: 'claude-b' }
        : approvalForTarget
          ? { id: 'a2', toolName: 'shell', detail: '', dangerous: false, conversationId: 'c1' }
          : undefined,
    }),
    pendingApprovalForConversation: (conversationId: string) => {
      const pending = peerApprovalChat
        ? { id: 'a1', toolName: 'shell', detail: '', dangerous: false, conversationId: 'claude-b' }
        : approvalForTarget
          ? { id: 'a2', toolName: 'shell', detail: '', dangerous: false, conversationId: 'c1' }
          : undefined;
      return pending?.conversationId === conversationId ? pending : undefined;
    },
    hasPendingQuestion: () => false,
    recentExchanges: () => [],
    getAgentLink: (conversationId: string, kind: keyof typeof links) =>
      twoClaudeChats && kind === 'claude' && conversationId === 'claude-a'
        ? links.claude
        : twoClaudeChats && kind === 'claude' && conversationId === 'claude-b'
          ? claudeBLink
          :
      conversationId === 'new-chat' && kind === 'claude'
        ? newChatLink
        : conversationId === 'c1'
          ? links[kind]
          : undefined,
    askAgent,
    showConversationNotice: vi.fn(),
    contextBudget: () => ({ used: 1_000, max: 8_000 }),
    routeInboundAgent: async (sender: { kind: string; sessionId: string }) => ({
      conversationId: 'c1',
      title: 'codex: task',
      sender: { kind: sender.kind, sessionId: sender.sessionId, title: 'Codex' },
      link: { kind: sender.kind, sessionId: sender.sessionId, title: 'Codex' },
    }),
    showConversationNotice: () => undefined,
    chatCapBlockers: () => [],
    cancel: (conversationId: string) => {
      cancelled.add(conversationId);
      return Promise.resolve();
    },
    interrupt: (conversationId: string) => {
      interrupted.add(conversationId);
      return Promise.resolve();
    },
  } as unknown as ForgeHostFacade;

  const askRuntime = {
    openPanel: async () => 'unavailable' as const,
    isLive: async () => false,
    sendLive: async () => ({ status: 'failed', finalText: '', error: 'not live' }),
    runHeadless: async () => ({ status: 'failed', finalText: '', error: 'not run' }),
  } as unknown as AskAgentRuntime;

  function hosts(): AgentRouteDepsHosts {
    return {
      getFacade: () => fakeFacade,
      getConfig: () => ({ models: [{ name: 'alpha' }], profiles: {} }) as ForgeConfig,
      workspaceRoot: workspace,
      home,
      inbox: {
        accept: (prompt) => (accepts++, { position: 1, id: `m${prompt.length}` }),
        cancel: (_from, id) => (cancelled.add(id), 1),
        release: (id: string) => (released.add(id), true),
        pendingFrom: (from: string) => (from === 'carol' ? queued.count : 0),
        queuedTargetConversation: (from: string) =>
          from === 'carol' && queued.count > 0 ? queued.conversationId : undefined,
      },
      watch: new BusTurnWatch(),
      pendingReplies: new PendingAgentReplies(path.join(home, '.forge', 'agent-bus')),
      askRuntime,
      getRemoteRuntime: () =>
        ({
          sendFileToConversation: async (conversationId: string) => {
            sentTo.push(conversationId);
            return { kind: 'sent' };
          },
          remoteSessionAction: async (_from: string, _s: string, _id: string, action: string) =>
            action === 'ask' ? { kind: 'asked', questionId: 'q7' } : { kind: 'notified' },
        }) as never,
      reloadWindow: async () => undefined,
      isFocused: () => true,
    };
  }

  async function call(
    verb: string,
    request: (typeof ROUTE_FOR_VERB)[string],
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (request.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const response = await fetch(`${base}${request.path}${request.query ?? ''}`, {
      method: request.method,
      headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
    return {
      status: response.status,
      body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
    };
  }

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prod-routes-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-prod-routes-ws-'));
    paths = busPaths(home);
    logPaths = {
      log: path.join(paths.root, EXCHANGES_LOG_NAME),
      lock: path.join(paths.root, 'exchanges.lock'),
    };
    fs.mkdirSync(path.join(paths.root, 'verdicts'), { recursive: true });
    askAgent.mockClear();
    // The session index `findBySession` reads: both senders resolve to `c1`.
    rebuildIndex([
      { id: 'c1', title: 'codex: task', agentLinks: { claude: links.claude, codex: links.codex } },
    ]);
    cancelled.clear();
    interrupted.clear();
    released.clear();
    queued.count = 0;
    queued.conversationId = undefined;
    runningNewChat = false;
    twoClaudeChats = false;
    archivedReadChat = false;
    approvalForTarget = false;
    closedForTarget = false;
    idleForTarget = false;
    targetChainEpoch = undefined;
    accepts = 0;
    sentTo.length = 0;
    // Exchange `x1`: asked by codex, answered, and its full answer retained —
    // the state a `read-verdict` is meant to find.
    for (const event of [
      {
        eventId: 'start-x1',
        ts: 1,
        exchangeId: 'x1',
        workspace,
        from: 'codex',
        senderSessionId: CODEX_SESSION,
        to: 'forge',
        type: 'state',
        state: 'created' as const,
      },
      {
        eventId: 'accepted-x1',
        ts: 2,
        exchangeId: 'x1',
        workspace,
        conversation: 'c1',
        from: 'codex',
        senderSessionId: CODEX_SESSION,
        to: 'forge',
        type: 'state',
        state: 'accepted' as const,
      },
      {
        eventId: 'verdict-x1',
        ts: 3,
        exchangeId: 'x1',
        workspace,
        from: 'codex',
        senderSessionId: CODEX_SESSION,
        to: 'forge',
        type: 'verdict',
        state: 'completed' as const,
        detail: 'answer retained as verdict',
      },
    ]) {
      await appendEvent(logPaths, event);
    }
    fs.writeFileSync(verdictArtifactPath(paths.root, 'x1'), 'the full retained answer');
    routes = new AgentRoutes(buildAgentRouteDeps(hosts()));
    token = routes.token;
    server = http.createServer((req, res) => void routes.handle(req, res));
    const port = await listenLoopback(server);
    base = `http://127.0.0.1:${port}`;
    routes.setEnabled(true);
    routes.onListening(base);
  });

  afterEach(async () => {
    routes.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('reads and acknowledges a retained verdict, through the window as it is wired', async () => {
    // The identity is part of the request the client makes, not an extra this
    // test chose: the exchange below recorded `CODEX_SESSION`, and the reader
    // has to be that session.
    const read = await fetch(
      `${base}/agent/read-verdict?from=codex&id=x1&kind=codex&sessionId=${CODEX_SESSION}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('the full retained answer');
    expect(fs.existsSync(verdictArtifactPath(paths.root, 'x1'))).toBe(true);
    const ack = await call('ack-verdict', ROUTE_FOR_VERB['ack-verdict']!);
    expect(ack.status).toBe(200);
    expect(fs.existsSync(verdictArtifactPath(paths.root, 'x1'))).toBe(false);
  });

  it('registers every verb forge.sh advertises, and knows no verb it does not advertise', async () => {
    const advertised = advertisedVerbs(CLIENT_SCRIPT);
    expect(advertised.length).toBeGreaterThan(10);
    expect(Object.keys(ROUTE_FOR_VERB).sort()).toEqual(advertised);
    // Called in table order, not alphabetical, so `read-verdict` sees the
    // artifact before `ack-verdict` removes it.
    for (const verb of Object.keys(ROUTE_FOR_VERB)) {
      const request = ROUTE_FOR_VERB[verb]!;
      const response = await call(verb, request);
      const error = typeof response.body['error'] === 'string' ? response.body['error'] : '';
      expect(error, `${verb}: ${error}`).not.toMatch(/^no route for/u);
      expect(
        [200, 202, 400, 409, 502],
        `${verb} answered ${response.status} ${error}`,
      ).toContain(response.status);
    }
    expect(cancelled).toContain('c1'); // `stop` reached the addressed chat
    expect(interrupted).toContain('c1'); // `steer` reached it too
  });

  it('reports its own chats to a peer window — open and closed, and never a tab number', async () => {
    twoClaudeChats = true;
    archivedReadChat = true;
    peerChainChat = true;
    peerApprovalChat = true;
    try {
      const res = await fetch(`${base}/agent/chats`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        windowId: string;
        workspace: string;
        models: string[];
        chats: Array<Record<string, unknown>>;
      };
      expect(body.windowId).toBe(routes.windowId);
      expect(body.workspace).toBe(workspace);
      expect(Array.isArray(body.models)).toBe(true);
      // The chat holding a chain is running and carries its epoch; the one on a
      // card is flagged; the archived one is closed, so a peer `send` refuses it
      // and a peer `view` can still read it.
      expect(body.chats).toEqual([
        {
          id: 'claude-a',
          title: 'Untitled A',
          running: true,
          closed: false,
          awaitingApproval: false,
          userIntentEpoch: 7,
          model: 'alpha',
        },
        {
          id: 'claude-b',
          title: 'Untitled B',
          running: false,
          closed: false,
          awaitingApproval: true,
          model: 'alpha',
        },
        {
          id: 'claude-c',
          title: 'Untitled C',
          running: false,
          closed: true,
          awaitingApproval: false,
          model: 'alpha',
        },
      ]);
      // No `#N`: tab numbers are window-local, and a peer that guessed one would
      // steer whoever happened to hold that tab.
      expect(JSON.stringify(body)).not.toMatch(/"position"/u);
    } finally {
      twoClaudeChats = false;
      archivedReadChat = false;
      peerChainChat = false;
      peerApprovalChat = false;
    }
  });

  it('refuses a steer into a chat the owner is being asked about, interrupting nothing', async () => {
    approvalForTarget = true;
    const response = await call('steer', ROUTE_FOR_VERB['steer']!);
    // The chat was streaming, so a plain interrupt would have stopped it — and
    // taken the answer to the owner's question with it.
    expect(response.status).toBe(409);
    expect(String(response.body['error'])).toContain("waiting for the owner's approval");
    expect(String(response.body['error'])).toContain('Nothing was queued');
    expect(interrupted.size).toBe(0);
    // Refused before the inbox was asked at all: accepting can start the drain in
    // the same tick, and a message cancelled afterwards may already be the turn
    // this one was meant to replace.
    expect(accepts).toBe(0);
    approvalForTarget = false;
  });

  it('refuses a steer written against a chain that has moved on, before queuing it', async () => {
    targetChainEpoch = 9;
    const steer = ROUTE_FOR_VERB['steer']!;
    const stale = await call('steer', {
      ...steer,
      query: '?from=codex&to=forge&priority=steer&steer_epoch=5',
    });
    expect(stale.status).toBe(409);
    expect(String(stale.body['error'])).toContain('different chain');
    expect(String(stale.body['error'])).toContain('you read 5');
    expect(accepts).toBe(0);
    expect(interrupted.size).toBe(0);
    const current = await call('steer', {
      ...steer,
      query: '?from=codex&to=forge&priority=steer&steer_epoch=9',
    });
    expect(current.status).toBe(202);
    expect(accepts).toBe(1);
    expect(interrupted).toContain('c1');
    targetChainEpoch = undefined;
  });

  it('refuses a steer whose chain moved after the guard, carrying the read epoch to the interrupt', async () => {
    // The owner's own message lands after the guard read the chain and before
    // the backstop reads it: the wrapper bumps the epoch the moment the real
    // guard returns. Without the epoch carried into the interrupt, the
    // backstop would interrupt the owner's newer work and answer 202.
    targetChainEpoch = 5;
    const deps = buildAgentRouteDeps(hosts());
    const realGuard = deps.steerGuard!;
    deps.steerGuard = async (...args) => {
      const refusal = await realGuard(...args);
      targetChainEpoch = 6; // the owner's message: the chain moved
      return refusal;
    };
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
    token = routes.token; // a fresh window publishes a fresh token
    const steer = ROUTE_FOR_VERB['steer']!;
    const response = await call('steer', {
      ...steer,
      query: '?from=codex&to=forge&priority=steer&steer_epoch=5',
    });
    // The real guard and the real backstop share one `steerBlockReason`, and
    // the epoch moved between them: the backstop can only catch that if the
    // route carried the sender's epoch through the interrupt. (The fake inbox
    // fakes the cancel; a real one had never started the held message.)
    expect(response.status).toBe(409);
    expect(String(response.body['error'])).toContain('different chain');
    expect(String(response.body['error'])).toContain('you read 5');
    expect(accepts).toBe(1);
    expect(interrupted.size).toBe(0);
    expect([...released]).toEqual([]);
    targetChainEpoch = undefined;
  });

  it('refuses a steer whose chat closed between the guard and the interrupt', async () => {
    // The chat vanishes the moment the first guard returns: the backstop must
    // say so as a refusal (blocked), not release the held steer into a chat
    // nobody can see. Closed targets are blocked even though the old code
    // reached them through the streaming test, which answered them unblocked.
    const deps = buildAgentRouteDeps(hosts());
    const realGuard = deps.steerGuard!;
    deps.steerGuard = async (...args) => {
      const refusal = await realGuard(...args);
      closedForTarget = true;
      return refusal;
    };
    routes = new AgentRoutes(deps);
    routes.setEnabled(true);
    routes.onListening(base);
    token = routes.token; // a fresh window publishes a fresh token
    const response = await call('steer', ROUTE_FOR_VERB['steer']!);
    expect(response.status).toBe(409);
    expect(String(response.body['error'])).toContain('not open in this window');
    expect(String(response.body['error'])).toContain('Nothing was queued');
    expect(accepts).toBe(1);
    expect(interrupted.size).toBe(0);
    expect([...released]).toEqual([]);
    closedForTarget = false;
  });

  it('releases a steer whose chat went idle after the guard — an idle chat runs it, it does not block it', async () => {
    // Idle is NOT blocked: the steer is a message too, and with nothing to
    // interrupt the route releases the held message to run as its own turn.
    // Only a card, a moved chain, or a gone chat withdraw it.
    idleForTarget = true;
    const response = await call('steer', ROUTE_FOR_VERB['steer']!);
    expect(response.status).toBe(202);
    expect(response.body['steered']).toBe(false);
    expect(String(response.body['reason'])).toContain('not streaming');
    expect(accepts).toBe(1);
    expect(interrupted.size).toBe(0);
    expect([...released]).toEqual(['m32']); // the fake names ids by prompt length: the bus-wrapped message is 32 characters
    idleForTarget = false;
  });

  it("hands a peer window one chat's transcript, and reads nothing but the transcript", async () => {
    const res = await fetch(`${base}/agent/peer-view?conversation_id=c1&count=2`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      windowId: routes.windowId,
      workspace,
      conversationId: 'c1',
      title: 'codex: task',
      closed: false,
      // The chat is streaming here, and that is the fact the sender's `view`
      // note about a partial last entry is drawn from.
      streaming: true,
      clamped: false,
      exchanges: [],
    });
    const gone = await fetch(`${base}/agent/peer-view?conversation_id=chat-9`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({
      error:
        'Forge chat "chat-9" is not open in this window. If it is open in another Forge window, send from a session linked there.',
    });
    // Read-only by construction: no turn was stopped, cancelled or started, and
    // nothing was restored into a tab — a neighbour reading over the socket
    // cannot move the owner's window or wake an engine behind their back.
    expect(interrupted.size).toBe(0);
    expect(cancelled.size).toBe(0);
    expect(askAgent).not.toHaveBeenCalled();
  });

  it('steers a linked agent session, not only Forge (audit F2)', async () => {
    const response = await fetch(
      `${base}/agent/message?from=claude&to=codex&priority=steer&sender=${encodeURIComponent(
        JSON.stringify({ kind: 'claude', sessionId: CLAUDE_SESSION }),
      )}`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'do this instead',
      },
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      relayed: true,
      exchangeId: expect.any(String),
      delivered_to: 'Codex link in chat c1',
    });
    expect(body.note).toBeUndefined(); // nothing was in flight to withdraw
    await vi.waitFor(() =>
      expect(askAgent).toHaveBeenCalledWith(
        'c1',
        { agent: 'codex', message: 'do this instead' },
        expect.any(AbortSignal),
      ),
    );
    // The registry's CI row: an answered relay leaves nothing in flight. The
    // entry is only removed in the `finally` after the answer has been recorded
    // (two `appendEvent` writes and the reply delivery are awaited first), so
    // the moment `askAgent` is called it can legitimately still be there —
    // under parallel CI load that is exactly when the first poll lands, which
    // is what made this row fail in full CI. Poll for the invariant instead of
    // assuming one poll interval is long enough.
    await vi.waitFor(() => expect(inFlightRelayCount()).toBe(0));
    // A steer needs the session, not a name: with no sender there is no chat
    // whose in-flight request could be withdrawn, so it is refused outright
    // instead of being queued behind the request it was meant to replace.
    const nameOnly = await fetch(
      `${base}/agent/message?from=codex&to=claude&priority=steer`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
        body: 'do this instead',
      },
    );
    expect(nameOnly.status).toBe(400);
    expect((await nameOnly.json()).error).toContain('no relay available');
  });

  it('shows a sender whose message is queued with no chat yet (audit F3)', async () => {
    // `say --new` answers 202 and reports the message is queued, but the chat
    // it opens does not exist until the message runs. `status` resolved a
    // sender only from recorded exchanges, so it answered 404 — and
    // `forge.sh wait`, which polls this very endpoint, reads a refused
    // request as a dead endpoint and exits 1, abandoning the queue it had been
    // told to wait for.
    queued.count = 1;
    const response = await fetch(`${base}/agent/status?from=carol`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('State: queued');
    expect(text).toContain('Queued from you: 1');
  });

  it('resolves a queued message to the chat it was routed into (audit F3)', async () => {
    // The other half of F3: a first message `--to` a chat that is open and
    // busy with someone else's turn. The chat exists, so status can report it
    // — but only from the queue, because the sender's own message has not run
    // and no exchange records it yet.
    queued.count = 2;
    queued.conversationId = 'c1';
    const response = await fetch(`${base}/agent/status?from=carol`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('Chat: codex: task · c1');
    expect(text).toContain('State: busy');
    expect(text).toContain('Queued from you: 2');
  });

  it('reads a linked sender chat while its first --new turn is running and reports its link', async () => {
    // Before its first answer is recorded, an --new chat can still be Untitled.
    // The accepted message has left the inbox, so neither the transcript nor
    // queue identifies it; the persisted session link is the remaining owner.
    runningNewChat = true;
    rebuildIndex([
      { id: 'new-chat', title: 'Untitled chat', agentLinks: { claude: newChatLink } },
    ]);

    const status = await fetch(`${base}/agent/status?from=claude`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status.status).toBe(200);
    expect(await status.text()).toContain('Chat: Untitled chat · new-chat');

    const view = await fetch(`${base}/agent/view?from=claude`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(view.status).toBe(200);
    expect(await view.text()).toContain('No answers in this chat yet.');

    const who = await fetch(`${base}/agent/who`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(who.status).toBe(200);
    expect(await who.json()).toMatchObject({
      participants: [
        expect.objectContaining({ session: 'claude · Claude', attachment: 'linked' }),
      ],
    });
  });

  it('resolves session-specific Claude reads to that session link before name recency', async () => {
    twoClaudeChats = true;
    rebuildIndex([
      { id: 'claude-a', title: 'Untitled A', agentLinks: { claude: links.claude } },
      { id: 'claude-b', title: 'Untitled B', agentLinks: { claude: claudeBLink } },
    ]);
    const read = async (endpoint: 'status' | 'view', sessionId?: string) => {
      const identity = sessionId ? `&kind=claude&sessionId=${sessionId}` : '';
      return fetch(`${base}/agent/${endpoint}?from=claude${identity}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    };
    for (const endpoint of ['status', 'view'] as const) {
      const a = await read(endpoint, CLAUDE_SESSION);
      expect(a.status).toBe(200);
      expect(await a.text()).toContain(endpoint === 'status' ? 'Untitled A · claude-a' : 'No answers');
      const b = await read(endpoint, CLAUDE_SESSION_B);
      expect(b.status).toBe(200);
      expect(await b.text()).toContain(endpoint === 'status' ? 'Untitled B · claude-b' : 'No answers');
      const legacy = await read(endpoint);
      expect(legacy.status).toBe(200);
      expect(await legacy.text()).toContain(endpoint === 'status' ? 'Untitled B · claude-b' : 'No answers');
    }
    const mismatch = await fetch(`${base}/agent/status?from=codex&kind=claude&sessionId=${CLAUDE_SESSION}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(mismatch.status).toBe(400);
  });

  it('status, view and send-file --to reach only a chat linked to the sender session', async () => {
    // `--to <conversationId>` names a chat outright. It has to be one this
    // window has open and one the caller's own session is linked to: otherwise
    // a session holding two chats could read the other one's status, or drop a
    // file into another session's chat.
    const sendFileTo = (from: string, sessionId: string, conversationId: string) =>
      fetch(`${base}/agent/send-file`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: [
          `from=${from}`,
          `sender_kind=${from}`,
          `sender_session_id=${sessionId}`,
          `conversation_id=${conversationId}`,
          'path=notes.txt',
        ].join('&'),
      });
    const errorOf = async (response: Response) =>
      ((await response.json()) as { error?: string }).error ?? '';

    // In the one-chat fixture: the chat named is the chat delivered to.
    const toOwn = await sendFileTo('codex', CODEX_SESSION, 'c1');
    expect(toOwn.status).toBe(200);
    expect(await toOwn.json()).toEqual({ sent: true });
    expect(sentTo).toEqual(['c1']);

    twoClaudeChats = true;
    archivedReadChat = true;
    rebuildIndex([
      { id: 'claude-a', title: 'Untitled A', agentLinks: { claude: links.claude } },
      { id: 'claude-b', title: 'Untitled B', agentLinks: { claude: claudeBLink } },
    ]);
    sentTo.length = 0;

    const read = (
      endpoint: 'status' | 'view',
      sessionId: string | undefined,
      conversationId: string,
    ) =>
      fetch(
        `${base}/agent/${endpoint}?from=claude${
          sessionId ? `&kind=claude&sessionId=${sessionId}` : ''
        }&conversation_id=${encodeURIComponent(conversationId)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

    for (const endpoint of ['status', 'view'] as const) {
      const linked = await read(endpoint, CLAUDE_SESSION, 'claude-a');
      expect(linked.status).toBe(200);
      expect(await linked.text()).toContain(
        endpoint === 'status' ? 'Untitled A · claude-a' : 'No answers',
      );

      const otherSession = await read(endpoint, CLAUDE_SESSION, 'claude-b');
      expect(otherSession.status).toBe(404);
      const refusal = await errorOf(otherSession);
      expect(refusal).toContain('claude-b');
      expect(refusal).toContain("not linked to claude's session");

      const otherLinked = await read(endpoint, CLAUDE_SESSION_B, 'claude-b');
      expect(otherLinked.status).toBe(200);
      expect(await otherLinked.text()).toContain(
        endpoint === 'status' ? 'Untitled B · claude-b' : 'No answers',
      );
    }

    // `send-file --to` sends to the chat it names, not to whichever chat this
    // session last wrote to. `claude-a` is not the chat recency would pick for
    // `claude` (that is `claude-b`), yet it is linked to this session, so it is
    // accepted: the old "does not match your established chat" refusal is gone,
    // because a session that holds two chats has two established chats.
    const toSecond = await sendFileTo('claude', CLAUDE_SESSION, 'claude-a');
    expect(toSecond.status).toBe(200);
    expect(await toSecond.json()).toEqual({ sent: true });
    expect(sentTo).toEqual(['claude-a']);

    const toOtherSession = await sendFileTo('claude', CLAUDE_SESSION, 'claude-b');
    expect(toOtherSession.status).toBe(409);
    expect(await errorOf(toOtherSession)).toContain("not linked to claude's session");
    expect(sentTo).toEqual(['claude-a']); // the refused send delivered nothing

    // A closed chat is refused by name; an id that is not an id is a 400 naming
    // the field, before any chat is read at all.
    const gone = await read('status', CLAUDE_SESSION, 'claude-c');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({
      error:
        'Forge chat "claude-c" is not open in this window. If it is open in another Forge window, send from a session linked there.',
    });
    const exchangeId = await fetch(
      `${base}/agent/status?from=codex&kind=codex&sessionId=${CODEX_SESSION}&conversation_id=x1`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(exchangeId.status).toBe(404);
    expect(await exchangeId.json()).toEqual({
      error: '"x1" is an exchange id, not a chat id: its chat is --to c1',
    });
    const badId = await read('status', CLAUDE_SESSION, 'bad/chat');
    expect(badId.status).toBe(400);
    expect(await errorOf(badId)).toContain('conversation_id');

    // A caller that names a chat but supplies no session identity has nothing
    // to check the id against, so it is refused rather than trusted.
    const noSession = await fetch(`${base}/agent/status?from=claude&conversation_id=claude-a`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(noSession.status).toBe(404);
    expect(await errorOf(noSession)).toContain('claude-a');

    // The queue answer for a sender (audit F3) does not swallow an explicit
    // `--to`: the queue says nothing about the specific chat the caller named.
    queued.count = 2;
    const unlinkedWhileQueued = await read('status', CLAUDE_SESSION, 'claude-b');
    expect(unlinkedWhileQueued.status).toBe(404);
    const queuedWithoutTarget = await fetch(`${base}/agent/status?from=carol`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(queuedWithoutTarget.status).toBe(200);
    expect(await queuedWithoutTarget.text()).toContain('State: queued');
  });

  it('refuses a sender name that is not a bus name, and a stranger reading a verdict', async () => {
    const bad = await fetch(`${base}/agent/status?from=${encodeURIComponent('a'.repeat(41))}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain('from must be 1-40 chars');
    // The route is registered for a name it cannot authorize too: the verdict
    // handler answers 404 from the exchange log, not 404 "no route".
    const stranger = await fetch(`${base}/agent/read-verdict?from=carol&id=x1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(stranger.status).toBe(404);
    expect((await stranger.json()).error).toContain('verdict unavailable');
  });
});
