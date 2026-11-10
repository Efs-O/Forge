/**
 * `message_chat` against a chat in ANOTHER Forge window, end to end from the
 * tool to a real socket and back.
 *
 * The fake window is a real HTTP server on loopback, because the two things
 * worth proving here are invisible in a mock: the exact request the receiving
 * window would get (a message that names the wrong chat, or carries a
 * `priority` the sender meant as a steer, costs the owner a paid turn over
 * there), and what a refusal from that window does to the sender's caps.
 *
 * Discovery is faked, so the peer's url and token are handed over directly; the
 * endpoint-file side of it is `MessageChatPeers.test.ts`.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeConversationSummary, ForgeHostStatus } from '../../src/sidebar/ForgeHostFacade';
import type { ChatMessageDelivery } from '../../src/sidebar/backgroundExitNotice';
import type { ChatsReportChat, PeerViewReport } from '../../src/backend/agentChatReadRoute';
import type { ForgeConfig } from '../../src/config/types';
import { makeMessageChatTool, type MessageChatSidebar } from '../../src/tools/messageChatTool';
import type { PeerWindow } from '../../src/tools/messageChatPeers';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';
import { unattendedConversations } from '../../src/sidebar/unattendedConversations';

const IDLE = 'aaaa1111-1111-4111-8111-111111111111';
const RUNNING = 'bbbb1111-1111-4111-8111-111111111111';
const CLOSED = 'cccc1111-1111-4111-8111-111111111111';
const OPENED = 'dddd1111-1111-4111-8111-111111111111';

function chat(id: string, title: string, extra: Partial<ChatsReportChat> = {}): ChatsReportChat {
  return { id, title, running: false, closed: false, awaitingApproval: false, ...extra };
}

function defaultChats(): ChatsReportChat[] {
  return [
    chat(IDLE, 'Worker'),
    chat(RUNNING, 'Busy worker', { running: true, userIntentEpoch: 5 }),
    chat(CLOSED, 'Finished run', { closed: true }),
  ];
}

function hostStatus(localRunning = false, localOtherCount = 1): ForgeHostStatus {
  const conversation = (id: string, title: string): ForgeConversationSummary => ({
    id,
    title,
    activeModel: 'strata-flash',
    archived: false,
    updatedAt: 0,
    requestCount: 0,
    toolCallCount: 0,
    compactCount: 0,
    activeMs: 0,
  });
  return {
    activeConversationId: 'sender',
    conversations: [
      conversation('sender', 'Sender'),
      ...Array.from({ length: localOtherCount }, (_, index) =>
        conversation(index === 0 ? 'other' : `other-${index + 1}`, `Local worker ${index + 1}`),
      ),
    ],
    requestChains: [],
    // A test that steers a chat in THIS window needs one that is mid-turn, so the
    // local read has a real chat list behind it.
    streamingConversationIds: localRunning ? ['other'] : [],
  };
}

/** The sidebar seam, with the one local call that matters for these tests: a
 *  cross-window send must never ask the local router to deliver it. */
function makeSidebar(
  clanker = false,
  localRunning = false,
  localOtherCount = 1,
  latestPeerWriter?: { id: string; title: string },
): MessageChatSidebar & {
  deliverChatMessage: ReturnType<typeof vi.fn>;
  emitHostActivity: ReturnType<typeof vi.fn>;
} {
  const emitHostActivity = vi.fn();
  const deliverChatMessage = vi.fn(async (): Promise<ChatMessageDelivery> => ({ kind: 'turn' }));
  const createConversation = vi.fn(
    async () =>
      ({
        id: 'new-chat',
        title: 'Untitled chat',
        activeModel: null,
        archived: false,
        updatedAt: 0,
        requestCount: 0,
        toolCallCount: 0,
        compactCount: 0,
        activeMs: 0,
      }) as ForgeConversationSummary,
  );
  return {
    getHostFacade: () => ({
      status: () => hostStatus(localRunning, localOtherCount),
      getConversation: () => (latestPeerWriter ? { latestPeerWriter } : undefined),
      emitHostActivity,
      chatCapBlockers: () => [],
      createConversation,
      setConversationModel: vi.fn(),
      applyAutoTitle: vi.fn(),
      recentExchanges: () => [],
      clankerMode: () => clanker,
    }),
    emitHostActivity,
    deliverChatMessage,
  };
}

const context: ToolHandlerContext = { beforeMutate: vi.fn(), conversationId: 'sender' };

/** What the fake window received, in the shape it would read it. */
interface Received {
  method: string;
  path: string;
  query: Record<string, string>;
  body: string;
  auth: string;
}

let received: Received[] = [];
let reply: { status: number; body: string } = { status: 202, body: '{}' };
/** What the fake window answers `GET /agent/chats` with — a steer re-reads it, so
 *  a test changes the chat's state here rather than in the discovery stub. */
let chatsReport: {
  windowId: string;
  workspace: string;
  models: string[];
  chats: ChatsReportChat[];
} = {
  windowId: 'ffff0000-0000-4000-8000-000000000000',
  workspace: 'N:/repo-b',
  models: ['alpha'],
  chats: defaultChats(),
};
/** What the fake window answers `GET /agent/peer-view` with: one chat's
 *  transcript, in the shape that route is specified to hand a peer window. */
function defaultView(): PeerViewReport {
  return {
    windowId: chatsReport.windowId,
    workspace: chatsReport.workspace,
    conversationId: RUNNING,
    title: 'Busy worker',
    closed: false,
    streaming: true,
    clamped: false,
    exchanges: [{ prompt: 'Read the plan.', answer: 'I read the plan.' }],
  };
}
let viewReport: PeerViewReport = defaultView();
/** Status for that route alone, so a test can make it answer 404 or 400. */
let viewStatus = 200;

/** `drop` answers nothing and closes the socket after reading the request: the
 *  message reached the window, and the answer that would prove it did did not. */
let mode: 'answer' | 'drop' | 'drop-post' = 'answer';
let port = 0;
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: String(req.method),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body: Buffer.concat(chunks).toString('utf8'),
        auth: String(req.headers.authorization ?? ''),
      });
      if (mode === 'drop' || (mode === 'drop-post' && req.method === 'POST')) {
        req.socket?.destroy();
        return;
      }
      if (req.method === 'GET') {
        const view = url.pathname === '/agent/peer-view';
        res.writeHead(view ? viewStatus : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(view ? viewReport : chatsReport));
        return;
      }
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(resolve));
});

