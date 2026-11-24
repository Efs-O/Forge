/**
 * Which retained verdicts are still WAITING for a session, and the one line
 * format that carries that answer to the client.
 *
 * The four rules `waitingVerdictsForSession` applies are the whole feature's
 * scope: an agent that was not live when its answer arrived must hear about it,
 * and must not hear about the 83 older answers sitting in the same folder.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WAITING_VERDICT_MAX_AGE_MS,
  waitingVerdictNoticeSentence,
  waitingVerdictsForSession,
  verdictArtifactPath,
} from '../../src/agentMesh/verdictArtifact';
import { EXCHANGES_LOG_NAME } from '../../src/agentMesh/exchangeLog';
import {
  WAITING_VERDICT_TRAILER,
  noticesForSender,
  sendJsonWithWaitingVerdicts,
  waitingVerdictNotices,
  waitingVerdictTrailer,
} from '../../src/backend/agentWaitingVerdicts';

const NOW = 1_800_000_000_000;
const OWN = '00000000-0000-4000-8000-000000000401';
const OTHER = '00000000-0000-4000-8000-000000000402';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-waiting-verdicts-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Row {
  exchangeId: string;
  type: string;
  state: string;
  ts?: number;
  from?: string;
  senderSessionId?: string;
  conversation?: string;
  detail?: string;
  eventId?: string;
}

/** Write the exchange log the way the bus writes it: one JSON line per event,
 *  `seq` in order, `eventId` unique. Only the fields a rule reads are typed;
 *  the rest of `ExchangeEvent` is left at the values this test does not care
 *  about, so a fixture stays readable. */
function writeLog(...rows: Row[]): void {
  const lines = rows.map((row, index) =>
    JSON.stringify({
      seq: index + 1,
      eventId: row.eventId ?? `ev-${index + 1}`,
      ts: row.ts ?? NOW,
      workspace: '/workspace',
      from: row.from ?? 'claude',
      ...row,
    }),
  );
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, EXCHANGES_LOG_NAME), `${lines.join('\n')}\n`, 'utf8');
}

/** The retained answer itself: the artifact `retainVerdict` would have moved in. */
function retain(exchangeId: string): void {
  const target = verdictArtifactPath(root, exchangeId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'the full retained answer', 'utf8');
}

/** The three events a retained answer leaves behind, in the order the bus writes
 *  them: `accepted` naming the session, then the `verdict` saying it was kept. */
function retainedExchange(exchangeId: string, sessionId = OWN, ageMs = 60_000): void {
  writeLog(
    {
      exchangeId,
      type: 'message',
      state: 'accepted',
      senderSessionId: sessionId,
      conversation: 'chat-1',
      ts: NOW - ageMs - 1000,
    },
    {
      exchangeId,
      type: 'verdict',
      state: 'completed',
      detail: 'sender was not live; answer retained for read-verdict',
      ts: NOW - ageMs,
      eventId: `verdict-${exchangeId}`,
    },
  );
  retain(exchangeId);
}

