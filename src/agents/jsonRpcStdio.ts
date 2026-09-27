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
  /**
   * A response frame whose id matches no open request. Without this hook the
   * frame is a protocol error; a session that deliberately stopped its
   * in-flight requests (transport teardown) can ignore those specific ids.
   */
  onUnmatchedResponse?: (id: number) => void;
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

  /**
   * Settles the request `id` from its response frame. Returns false when no
   * request is open under that id (already settled, or never sent).
   */
  settle(id: number, message: Record<string, unknown>): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    if (message['error']) {
      pending.reject(new Error(`${pending.method} failed: ${JSON.stringify(message['error'])}`));
    } else {
      pending.resolve(message['result']);
    }
    return true;
  }

  /**
   * Fails every in-flight request — the transport is gone. Rejections are
   * synchronous: every request promise is owned by a session handler, so none
   * is left unhandled. Returns the ids that were stopped.
   */
  rejectAll(error: Error): number[] {
    const ids = [...this.pending.keys()];
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
    return ids;
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
    handlers.onProtocolError('CLI app-server emitted malformed JSON.');
    return;
  }
  if (!message || typeof message !== 'object') {
    handlers.onProtocolError('CLI app-server emitted a non-object message.');
    return;
  }
  const value = message as Record<string, unknown>;
  if (typeof value['id'] === 'number' && typeof value['method'] === 'string') {
    handlers.onRequest(value['id'], value['method'], value['params']);
    return;
  }
  if (typeof value['id'] === 'number') {
    if (!pending.settle(value['id'], value)) {
      if (handlers.onUnmatchedResponse) handlers.onUnmatchedResponse(value['id']);
      else
        handlers.onProtocolError(`CLI app-server response ${value['id']} has no matching request.`);
    }
    return;
  }
  if (typeof value['method'] === 'string') {
    handlers.onNotification(value['method'], value['params']);
    return;
  }
  handlers.onProtocolError('CLI app-server emitted an uncorrelated message.');
}