function peerWindow(chats: ChatsReportChat[]): PeerWindow {
  return {
    windowId: chatsReport.windowId,
    url: `http://127.0.0.1:${port}`,
    token: 'peer-token',
    workspace: chatsReport.workspace,
    models: chatsReport.models,
    chats,
  };
}

function makeCrossTool(
  options: {
    chats?: ChatsReportChat[];
    now?: () => number;
    busHere?: boolean;
    steer?: boolean;
    newChat?: boolean;
  newChatsPerHour?: number;
    clanker?: boolean;
    /** The windows discovery finds, for a test that needs more than one. */
    peers?: () => PeerWindow[];
    /** The bus folder this window would write to; a test can point it at a real
     *  folder to watch what a peer action leaves behind. */
    busRoot?: string;
    /** One chat in THIS window is mid-turn, for a steer that reads this window. */
    localRunning?: boolean;
    localOtherCount?: number;
    latestPeerWriter?: { id: string; title: string };
  } = {},
) {
  const sidebar = makeSidebar(
    options.clanker === true,
    options.localRunning === true,
    options.localOtherCount ?? 1,
    options.latestPeerWriter,
  );
  const chats = options.chats ?? defaultChats();
  const tool = makeMessageChatTool({
    getSidebar: () => sidebar,
    ...(options.now ? { now: options.now } : {}),
    getConfig: () =>
      ({
        permissions: {
          chats: {
            steer: options.steer === true,
            new_chat: options.newChat === true,
            new_chats_per_hour: options.newChatsPerHour ?? 100,
          },
        },
      }) as ForgeConfig,
    getPeerContext: () =>
      options.busHere === false
        ? undefined
        : {
            busRoot: options.busRoot ?? 'x',
            windowId: 'self-window',
            workspaceRoot: 'N:/repo-a',
          },
    discoverPeers: async () => ({
      peers: options.peers ? options.peers() : [peerWindow(chats)],
      unreachable: [],
    }),
  });
  return { tool, sidebar };
}

beforeEach(() => {
  received = [];
  reply = { status: 202, body: '{}' };
  mode = 'answer';
  viewStatus = 200;
  viewReport = defaultView();
  chatsReport = { ...chatsReport, chats: defaultChats() };
});

