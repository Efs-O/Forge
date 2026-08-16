/**
 * The JSON-RPC-over-stdio half of a warm CLI agent session: id correlation,
 * line framing, and routing an inbound message to request / response /
 * notification.
 *
 * Split out of `CodexAppServerSession`, which keeps the Codex-specific
 * protocol on top of it.
 */

export interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export interface JsonRpcHandlers {
  /** A server-initiated request (Codex uses these for approval elicitations). */
  onRequest: (id: number, method: string, params: unknown) => void;
  onNotification: (method: string, params: unknown) => void;
  /** Anything malformed or uncorrelated: the session treats it as fatal. */
  onProtocolError: (message: string) => void;
}

/** Correlates outbound requests with their replies. */
export class JsonRpcPending {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  /** Registers a request and returns the id to send it under. */
  open(method: string, resolve: (value: unknown) => void, reject: (error: Error) => void): number {
    const id = this.nextId++;
    this.pending.set(id, { method, resolve, reject });
    return id;
  }

  /** Settles the request `id` from its response frame. */
  settle(id: number, message: Record<string, unknown>, onUnmatched: (msg: string) => void): void {
    const pending = this.pending.get(id);
    if (!pending) {
      onUnmatched(`Codex app-server response ${id} has no matching request.`);
      return;
    }
    this.pending.delete(id);
    if (message['error']) {
      pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message['error'])}`));
    } else {
      pending.resolve(message['result']);
    }
  }

  /** Fails every in-flight request — the transport is gone. */
  rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

/** Parses one stdout line and dispatches it. */
export function routeJsonRpcLine(
  line: string,
  pending: JsonRpcPending,
  handlers: JsonRpcHandlers,
): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    handlers.onProtocolError('Codex app-server emitted malformed JSON.');
    return;
  }
  if (!message || typeof message !== 'object') {
    handlers.onProtocolError('Codex app-server emitted a non-object message.');
    return;
  }
  const value = message as Record<string, unknown>;
  if (typeof value['id'] === 'number' && typeof value['method'] === 'string') {
    handlers.onRequest(value['id'], value['method'], value['params']);
    return;
  }
  if (typeof value['id'] === 'number') {
    pending.settle(value['id'], value, handlers.onProtocolError);
    return;
  }
  if (typeof value['method'] === 'string') {
    handlers.onNotification(value['method'], value['params']);
    return;
  }
  handlers.onProtocolError('Codex app-server emitted an uncorrelated message.');
}