describe('waitingVerdictsForSession', () => {
  it('lists a retained answer for the session its accepted row named', () => {
    retainedExchange('ex-1');
    expect(waitingVerdictsForSession(root, OWN, NOW)).toEqual([
      {
        exchangeId: 'ex-1',
        senderSessionId: OWN,
        from: 'claude',
        conversationId: 'chat-1',
        chatLabel: 'chat-1',
        verdictTs: NOW - 60_000,
      },
    ]);
  });

  it('lists a retained verdict 23 hours old', () => {
    retainedExchange('ex-23h', OWN, 23 * 60 * 60_000);
    expect(waitingVerdictsForSession(root, OWN, NOW).map((item) => item.exchangeId)).toEqual([
      'ex-23h',
    ]);
  });

  it('refuses a verdict older than 24 hours, at the boundary exactly', () => {
    // One millisecond inside the window is listed; one millisecond outside is not.
    retainedExchange('ex-inside', OWN, WAITING_VERDICT_MAX_AGE_MS - 1);
    expect(waitingVerdictsForSession(root, OWN, NOW).map((item) => item.exchangeId)).toEqual([
      'ex-inside',
    ]);
    fs.rmSync(root, { recursive: true, force: true });
    retainedExchange('ex-outside', OWN, WAITING_VERDICT_MAX_AGE_MS);
    expect(waitingVerdictsForSession(root, OWN, NOW)).toEqual([]);
  });

  it('refuses a verdict the last event delivered live', () => {
    retainedExchange('ex-delivered');
    // A delivered answer usually has no artifact at all, but a recovery route
    // that delivers keeps the one an earlier event retained: the last word is
    // what decides, so this is the case that must not be announced.
    writeLog(
      {
        exchangeId: 'ex-delivered',
        type: 'message',
        state: 'accepted',
        senderSessionId: OWN,
        conversation: 'chat-1',
        ts: NOW - 5000,
      },
      {
        exchangeId: 'ex-delivered',
        type: 'verdict',
        state: 'completed',
        detail: 'sender was not live; answer retained for read-verdict',
        ts: NOW - 4000,
        eventId: 'verdict-ex-delivered',
      },
      {
        exchangeId: 'ex-delivered',
        type: 'verdict',
        state: 'completed',
        detail: 'recovery reply delivered to the live sender session',
        ts: NOW - 3000,
        eventId: 'recovery-verdict-ex-delivered',
      },
    );
    expect(waitingVerdictsForSession(root, OWN, NOW)).toEqual([]);
  });

  it('announces the recovery route equivalent when it was retained too', () => {
    writeLog(
      {
        exchangeId: 'ex-recovered',
        type: 'message',
        state: 'accepted',
        senderSessionId: OWN,
        conversation: 'chat-1',
        ts: NOW - 9000,
      },
      {
        exchangeId: 'ex-recovered',
        type: 'verdict',
        state: 'completed',
        detail: 'recovery reply retained for read-verdict',
        ts: NOW - 8000,
        eventId: 'recovery-verdict-ex-recovered',
      },
    );
    retain('ex-recovered');
    expect(waitingVerdictsForSession(root, OWN, NOW).map((item) => item.exchangeId)).toEqual([
      'ex-recovered',
    ]);
  });

  it('refuses a verdict recorded for another session', () => {
    retainedExchange('ex-other', OTHER);
    expect(waitingVerdictsForSession(root, OWN, NOW)).toEqual([]);
    expect(waitingVerdictsForSession(root, OTHER, NOW).map((item) => item.exchangeId)).toEqual([
      'ex-other',
    ]);
  });

  it('refuses a verdict already acknowledged', () => {
    retainedExchange('ex-acked');
    fs.rmSync(verdictArtifactPath(root, 'ex-acked'));
    expect(waitingVerdictsForSession(root, OWN, NOW)).toEqual([]);
  });

  it('refuses an exchange no accepted row attributes to a session, whoever asks', () => {
    writeLog({
      exchangeId: 'ex-orphan',
      type: 'verdict',
      state: 'completed',
      detail: 'sender was not live; answer retained for read-verdict',
      ts: NOW - 60_000,
      eventId: 'verdict-ex-orphan',
    });
    retain('ex-orphan');
    expect(waitingVerdictsForSession(root, OWN, NOW)).toEqual([]);
    // The wildcard mode — every session — is what a starting window uses, and it
    // lists this too: no session, nobody to announce to.
    expect(waitingVerdictsForSession(root, undefined, NOW)).toEqual([]);
  });

  it('lists two waiting verdicts for one session, oldest first', () => {
    writeLog(
      {
        exchangeId: 'ex-old',
        type: 'message',
        state: 'accepted',
        senderSessionId: OWN,
        conversation: 'chat-1',
        ts: NOW - 30_000,
      },
      {
        exchangeId: 'ex-old',
        type: 'verdict',
        state: 'completed',
        detail: 'sender was not live; answer retained for read-verdict',
        ts: NOW - 20_000,
        eventId: 'verdict-ex-old',
      },
      {
        exchangeId: 'ex-new',
        type: 'message',
        state: 'accepted',
        senderSessionId: OWN,
        conversation: 'chat-1',
        ts: NOW - 9000,
      },
      {
        exchangeId: 'ex-new',
        type: 'verdict',
        state: 'completed',
        detail: 'turn failed (no error given); retained for read-verdict',
        ts: NOW - 8000,
        eventId: 'verdict-ex-new',
      },
    );
    retain('ex-old');
    retain('ex-new');
    expect(
      waitingVerdictsForSession(root, OWN, NOW).map((item) => [item.exchangeId, item.verdictTs]),
    ).toEqual([
      ['ex-old', NOW - 20_000],
      ['ex-new', NOW - 8000],
    ]);
  });

  it('names the chat by its title, and falls back to the id it has', () => {
    retainedExchange('ex-titled');
    const titles = new Map([['chat-1', 'Nightly audit']]);
    expect(
      waitingVerdictsForSession(root, OWN, NOW, (id) => titles.get(id))
        .map((item) => item.chatLabel),
    ).toEqual(['Nightly audit']);
    // No resolver, or a chat this window does not hold: the conversation id.
    expect(
      waitingVerdictsForSession(root, OWN, NOW, () => undefined)
        .map((item) => item.chatLabel),
    ).toEqual(['chat-1']);
    // An exchange that never named a chat: the exchange id, so the line still
    // names something the reader can act on.
    writeLog(
      {
        exchangeId: 'ex-nochat',
        type: 'message',
        state: 'accepted',
        senderSessionId: OWN,
        ts: NOW - 5000,
      },
      {
        exchangeId: 'ex-nochat',
        type: 'verdict',
        state: 'completed',
        detail: 'sender was not live; answer retained for read-verdict',
        ts: NOW - 4000,
        eventId: 'verdict-ex-nochat',
      },
    );
    retain('ex-nochat');
    expect(
      waitingVerdictsForSession(root, OWN, NOW, () => undefined)
        .find((item) => item.exchangeId === 'ex-nochat')
        ?.chatLabel,
    ).toBe('ex-nochat');
  });

  it('lists every session in the wildcard mode, each labelled with its own session', () => {
    writeLog(
      {
        exchangeId: 'ex-a',
        type: 'message',
        state: 'accepted',
        senderSessionId: OWN,
        conversation: 'chat-1',
        ts: NOW - 5000,
      },
      {
        exchangeId: 'ex-a',
        type: 'verdict',
        state: 'completed',
        detail: 'sender was not live; answer retained for read-verdict',
        ts: NOW - 4000,
        eventId: 'verdict-ex-a',
      },
      {
        exchangeId: 'ex-b',
        type: 'message',
        state: 'accepted',
        senderSessionId: OTHER,
        conversation: 'chat-2',
        ts: NOW - 3000,
      },
      {
        exchangeId: 'ex-b',
        type: 'verdict',
        state: 'completed',
        detail: 'sender was not live; answer retained for read-verdict',
        ts: NOW - 2000,
        eventId: 'verdict-ex-b',
      },
    );
    retain('ex-a');
    retain('ex-b');
    expect(
      waitingVerdictsForSession(root, undefined, NOW).map((item) => [
        item.exchangeId,
        item.senderSessionId,
      ]),
    ).toEqual([
      ['ex-a', OWN],
      ['ex-b', OTHER],
    ]);
  });

  it('reads a bus folder with no log at all as nothing waiting', () => {
    fs.mkdirSync(root, { recursive: true });
    expect(waitingVerdictsForSession(root, OWN, NOW)).toEqual([]);
  });
});