describe('message_chat send to a chat in another window', () => {
  it('posts it to that window by chat id and reports where it landed', async () => {
    const { tool, sidebar } = makeCrossTool();
    const result = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'Run the eval.' }, context),
    );
    expect(result).toContain('Queued in N:/repo-b');
    expect(result).toContain('"Worker"');
    expect(result).toContain('idle, so a turn starts there');
    expect(result).toContain('Do not resend');

    expect(received).toHaveLength(1);
    const post = received[0]!;
    expect(post.method).toBe('POST');
    expect(post.path).toBe('/agent/message');
    // The chat id is the whole point: without it the receiving window would
    // route by sender name and could interrupt somebody else's turn.
    expect(post.query).toEqual({
      conversation_id: IDLE,
      from_conversation: 'sender',
      from: 'peer Sender',
    });
    expect(post.auth).toBe('Bearer peer-token');
    // The prompt names the sender and its chat id, so the reply comes back to
    // this chat even after this window reloads under a new window id.
    expect(post.body).toContain('From Forge chat "Sender" (sender) in repo-a.');
    expect(post.body).toContain(`Reply with message_chat {"action":"send","to":"sender"}.`);
    expect(post.body).toContain('Run the eval.');
    // The sender's own transcript sees it go out; the receiving window mirrors
    // the inbound side itself.
    expect(sidebar.deliverChatMessage).not.toHaveBeenCalled();
    expect(sidebar.emitHostActivity).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'sender', kind: 'prompt' }),
    );
  });

  it('queues into a running peer chat without interrupting it', async () => {
    const { tool } = makeCrossTool();
    const result = String(
      await tool.handler({ action: 'send', to: RUNNING, message: 'Also this.' }, context),
    );
    expect(result).toContain('running, so it reads this at a tool round');
    // No `priority`: that is the steer request, and a send never interrupts.
    expect(received[0]!.query['priority']).toBeUndefined();
    expect(received[0]!.query['conversation_id']).toBe(RUNNING);
  });

  it('refuses an oversize message before asking the peer at all', async () => {
    const { tool } = makeCrossTool();
    const result = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'x'.repeat(16_000) }, context),
    );
    expect(result).toContain('fits 16000 characters in total');
    expect(result).toContain('nothing was queued and no counter was used');
    expect(received).toHaveLength(0);
  });

  it('counts the sender header against the bus cap, to the character', async () => {
    const { tool } = makeCrossTool();
    // One character in, and the recorded body says exactly how much of the 16,000
    // the header takes up — the budget the refusal has to quote.
    expect(
      String(await tool.handler({ action: 'send', to: IDLE, message: 'a' }, context)),
    ).toContain('Queued in');
    const budget = 16_000 - (received[0]!.body.length - 1);
    expect(budget).toBeGreaterThan(15_000);
    expect(received).toHaveLength(1);
    // Exactly the budget fits; one character more is refused before a socket.
    expect(
      String(
        await tool.handler({ action: 'send', to: IDLE, message: 'b'.repeat(budget) }, context),
      ),
    ).toContain('Queued in');
    expect(received).toHaveLength(2);
    const tooBig = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'c'.repeat(budget + 1) }, context),
    );
    expect(tooBig).toContain(`room for ${budget} of the ${budget + 1}`);
    expect(received).toHaveLength(2);
  });

  it('refuses a closed peer chat and posts nothing', async () => {
    const { tool } = makeCrossTool();
    const result = String(
      await tool.handler({ action: 'send', to: CLOSED, message: 'Report.' }, context),
    );
    expect(result).toContain('is a closed chat');
    expect(result).toContain('`view` can read it');
    expect(received).toHaveLength(0);
  });

  it('leaves nothing outstanding after a 202, so the next message is not blocked', async () => {
    const { tool } = makeCrossTool();
    const first = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'Part one.' }, context),
    );
    const second = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'Part two.' }, context),
    );
    expect(first).toContain('Queued in');
    expect(second).toContain('Queued in');
    expect(second).not.toContain('earlier send');
    // One request per call: a 202 is never retried, so nothing is delivered twice.
    expect(received).toHaveLength(2);
  });

  it('takes the counters back when that window says no, and allows the send again', async () => {
    reply = { status: 409, body: '{"error":"that chat is closed"}' };
    const { tool } = makeCrossTool();
    const refused = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'Try.' }, context),
    );
    expect(refused).toContain('that chat is closed');
    expect(refused).toContain('Nothing was queued and no counter was used');
    reply = { status: 202, body: '{}' };
    const retry = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'Try again.' }, context),
    );
    expect(retry).toContain('Queued in');
    expect(received).toHaveLength(2);
  });

  it('names the shared bus folder when that window refuses this window token', async () => {
    reply = { status: 401, body: '{"error":"bad token"}' };
    const { tool } = makeCrossTool();
    const refused = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'Try.' }, context),
    );
    expect(refused).toContain('bad token');
    expect(refused).toContain('not sharing one agent-bus folder');
    // The refused send burned nothing, so the twenty idle wakes are still available.
    reply = { status: 202, body: '{}' };
    for (let i = 0; i < 20; i++) {
      expect(
        String(await tool.handler({ action: 'send', to: IDLE, message: `n${i}` }, context)),
      ).toContain('Queued in');
    }
    expect(
      String(await tool.handler({ action: 'send', to: IDLE, message: 'twenty-first' }, context)),
    ).toContain('idle-chat-wake-per-30-min');
  }, 20_000);

  it('passes on what the peer window itself said', async () => {
    reply = { status: 404, body: '{"error":"no route for POST /agent/message"}' };
    const { tool } = makeCrossTool();
    const refused = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'Try.' }, context),
    );
    expect(refused).toContain('no route for POST /agent/message');
  });

  it('keeps the counters when the answer is lost after the message was sent', async () => {
    mode = 'drop';
    const { tool } = makeCrossTool();
    const lost = String(await tool.handler({ action: 'send', to: IDLE, message: 'Try.' }, context));
    // The bytes left this socket, so this window cannot know whether the peer
    // queued them: the honest answer is "may already be queued", not "retry".
    expect(lost).toContain('may already be queued');
    expect(lost).toContain('do not resend');
    expect(lost).not.toContain('no counter was used');
    expect(received).toHaveLength(1);
    // The lost send stayed counted, so nineteen more idle wakes fit and the
    // twentieth is refused: a refund here would let the same report be paid for twice.
    mode = 'answer';
    for (let i = 0; i < 19; i++) {
      expect(
        String(await tool.handler({ action: 'send', to: IDLE, message: `n${i}` }, context)),
      ).toContain('Queued in');
    }
    expect(
      String(await tool.handler({ action: 'send', to: IDLE, message: 'twentieth' }, context)),
    ).toContain('idle-chat-wake-per-30-min');
  }, 20_000);

  it('does not call a 2xx that is not the documented 202 a queued message', async () => {
    reply = { status: 200, body: '{}' };
    const { tool } = makeCrossTool();
    const result = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'Try.' }, context),
    );
    expect(result).not.toContain('Queued in');
    expect(result).toContain('answered 200 instead of 202');
    expect(result).toContain('may already be queued');
  });

  it('shares the idle-wake cap with the local chats', async () => {
    const at = 1_700_000_000_000;
    const { tool } = makeCrossTool({ now: () => at });
    for (let i = 0; i < 20; i++) {
      expect(
        String(await tool.handler({ action: 'send', to: IDLE, message: `wake ${i}` }, context)),
      ).toContain('Queued in');
    }
    const twentyFirst = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'one too many' }, context),
    );
    expect(twentyFirst).toContain('idle-chat-wake-per-30-min');
    // A send into a chat that is already busy is not a wake, so it still fits.
    expect(
      String(await tool.handler({ action: 'send', to: RUNNING, message: 'tell' }, context)),
    ).toContain('Queued in');
  });

  it('raises no card of its own, and still claims the untrusted exit', async () => {
    const { tool } = makeCrossTool();
    expect(
      tool.approval?.({ action: 'send', to: IDLE, message: 'x' }, { conversationId: 'sender' }),
    ).toBeUndefined();
    // The marker is what makes `untrustedExitPolicy.ts` ask the owner in a chat
    // that read a page, for a peer send exactly as for a local one.
    expect(tool.reachesOut).toBe('cross_chat');
  });

  it('says which switch would let this window ask, when the bus is off here', async () => {
    const { tool } = makeCrossTool({ busHere: false });
    const refused = String(
      await tool.handler({ action: 'send', to: IDLE, message: 'Try.' }, context),
    );
    expect(refused).toContain('agent_bus.enabled: true');
    expect(received).toHaveLength(0);
  });

  it('resolves a unique 8-character peer id prefix', async () => {
    const { tool } = makeCrossTool();
    expect(String(await tool.handler({ action: 'send', to: IDLE.slice(0, 8), message: 'Prefix.' }, context))).toContain('Queued in N:/repo-b');
    expect(received.find((entry) => entry.method === 'POST')?.query).toEqual({
      conversation_id: IDLE,
      from_conversation: 'sender',
      from: 'peer Sender',
    });
  });

  it('refuses a shared peer id prefix with the exact peer list and local chat list', async () => {
    const first = 'aaaa1111-1111-4111-8111-111111111111';
    const second = 'aaaa1111-2222-4222-8222-222222222222';
    const peers = [
      { ...peerWindow([chat(first, 'One')]), windowId: '11111111-1111-4111-8111-111111111111', workspace: 'N:/one' },
      { ...peerWindow([chat(second, 'Two')]), windowId: '22222222-2222-4222-8222-222222222222', workspace: 'N:/two' },
    ];
    const { tool } = makeCrossTool({ peers: () => peers });
    const result = String(await tool.handler({ action: 'send', to: 'aaaa1111', message: 'Ambiguous.' }, context));
    expect(result).toBe(
      'Error: "aaaa1111" starts the id of more than one chat in other windows: ' +
        `${first} in one (11111111); ${second} in two (22222222). Pass the full id.\n\n` +
        'Chats in this window (you are #1):\n#1 · Sender · idle · strata-flash · id sender ← you\n' +
        '#2 · Local worker 1 · idle · strata-flash · id other\n' +
        'send: {"action":"send","to":"#2","message":"…"} — or omit "to" to reach the only other running chat.',
    );
    expect(received).toHaveLength(0);
  });

  it('keeps a 7-character peer prefix and local-only references out of peer windows', async () => {
    const { tool, sidebar } = makeCrossTool();
    await tool.handler({ action: 'send', to: IDLE.slice(0, 7), message: 'Short.' }, context);
    await tool.handler({ action: 'send', to: '#2', message: 'Local.' }, context);
    await tool.handler({ action: 'send', to: 'Worker', message: 'Title.' }, context);
    expect(received).toHaveLength(0);
    expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(2);
  });

  it('answers a recorded peer writer when local omitted resolution refuses', async () => {
    const { tool } = makeCrossTool({
      localOtherCount: 6,
      latestPeerWriter: { id: IDLE, title: 'Worker' },
    });
    expect(String(await tool.handler({ action: 'send', message: 'Reply.' }, context))).toContain('Queued in N:/repo-b');
    expect(received.find((entry) => entry.method === 'POST')?.query).toEqual({
      conversation_id: IDLE,
      from_conversation: 'sender',
      from: 'peer Sender',
    });
  });

  it('treats blank to like omitted for a recorded peer writer', async () => {
    const { tool } = makeCrossTool({
      localOtherCount: 6,
      latestPeerWriter: { id: IDLE, title: 'Worker' },
    });
    expect(String(await tool.handler({ action: 'send', to: '', message: 'Blank to.' }, context))).toContain('Queued in N:/repo-b');
    expect(received[0]?.query).toEqual({
      conversation_id: IDLE,
      from_conversation: 'sender',
      from: 'peer Sender',
    });
  });

  it('prefers the unique running local chat over a recorded peer writer', async () => {
    const { tool, sidebar } = makeCrossTool({
      localRunning: true,
      latestPeerWriter: { id: IDLE, title: 'Worker' },
    });
    await tool.handler({ action: 'send', message: 'Local reply.' }, context);
    expect(sidebar.deliverChatMessage).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(0);
  });

  it('refuses an unreachable recorded peer writer exactly like its full id', async () => {
    const { tool } = makeCrossTool({
      localOtherCount: 6,
      latestPeerWriter: { id: IDLE, title: 'Worker' },
      peers: () => [],
    });
    expect(String(await tool.handler({ action: 'send', message: 'Reply.' }, context))).toBe(
      `Error: No open chat matches "${IDLE}". Choose a chat by its id, tab number (#N), or title words.\n\n` +
        'Chats in this window (you are #1):\n' +
        '#1 · Sender · idle · strata-flash · id sender ← you\n' +
        '#2 · Local worker 1 · idle · strata-flash · id other\n' +
        '#3 · Local worker 2 · idle · strata-flash · id other-2\n' +
        '#4 · Local worker 3 · idle · strata-flash · id other-3\n' +
        '#5 · Local worker 4 · idle · strata-flash · id other-4\n' +
        '#6 · Local worker 5 · idle · strata-flash · id other-5\n' +
        '#7 · Local worker 6 · idle · strata-flash · id other-6\n' +
        'send: {"action":"send","to":"#2","message":"…"} — or omit "to" to reach the only other running chat.',
    );
  });

  it('uses a recorded peer writer for omitted steer after local omission refuses', async () => {
    reply = { status: 202, body: '{"steered":false,"reason":"idle"}' };
    const { tool } = makeCrossTool({
      steer: true,
      localOtherCount: 6,
      latestPeerWriter: { id: IDLE, title: 'Worker' },
    });
    expect(String(await tool.handler({ action: 'steer', message: 'Continue.' }, context))).toContain('Steered "Worker"');
    expect(received.find((entry) => entry.method === 'POST')?.query).toEqual({
      conversation_id: IDLE,
      from_conversation: 'sender',
      from: 'peer Sender',
      priority: 'steer',
    });
  });
});
describe('message_chat steer to a chat in another window', () => {
  const steer = async (
    tool: { handler(a: object, c: ToolHandlerContext): Promise<unknown> },
    to: string,
    message: string,
  ) => String(await tool.handler({ action: 'steer', to, message }, context));
  const posts = () => received.filter((entry) => entry.method === 'POST');

  it('interrupts a running peer chat and puts the text next in its queue', async () => {
    reply = {
      status: 202,
      body: `{"steered":true,"conversationId":"${RUNNING}","title":"Busy worker"}`,
    };
    const { tool, sidebar } = makeCrossTool({ steer: true });
    const result = await steer(tool, RUNNING, 'Stop and write the tests instead.');
    expect(result).toContain('Interrupted "Busy worker" in N:/repo-b');
    expect(result).toContain('front of its queue');
    expect(posts()).toHaveLength(1);
    // `priority=steer` is what makes the other window stop its turn; the chat id
    // is what makes sure it is THIS chat whose turn it stops.
    expect(posts()[0]!.query).toEqual({
      conversation_id: RUNNING,
      from_conversation: 'sender',
      from: 'peer Sender',
      priority: 'steer',
      steer_epoch: '5',
    });
    // The chain this decision was read against travels with it, so the receiving
    // window can refuse rather than interrupt work this window never saw.
    expect(posts()[0]!.query['steer_epoch']).toBe('5');
    expect(posts()[0]!.body).toContain('Stop and write the tests instead.');
    expect(sidebar.deliverChatMessage).not.toHaveBeenCalled();
  });

  it('reports an idle peer chat as started, and counts it as a wake', async () => {
    reply = { status: 202, body: '{"steered":false,"reason":"no Forge turn was stopped"}' };
    const { tool } = makeCrossTool({ steer: true });
    const result = await steer(tool, IDLE, 'Start with the parser.');
    expect(result).toContain('Steered "Worker" in N:/repo-b (idle)');
    expect(result).toContain('started a turn there');
    // A steer that starts a turn is a wake, so it burns the same twenty as a send.
    reply = { status: 202, body: '{}' };
    for (let i = 0; i < 19; i++) {
      expect(
        String(await tool.handler({ action: 'send', to: IDLE, message: `n${i}` }, context)),
      ).toContain('Queued in');
    }
    expect(
      String(await tool.handler({ action: 'send', to: IDLE, message: 'twentieth' }, context)),
    ).toContain('idle-chat-wake-per-30-min');
  });

  it('keeps the loop memory of a chat it did not steer next', async () => {
    let clock = 1_700_000_000_000;
    reply = { status: 202, body: '{"steered":true}' };
    const { tool } = makeCrossTool({ steer: true, now: () => clock });
    expect(await steer(tool, RUNNING, 'First.')).toContain('Interrupted');
    // A steer re-reads the one chat it is aimed at, so that read is the only
    // witness allowed to forget — and it must forget just that chat. The first
    // chat is still mid-turn over there, and forgetting it would let this chat
    // steer it again on the same chain it was already steering.
    clock += 3 * 60_000;
    reply = { status: 202, body: '{"steered":false,"reason":"no Forge turn was stopped"}' };
    expect(await steer(tool, IDLE, 'Other.')).toContain('Steered "Worker" in N:/repo-b (idle)');
    clock += 3 * 60_000;
    reply = { status: 202, body: '{"steered":true}' };
    expect(await steer(tool, RUNNING, 'Third.')).toContain('refusing a steer loop');
    // The refusal is the point, and it came before the third post.
    expect(posts()).toHaveLength(2);
  });

  it('refuses a 202 that never said whether the turn was interrupted', async () => {
    reply = { status: 202, body: '{}' };
    const { tool } = makeCrossTool({ steer: true });
    const result = await steer(tool, RUNNING, 'Stop.');
    // A window that answers a steer the way it answers a plain send cannot be
    // reported as either outcome: the sender cannot tell an interruption from a
    // message that queued behind the running turn.
    expect(result).toContain('without saying whether your turn was interrupted');
    expect(result).toContain('do not resend');
    expect(result).not.toContain('Steered');
    // Uncertain, so the cooldown stays: a second steer cannot interrupt twice.
    reply = { status: 202, body: '{"steered":true}' };
    expect(await steer(tool, RUNNING, 'Again.')).toContain('steered too recently');
    expect(posts()).toHaveLength(1);
  });

  it('refuses a steer at the wake cap before asking the peer, when the chat looked busy', async () => {
    // The wake is reserved before the message leaves. A steer that checked the cap
    // only when its snapshot said idle could spend a twenty-first slot on a stale
    // "it is running" — and the cap is what bounds paid turns.
    const { tool } = makeCrossTool({ steer: true });
    reply = { status: 202, body: '{}' };
    for (let i = 0; i < 20; i++) {
      expect(
        String(await tool.handler({ action: 'send', to: IDLE, message: `n${i}` }, context)),
      ).toContain('Queued in');
    }
    reply = { status: 202, body: '{"steered":true}' };
    expect(await steer(tool, RUNNING, 'Stop.')).toContain('idle-chat-wake-per-30-min');
    expect(posts()).toHaveLength(20);
  });

  it('hands the reserved wake back when that window proves the chat was already busy', async () => {
    reply = { status: 202, body: '{"steered":true}' };
    const { tool } = makeCrossTool({ steer: true });
    expect(await steer(tool, RUNNING, 'Stop.')).toContain('Interrupted');
    // Nothing was added, so all twenty wakes are still there for idle chats.
    reply = { status: 202, body: '{}' };
    for (let i = 0; i < 20; i++) {
      expect(
        String(await tool.handler({ action: 'send', to: IDLE, message: `n${i}` }, context)),
      ).toContain('Queued in');
    }
    expect(
      String(await tool.handler({ action: 'send', to: IDLE, message: 'twenty-first' }, context)),
    ).toContain('idle-chat-wake-per-30-min');
  });

  it('keeps the reserved wake when that window says nothing was stopped', async () => {
    // A chat the list said running, which that window answers was idle: a turn
    // started, so the wake it reserved is the turn it pays for.
    reply = { status: 202, body: '{"steered":false,"reason":"no Forge turn was stopped"}' };
    const { tool } = makeCrossTool({ steer: true });
    expect(await steer(tool, RUNNING, 'Start anyway.')).toContain('(idle)');
    reply = { status: 202, body: '{}' };
    for (let i = 0; i < 19; i++) {
      expect(
        String(await tool.handler({ action: 'send', to: IDLE, message: `n${i}` }, context)),
      ).toContain('Queued in');
    }
    expect(
      String(await tool.handler({ action: 'send', to: IDLE, message: 'twentieth' }, context)),
    ).toContain('idle-chat-wake-per-30-min');
  });

  it('keeps a peer chat’s loop memory across a steer to a chat in this window', async () => {
    let clock = 1_700_000_000_000;
    reply = { status: 202, body: '{"steered":true}' };
    const { tool, sidebar } = makeCrossTool({
      steer: true,
      now: () => clock,
      localRunning: true,
    });
    expect(await steer(tool, RUNNING, 'Peer first.')).toContain('Interrupted');
    // A steer to a chat in THIS window reads this window's chat list, and that
    // list never names a chat it does not hold — so it may not forget that a chat
    // in another window is still on this chat's steered turn.
    clock += 3 * 60_000;
    sidebar.deliverChatMessage.mockResolvedValue({ kind: 'tell' });
    expect(
      String(
        await tool.handler({ action: 'steer', to: 'other', message: 'Local second.' }, context),
      ),
      // The local wording, not the peer's: this steer went through the sidebar.
    ).toContain('delivered to');
    clock += 3 * 60_000;
    reply = { status: 202, body: '{"steered":true}' };
    expect(await steer(tool, RUNNING, 'Peer third.')).toContain('refusing a steer loop');
    // Only the first peer steer was posted: the local one went through the
    // sidebar, and the loop refusal stopped the third before it left.
    expect(posts()).toHaveLength(1);
  });

  it('refuses a 202 whose answer is not a real yes or no', async () => {
    // `"false"` and `null` are neither outcome: read as `false` they report an
    // idle chat that was not idle, and read as `true` an interruption that never
    // happened. Both stay uncertain, with the counters burned.
    for (const body of ['{"steered":"false"}', '{"steered":null}', '{}']) {
      reply = { status: 202, body };
      const { tool } = makeCrossTool({ steer: true });
      const result = await steer(tool, RUNNING, 'Stop.');
      expect(result, body).toContain('without saying whether your turn was interrupted');
      expect(result, body).toContain('do not resend');
    }
  });

  it('refuses a peer chat that is waiting for the owner, and posts nothing', async () => {
    chatsReport = {
      ...chatsReport,
      chats: [chat(RUNNING, 'Busy worker', { running: true, awaitingApproval: true })],
    };
    const { tool } = makeCrossTool({ steer: true });
    const result = await steer(tool, RUNNING, 'Any of these.');
    expect(result).toContain("is waiting for the owner's approval");
    expect(posts()).toHaveLength(0);
  });

  it('refuses a closed peer chat and posts nothing', async () => {
    const { tool } = makeCrossTool({ steer: true });
    const result = await steer(tool, CLOSED, 'Report.');
    expect(result).toContain('is a closed chat');
    expect(posts()).toHaveLength(0);
  });

  it('keeps the per-target gap across windows', async () => {
    reply = { status: 202, body: '{"steered":true}' };
    const { tool } = makeCrossTool({ steer: true });
    expect(await steer(tool, RUNNING, 'First.')).toContain('Interrupted');
    const second = await steer(tool, RUNNING, 'Second.');
    expect(second).toContain('steered too recently');
    expect(posts()).toHaveLength(1);
  });

  it('refuses a steer loop across windows on the peer’s own epoch', async () => {
    let clock = 1_700_000_000_000;
    reply = { status: 202, body: '{"steered":true}' };
    const { tool } = makeCrossTool({ steer: true, now: () => clock });
    expect(await steer(tool, RUNNING, 'First.')).toContain('Interrupted');
    // Past the two-minute gap, and still on the turn the first steer started:
    // the chain epoch in the peer's fresh report is what says so.
    clock += 3 * 60_000;
    expect(await steer(tool, RUNNING, 'Second.')).toContain('refusing a steer loop');
    expect(posts()).toHaveLength(1);
  });

  it('keeps the cooldown when the steer answer is lost', async () => {
    mode = 'drop-post';
    const { tool } = makeCrossTool({ steer: true });
    const lost = await steer(tool, RUNNING, 'Stop.');
    expect(lost).toContain('may already be queued');
    expect(lost).toContain('do not resend');
    expect(lost).toContain('stays counted against your caps');
    // The cooldown stayed, so a second steer cannot interrupt twice.
    mode = 'answer';
    reply = { status: 202, body: '{"steered":true}' };
    expect(await steer(tool, RUNNING, 'Again.')).toContain('steered too recently');
    expect(posts()).toHaveLength(1);
  });

  it('keeps the send and wake counters when a steer to an idle peer chat is lost', async () => {
    mode = 'drop-post';
    const { tool } = makeCrossTool({ steer: true });
    const lost = await steer(tool, IDLE, 'Start.');
    expect(lost).toContain('may already be queued');
    expect(lost).toContain('do not resend');
    // A steer that burned a wake is still counted: nineteen more idle wakes fit
    // and the twentieth is refused. A refund here would let one chat pay twice for
    // an interruption it may already have caused over there.
    mode = 'answer';
    for (let i = 0; i < 19; i++) {
      expect(
        String(await tool.handler({ action: 'send', to: IDLE, message: `n${i}` }, context)),
      ).toContain('Queued in');
    }
    expect(
      String(await tool.handler({ action: 'send', to: IDLE, message: 'twentieth' }, context)),
    ).toContain('idle-chat-wake-per-30-min');
  }, 20_000);

  it('asks the owner before a peer steer, and not when that chat is armed', async () => {
    const { tool } = makeCrossTool({ steer: true });
    expect(
      tool.approval?.({ action: 'steer', to: RUNNING, message: 'x' }, { conversationId: 'sender' }),
    ).toEqual({
      detail: 'Allow this chat to interrupt another chat and send it a steering message?',
      dangerous: true,
    });
    const armed = makeCrossTool({ steer: true, clanker: true });
    expect(
      armed.tool.approval?.(
        { action: 'steer', to: RUNNING, message: 'x' },
        { conversationId: 'sender' },
      ),
    ).toBeUndefined();
  });
});

