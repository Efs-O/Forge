/**
 * One Forge window talking to another window's agent-bus server.
 *
 * Every call is bounded and cancellable, because a chat that asks a neighbour a
 * question must not be the thing the owner is waiting on: one deadline covers
 * connect through the last byte of the answer (a socket timeout alone measures
 * inactivity, and a response that trickles in keeps that socket alive forever),
 * and the turn's abort signal destroys the request mid-flight. A window that
 * does not answer is an answer of its own — the caller reports it and moves on.
 *
 * The answer distinguishes two failures that look alike and mean the opposite:
 * a connection that never carried the message (the caller knows nothing was
 * queued and may retry freely) and an answer lost after the bytes left (the
 * message may well be queued over there, so the caller keeps its counters and
 * says not to resend). Getting that wrong costs the owner a second paid turn.
 */
import * as http from 'http';
import type { WindowEndpoint } from './windowEndpoints';

export type PeerAnswer<T> =
  | { ok: true; status: number; value: T }
  /** `uncertain` means the message may already be sitting in that window's
   *  inbox: the bytes left this socket, and the answer that would have proved
   *  they were taken was lost. A caller may give back its counters only when
   *  this is absent — resending a message the peer already queued pays for the
   *  same report twice, in a chat the owner is paying for either way. */
  | { ok: false; status: number; error: string; uncertain?: boolean };

/** A window that is not answering is a report, not a hang: one timer bounds the
 *  whole call — connect, send and read — and the turn's abort signal stops it
 *  mid-flight. Reads are fast because they only list chats; writes get longer
 *  because the receiving window may be busy finishing a tool round. */
export const PEER_READ_LIMIT_MS = 5_000;
export const PEER_WRITE_LIMIT_MS = 10_000;

export function peerRequest<T>(
  method: 'GET' | 'POST',
  endpoint: Pick<WindowEndpoint, 'url' | 'token'>,
  route: string,
  body: string | undefined,
  limitMs: number,
  signal?: AbortSignal,
): Promise<PeerAnswer<T>> {
  return new Promise((resolve) => {
    let settled = false;
    // The abort listener is only removable once it exists, so `settle` says
    // whether it was ever attached rather than naming a `const` that a refusal
    // before the request was built has not reached yet.
    let listening = false;
    // Whether the peer could already hold the message. Once the bytes have left
    // this socket, a lost answer cannot be told apart from a window that queued
    // the message and then died, and the only thing left to protect is the
    // caller's counters and the owner's money: an uncertain outcome keeps the
    // counters burned and says do not resend.
    let responseStarted = false;
    const mayHaveArrived = (): boolean => responseStarted || request.writableFinished;
    const settle = (answer: PeerAnswer<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (listening) signal?.removeEventListener('abort', onAbort);
      resolve(answer);
    };
    // The deadline covers connect through the last byte, which is what "the
    // window is not answering" actually means: the socket timeout below
    // measures inactivity, so a response that trickles in one byte at a time
    // never trips it and `list` would wait forever. It starts here, before the
    // request exists, so every early refusal still clears it; naming `request`
    // from its callback is safe because a timer cannot fire before this
    // function's body has returned.
    const deadline = setTimeout(() => {
      request.destroy();
      settle({
        ok: false,
        status: 0,
        error: `the window did not answer within ${Math.round(limitMs / 1000)}s`,
        uncertain: mayHaveArrived(),
      });
    }, limitMs);
    // A turn that is already over must not open a socket on its way out: the
    // listener below only fires for an abort that happens after this point.
    if (signal?.aborted) {
      settle({ ok: false, status: 0, error: 'cancelled before the peer was asked' });
      return;
    }
    let target: URL;
    try {
      target = new URL(route, endpoint.url);
    } catch {
      settle({ ok: false, status: 0, error: `unparsable peer url ${endpoint.url}` });
      return;
    }
    const request = http.request(
      target,
      {
        method,
        headers: {
          Authorization: `Bearer ${endpoint.token}`,
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'text/plain; charset=utf-8',
                'Content-Length': Buffer.byteLength(body),
              }),
        },
        timeout: limitMs,
      },
      (response) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            let reason = text.slice(0, 200);
            try {
              reason = String((JSON.parse(text) as { error?: string }).error ?? reason);
            } catch {
              // Not JSON: the raw first lines are the most useful thing to say.
            }
            settle({
              ok: false,
              status,
              error: reason || `HTTP ${status}`,
              // A 4xx is the route saying no, which is proof it took nothing. A
              // 5xx means the window threw somewhere after reading the request,
              // and a message can already be in its inbox by then.
              uncertain: status >= 500,
            });
            return;
          }
          try {
            settle({ ok: true, status, value: JSON.parse(text) as T });
          } catch {
            settle({
              ok: false,
              status,
              error: 'the peer answered with something that is not JSON',
              uncertain: true,
            });
          }
        });
      },
    );
    const onAbort = (): void => {
      request.destroy();
      settle({
        ok: false,
        status: 0,
        error: 'cancelled before the peer answered',
        uncertain: mayHaveArrived(),
      });
    };
    request.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      // A refused or unresolved connection never carried the message, so the
      // caller knows for sure nothing was queued. A reset socket is the opposite
      // case: the bytes were out, and only the answer is gone.
      const neverLeft = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
      settle({
        ok: false,
        status: 0,
        error: neverLeft
          ? 'the window is not serving (bus off, older Forge, or it just closed)'
          : `could not reach the window: ${code ?? error.message}`,
        uncertain: !neverLeft,
      });
    });
    request.on('timeout', () => {
      request.destroy();
      settle({
        ok: false,
        status: 0,
        error: `the window did not answer within ${Math.round(limitMs / 1000)}s`,
        uncertain: mayHaveArrived(),
      });
    });
    listening = true;
    signal?.addEventListener('abort', onAbort, { once: true });
    request.end(body);
  });
}
