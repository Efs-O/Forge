import * as http from 'http';

/** How often a window that lost the configured port retries to bind it. */
export const DEFAULT_RECLAIM_INTERVAL_MS = 5_000;

/** Options for {@link startPortReclaim}. */
export interface PortReclaimOptions {
  port: number;
  intervalMs: number;
  /** A fresh listener wired to the server's request handler. */
  createServer: () => http.Server;
  /** Called once with the listener that bound `port`; the caller adopts it. */
  onBound: (server: http.Server) => void;
}

/** Retry binding `port` on 127.0.0.1 every `intervalMs` until one bind wins.
 *  Returns a stop function; a bind that completes after stop() is closed. */
export function startPortReclaim(options: PortReclaimOptions): () => void {
  let stopped = false;
  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    const server = options.createServer();
    // A busy port is the common case: the OS refuses the bind, this listener
    // goes away and the next tick tries again.
    server.once('error', () => server.close());
    server.listen(options.port, '127.0.0.1', () => {
      if (stopped) {
        server.close();
        return;
      }
      stop();
      options.onBound(server);
    });
  }, options.intervalMs);
  // Never hold the process open for a port that may never come free.
  timer.unref();
  return stop;
}