describe('message_chat new in another window', () => {
  const open = async (
    tool: { handler(a: object, c: ToolHandlerContext): Promise<unknown> },
    args: Record<string, unknown>,
  ) => String(await tool.handler({ action: 'new', ...args }, context));
  const posts = () => received.filter((entry) => entry.method === 'POST');

  it('opens the chat there on this chat’s own model, and reports the id it answers with', async () => {
    // The peer has to have this chat's model, or the worker it opens would load
    // a second engine beside the one this chat is already talking through.
    chatsReport = { ...chatsReport, models: ['alpha', 'strata-flash'] };
    reply = {
      status: 202,
      body: JSON.stringify({
        queued: 1,
        id: 'm1',
        conversationId: OPENED,
        title: 'Sender: Open the phase.',
      }),
    };
    const { tool } = makeCrossTool({ newChat: true });
    const result = await open(tool, { window: 'repo-b', message: 'Open the phase.' });
    const sent = posts()[0];
    // One call, and it says everything the other window needs to open, pin and
    // name the chat before its first message runs.
    expect(sent?.query).toEqual({
      new_chat: 'true',
      from_conversation: 'sender',
      model: 'strata-flash',
      title: 'Sender: Open the phase.',
      from: 'peer Sender',
    });
    expect(sent?.body).toContain('Open the phase.');
    expect(result).toContain(`Opened "Sender: Open the phase." (${OPENED}) in N:/repo-b`);
    expect(result).toContain('model strata-flash');
  });

  it('carries an unattended sender job through peer send and new requests', async () => {
    chatsReport = { ...chatsReport, models: ['alpha', 'strata-flash'] };
    const marker = unattendedConversations.mark('sender', {
      jobId: 'nightly-job',
      jobName: 'Nightly review',
    });
    try {
      const { tool } = makeCrossTool({ newChat: true });
      await tool.handler({ action: 'send', to: IDLE, message: 'Send this.' }, context);
      expect(posts()[0]?.query).toEqual({
        conversation_id: IDLE,
        from_conversation: 'sender',
        from: 'peer Sender',
        unattended: 'true',
        job_id: 'nightly-job',
        job_name: 'Nightly review',
      });

      await tool.handler({ action: 'new', window: 'repo-b', message: 'Open this.' }, context);
      expect(posts()[1]?.query).toEqual({
        new_chat: 'true',
        from_conversation: 'sender',
        from: 'peer Sender',
        model: 'strata-flash',
        title: 'Sender: Open this.',
        unattended: 'true',
        job_id: 'nightly-job',
        job_name: 'Nightly review',
      });
    } finally {
      marker.dispose();
    }
  });

  it('refuses a model that window does not have, naming its list, and posts nothing', async () => {
    chatsReport = { ...chatsReport, models: ['alpha'] };
    const { tool } = makeCrossTool({ newChat: true });
    const refused = await open(tool, { window: 'repo-b', message: 'Go.' });
    expect(refused).toContain('has no model "strata-flash"');
    expect(refused).toContain('alpha');
    expect(refused).toContain('no counter was used');
    expect(posts()).toHaveLength(0);
  });

  it('accepts a model only that window has, and names it to that window', async () => {
    // This window's config is not the arbiter of a chat it will never run: a
    // worker model configured over there is one this supervisor can ask for, and
    // refusing it here would say so before anything was posted.
    chatsReport = { ...chatsReport, models: ['only-there'] };
    reply = { status: 202, body: JSON.stringify({ conversationId: OPENED, title: 'Worker' }) };
    const { tool } = makeCrossTool({ newChat: true });
    const result = await open(tool, { window: 'repo-b', message: 'Go.', model: 'only-there' });
    expect(result).toContain('Opened');
    expect(posts()[0]?.query['model']).toBe('only-there');
  });

  it('burns the new-chat cap once, and gives it back when that window says no', async () => {
    chatsReport = { ...chatsReport, models: ['alpha', 'strata-flash'] };
    reply = {
      status: 409,
      body: JSON.stringify({ error: 'Forge cannot open a new chat — 7 running a turn' }),
    };
    const { tool } = makeCrossTool({ newChat: true, newChatsPerHour: 2, now: () => 1_700_000_000_000 });
    const refused = await open(tool, { window: 'repo-b', message: 'One.' });
    expect(refused).toContain('7 running a turn');
    expect(refused).toContain('no counter was used');
    // The same window cap a local `new` has: the refund above spent no slot, so
    // two chats open and the third is the one that runs out.
    reply = { status: 202, body: JSON.stringify({ conversationId: OPENED, title: 'Worker' }) };
    expect(await open(tool, { window: 'repo-b', message: 'Two.' })).toContain('Opened');
    expect(await open(tool, { window: 'repo-b', message: 'Three.' })).toContain('Opened');
    expect(await open(tool, { window: 'repo-b', message: 'Four.' })).toContain(
      'new-chat-per-30-min limit',
    );
    expect(posts()).toHaveLength(3);
  });

  it('keeps the counters when that window never confirmed the chat it opened', async () => {
    chatsReport = { ...chatsReport, models: ['alpha', 'strata-flash'] };
    mode = 'drop-post';
    const { tool } = makeCrossTool({ newChat: true });
    const lost = await open(tool, { window: 'repo-b', message: 'Go.' });
    // The request reached it, so a chat may be sitting there with a name this
    // window never got back: the honest answer is to look, not to open again.
    expect(lost).toContain('did not confirm the new chat');
    expect(lost).toContain('do not resend');
    expect(lost).toContain('new-chat counter stays used');
  });

  it('reports a chat opened by an older window that cannot name it yet', async () => {
    chatsReport = { ...chatsReport, models: ['alpha', 'strata-flash'] };
    reply = { status: 202, body: JSON.stringify({ queued: 1, id: 'm1' }) };
    const { tool } = makeCrossTool({ newChat: true });
    const result = await open(tool, { window: 'repo-b', message: 'Go.' });
    expect(result).toContain('Opened a new chat in N:/repo-b');
    expect(result).not.toContain('undefined');
  });

  it('refuses a window name that fits two windows, naming both', async () => {
    const { tool } = makeCrossTool({
      newChat: true,
      peers: () => [
        peerWindow(defaultChats()),
        { ...peerWindow(defaultChats()), windowId: 'ffff0000-0000-4000-8000-000000000001' },
      ],
    });
    const refused = await open(tool, { window: 'repo-b', message: 'Go.' });
    expect(refused).toContain('matches more than one window');
    expect(refused).toContain('ffff0000');
    expect(posts()).toHaveLength(0);
  });

  it('names the windows it can see when none of them matches', async () => {
    const { tool } = makeCrossTool({ newChat: true });
    const refused = await open(tool, { window: 'nowhere', message: 'Go.' });
    expect(refused).toContain('no other Forge window matches "nowhere"');
    expect(refused).toContain('repo-b');
    expect(posts()).toHaveLength(0);
  });

  it('says which switch would let this window ask, when the bus is off here', async () => {
    const { tool } = makeCrossTool({ newChat: true, busHere: false });
    const refused = await open(tool, { window: 'repo-b', message: 'Go.' });
    expect(refused).toContain('agent_bus.enabled: true');
    expect(posts()).toHaveLength(0);
  });

  it('still opens the chat here when no window is named', async () => {
    const { tool } = makeCrossTool({ newChat: true });
    expect(await open(tool, { message: 'Local worker.' })).toContain('Opened');
    expect(posts()).toHaveLength(0);
  });
});

