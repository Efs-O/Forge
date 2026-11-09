import { describe, expect, it } from 'vitest';
import { JsonRpcPending, routeJsonRpcLine } from '../../src/agents/jsonRpcStdio';

describe('JsonRpcPending', () => {
  it('preserves the numeric code and exact message from an error response', async () => {
    const pending = new JsonRpcPending();
    let reject!: (error: Error) => void;
    const response = new Promise<unknown>((_resolve, fail) => {
      reject = fail;
    });
    const id = pending.open('thread/read', () => undefined, reject);

    routeJsonRpcLine(
      '{"id":1,"error":{"code":-32600,"message":"x"}}',
      pending,
      {
        onRequest: () => undefined,
        onNotification: () => undefined,
        onProtocolError: (message) => {
          throw new Error(message);
        },
      },
    );

    const failure = await response.catch((error: Error) => error);
    expect(id).toBe(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { code?: number }).code).toBe(-32600);
    expect((failure as Error).message).toBe('thread/read failed: {"code":-32600,"message":"x"}');
  });
});