describe('the notice sentence and the two wire forms', () => {
  it('the startup sentence is the words the client prints, without its prefix', () => {
    expect(
      waitingVerdictNoticeSentence({
        chatLabel: 'Nightly audit',
        exchangeId: 'ex-1',
        from: 'claude',
      }),
    ).toBe(
      'An answer is waiting for you from chat "Nightly audit" (exchange ex-1), not seen live. Read it with: forge.sh read-verdict claude ex-1',
    );
  });

  it('the trailer is one tab-separated line per waiting answer, and nothing when there are none', () => {
    expect(waitingVerdictTrailer([])).toBe('');
    expect(
      waitingVerdictTrailer([
        {
          exchangeId: 'ex-1',
          senderSessionId: OWN,
          from: 'claude',
          conversationId: 'chat-1',
          chatLabel: 'Nightly [audit] "quoted"',
          verdictTs: NOW,
        },
        {
          exchangeId: 'ex-2',
          senderSessionId: OWN,
          from: 'claude',
          conversationId: 'chat-1',
          chatLabel: 'chat-1',
          verdictTs: NOW,
        },
      ]),
    ).toBe(
      `\n${WAITING_VERDICT_TRAILER}\tex-1\tNightly [audit] "quoted"\n${WAITING_VERDICT_TRAILER}\tex-2\tchat-1`,
    );
  });

  /** What `sendJson` would hand the socket: the status, the headers, the bytes. */
  function capture(): {
    res: Parameters<typeof sendJsonWithWaitingVerdicts>[0];
    sent: () => { status: number; type: string; body: unknown };
  } {
    let status = 0;
    let type = '';
    let bytes = '';
    const res = {
      writeHead: (code: number, headers: Record<string, string>) => {
        status = code;
        type = headers['Content-Type'] ?? '';
      },
      end: (body?: string) => {
        bytes = body ?? '';
      },
    } as unknown as Parameters<typeof sendJsonWithWaitingVerdicts>[0];
    return {
      res,
      sent: () => ({ status, type, body: JSON.parse(bytes) as unknown }),
    };
  }

  const WAITING_TWO = [
    {
      exchangeId: 'ex-1',
      senderSessionId: OWN,
      from: 'claude',
      conversationId: 'chat-1',
      chatLabel: 'Nightly [audit] "quoted"',
      verdictTs: NOW,
    },
    {
      exchangeId: 'ex-2',
      senderSessionId: OWN,
      from: 'claude',
      conversationId: 'chat-1',
      chatLabel: 'chat-1',
      verdictTs: NOW,
    },
  ];

  it('the field is the two words a client needs, in the order forge.sh scans them', () => {
    expect(waitingVerdictNotices(WAITING_TWO)).toEqual([
      { exchangeId: 'ex-1', chat: 'Nightly [audit] "quoted"' },
      { exchangeId: 'ex-2', chat: 'chat-1' },
    ]);
    expect(Object.keys(waitingVerdictNotices(WAITING_TWO)[0]!)).toEqual(['exchangeId', 'chat']);
  });

  it('a JSON body grows the field and stays parseable JSON', () => {
    const { res, sent } = capture();
    sendJsonWithWaitingVerdicts(res, 202, { queued: 1, id: 'm1' }, WAITING_TWO);
    expect(sent()).toEqual({
      status: 202,
      type: 'application/json',
      body: {
        queued: 1,
        id: 'm1',
        waiting_verdicts: [
          { exchangeId: 'ex-1', chat: 'Nightly [audit] "quoted"' },
          { exchangeId: 'ex-2', chat: 'chat-1' },
        ],
      },
    });
  });

  it('with nothing waiting the JSON body is exactly what the route sent', () => {
    const { res, sent } = capture();
    sendJsonWithWaitingVerdicts(res, 202, { queued: 1, id: 'm1' }, []);
    expect(sent()).toEqual({ status: 202, type: 'application/json', body: { queued: 1, id: 'm1' } });
  });

  it('a body that is not an object gets no field rather than a reshaped body', () => {
    const { res, sent } = capture();
    sendJsonWithWaitingVerdicts(res, 200, 'a route answering text-as-JSON', WAITING_TWO);
    expect(sent()).toEqual({
      status: 200,
      type: 'application/json',
      body: 'a route answering text-as-JSON',
    });
  });

  it('announces nothing to a request that carried no session identity', () => {
    const waiting = vi.fn(() => [] as never[]);
    expect(
      noticesForSender(waiting as unknown as (senderSessionId: string) => never[], undefined),
    ).toEqual([]);
    expect(waiting).not.toHaveBeenCalled();
  });
});