describe('message_chat view of a chat in another window', () => {
  const view = async (
    tool: { handler(a: object, c: ToolHandlerContext): Promise<unknown> },
    to: string,
  ) => String(await tool.handler({ action: 'view', to }, context));
  const gets = () => received.filter((entry) => entry.method === 'GET');
  const posts = () => received.filter((entry) => entry.method === 'POST');

  it('reads the transcript there and renders it like a local one', async () => {
    const { tool, sidebar } = makeCrossTool();
    const result = await view(tool, RUNNING);
    // Named from the answer, not from the chat list this was aimed by.
    expect(result).toContain('View of "Busy worker" in N:/repo-b');
    expect(result).toContain(`(id ${RUNNING})`);
    expect(result).toContain('Read the plan.');
    expect(result).toContain('I read the plan.');
    // The two facts that decide the format travel with the transcript, so the
    // sender does not guess whether a turn is still writing the last entry.
    expect(result).toContain('a turn is running; the last entry may be partial');
    // Nothing was cut, and the answer says so only because that was measured.
    expect(result).not.toContain('the maximum');
    const asked = gets()[0];
    expect(asked?.path).toBe('/agent/peer-view');
    expect(asked?.query['conversation_id']).toBe(RUNNING);
    expect(asked?.query['count']).toBe('10');
    // A read: nothing is posted, and the local router is never asked.
    expect(posts()).toHaveLength(0);
    expect(sidebar.deliverChatMessage).not.toHaveBeenCalled();
    // Repeating it burns nothing, so a supervisor can watch as often as it likes.
    expect(await view(tool, RUNNING)).toContain('I read the plan.');
    expect(await view(tool, RUNNING)).toContain('I read the plan.');
  });

  it('marks a closed chat closed, as a local view does', async () => {
    viewReport = { ...viewReport, closed: true, streaming: false };
    const { tool } = makeCrossTool();
    const result = await view(tool, RUNNING);
    expect(result).toContain('(id ' + RUNNING + ', closed)');
    // Nothing can be mid-turn in a chat that is not open, however the window
    // that lost the tab answered.
    expect(result).not.toContain('a turn is running');
  });

  it('passes on that window’s reason when the chat is not there', async () => {
    viewStatus = 404;
    viewReport = {
      error: `Forge chat "${RUNNING}" is no longer open`,
    } as unknown as PeerViewReport;
    const { tool } = makeCrossTool();
    const result = await view(tool, RUNNING);
    expect(result).toContain('could not be read');
    expect(result).toContain('is no longer open');
    expect(result).toContain('Nothing was sent and no counter was used');
    expect(posts()).toHaveLength(0);
  });

  it('reports a transcript it cannot read instead of throwing at the caller', async () => {
    viewReport = { title: 42 } as unknown as PeerViewReport;
    const { tool } = makeCrossTool();
    expect(await view(tool, RUNNING)).toContain('could not be read');
  });

  it('says when the other window had to cut the list short', async () => {
    viewReport = {
      ...viewReport,
      clamped: true,
      exchanges: Array.from({ length: 10 }, (_unused, index) => ({
        prompt: `prompt ${index}`,
        answer: `answer ${index}`,
      })),
    };
    const { tool } = makeCrossTool();
    const result = await view(tool, RUNNING);
    // The array arrives already cut to ten, so only the flag measured where the
    // answers live can tell the reader there were more than it shows.
    expect(result).toContain('showing the last 10, the maximum');
    expect(result).toContain('answer 9');
  });

  it('refuses a transcript that is not for the chat it asked about', async () => {
    viewReport = { ...viewReport, conversationId: 'a-different-chat' };
    const { tool } = makeCrossTool();
    const result = await view(tool, RUNNING);
    expect(result).toContain('answered for a different chat');
    expect(result).not.toContain('I read the plan.');
  });

  it('refuses an answer with no transcript in it, rather than reporting none', async () => {
    viewReport = { ...viewReport, exchanges: undefined } as unknown as PeerViewReport;
    const { tool } = makeCrossTool();
    const result = await view(tool, RUNNING);
    expect(result).toContain('could not be read');
    // "No answers in this chat yet" would be a claim about a chat nobody read.
    expect(result).not.toContain('No answers in this chat yet');
  });

  it('refuses a title or a tab number, which mean different chats over there', async () => {
    const { tool } = makeCrossTool();
    expect(await view(tool, 'Busy worker')).toContain('No open chat matches "Busy worker"');
    expect(gets()).toHaveLength(0);
  });
});

/** The sender's side of "a peer action is a request, not a local turn": the
 *  receiving window writes its own ledger, queue and mirror. If a peer send ever
 *  started routing through the local outbox, the shared bus folder would gain a
 *  question file per message — and `forge.sh wait` on the other side would read
 *  a duplicate of a chat it was never asked into. */
describe('message_chat against a peer window writes nothing under the bus root', () => {
  it('leaves no file behind from a send, a steer, a new or a view', async () => {
    const busRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-peer-bus-'));
    try {
      chatsReport = { ...chatsReport, models: ['alpha', 'strata-flash'] };
      reply = { status: 202, body: JSON.stringify({ conversationId: OPENED, title: 'Worker' }) };
      const { tool } = makeCrossTool({ steer: true, newChat: true, busRoot });
      expect(
        String(await tool.handler({ action: 'send', to: IDLE, message: 'One.' }, context)),
      ).toContain('Queued in');
      reply = { status: 202, body: '{"steered":true}' };
      expect(
        String(await tool.handler({ action: 'steer', to: RUNNING, message: 'Two.' }, context)),
      ).toContain('Interrupted');
      reply = { status: 202, body: JSON.stringify({ conversationId: OPENED, title: 'Worker' }) };
      expect(
        String(await tool.handler({ action: 'new', window: 'repo-b', message: 'Three.' }, context)),
      ).toContain('Opened');
      expect(String(await tool.handler({ action: 'view', to: RUNNING }, context))).toContain(
        'I read the plan.',
      );
      // Four requests, and the shared folder holds none of them: three posts to
      // the peer, and the two reads that are part of a steer's re-check and a
      // `view`.
      expect(received.filter((entry) => entry.method === 'POST')).toHaveLength(3);
      expect(received.filter((entry) => entry.method === 'GET').map((entry) => entry.path)).toEqual(
        ['/agent/chats', '/agent/peer-view'],
      );
      expect(fs.readdirSync(busRoot, { recursive: true })).toEqual([]);
    } finally {
      fs.rmSync(busRoot, { recursive: true, force: true });
    }
  });
});
