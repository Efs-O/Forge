import * as readline from 'readline';
import { spawnCliProcess, terminateProcessTree, waitForCliProcessExit } from '../agents/cliProcess';
import { codexAppServerArgs } from '../agents/codexAppServerArgs';
import { JsonRpcPending, routeJsonRpcLine } from '../agents/jsonRpcStdio';

/**
 * Codex session discovery (AGENT_MESH_PLAN §0, P4).
 *
 * The scriptable equivalent of the `codex agents` TUI: a short-lived
 * `codex app-server --stdio` process we drive with a single `thread/list`
 * JSON-RPC request, then dispose. The app-server is the daemon that owns the
 * live threads (the sidebar's `codex.exe app-server` IS it), so listing its
 * threads finds every live session — not just the one Forge spawned.
 *
 * The wire contract is the Codex app-server protocol, versioned by the CLI:
 * `codex app-server generate-json-schema` emits the JSON Schema bundle
 * (`codex_app_server_protocol.v2.schemas.json`). `thread/list` takes
 * `ThreadListParams` (an optional `cwd` filter) and returns
 * `ThreadListResponse` (`data: Thread[]` + pagination cursors). A `Thread`
 * carries `id` (a UUIDv7), `cwd`, `name`, `preview`, `status`, and timestamps.
 *
 * This is a v1 enhancement, separately tested (P4): it lands only when its own
 * compatibility test passes, and it does not block the owned-Codex path.
 */

export interface DiscoveredThread {
  /** The thread id (UUIDv7) — the resume identity. */
  id: string;
  /** The working directory the thread was started in. */
  cwd: string;
  /** Optional user-facing title. */
  name?: string;
  /** Usually the first user message in the thread. */
  preview?: string;
  /** Unix seconds of last update, when present. */
  updatedAt?: number;
}

export interface CodexDiscoveryOptions {
  /** The resolved `codex` executable (or a fixture for tests). */
  executable: string;
  /** Working directory for the app-server process. */
  cwd: string;
  /** Extra args (tests inject the fixture here, like the owned session). */
  argsPrefix?: readonly string[];
  /** Abort the discovery (bounded by the caller). */
  signal?: AbortSignal;
  /** Hard bound on the whole discovery, in ms. */
  timeoutMs?: number;
}

export interface CodexDiscoveryResult {
  threads: DiscoveredThread[];
}

/**
 * Discover live Codex threads on the local app-server. Spawns a throwaway
 * app-server, lists its threads, and disposes — it never owns a session.
 */
export class CodexDiscovery {
  private child: ReturnType<typeof spawnCliProcess> | undefined;
  private input: readline.Interface | undefined;
  private readonly pending = new JsonRpcPending();
  private protocolError: string | undefined;

  constructor(private readonly options: CodexDiscoveryOptions) {}

  async discover(): Promise<CodexDiscoveryResult> {
    const child = spawnCliProcess({
      executable: this.options.executable,
      args: codexAppServerArgs({
        executable: this.options.executable,
        ...(this.options.argsPrefix ? { argsPrefix: this.options.argsPrefix } : {}),
      }),
      cwd: this.options.cwd,
      stdin: 'pipe',
    });
    this.child = child;
    this.input = child.stdout
      ? readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined;
    this.input?.on('line', (line) => this.handleLine(line));
    void waitForCliProcessExit(child).then((exit) => {
      if (this.child !== child) return;
      this.protocolError = exit.error
        ? `Codex app-server transport failed: ${exit.error.message}`
        : `Codex app-server exited with code ${exit.code ?? '?'} before thread/list completed.`;
      this.pending.rejectAll(new Error(this.protocolError));
    });
    if (this.options.signal) {
      this.options.signal.addEventListener('abort', () => this.dispose(), { once: true });
    }
    try {
      await this.request('initialize', {
        clientInfo: { name: 'forge', title: 'Forge', version: '1' },
        capabilities: null,
      });
      this.notify('initialized');
      // List all threads; the caller matches by cwd/name in-process. (The
      // `cwd` filter is a `ThreadListCwdFilter` object whose exact shape we do
      // not pin here — matching in-process is correct and version-tolerant.)
      const result = await this.request('thread/list', {});
      return { threads: this.parseThreads(result) };
    } finally {
      await this.dispose();
    }
  }

  private parseThreads(result: unknown): DiscoveredThread[] {
    const value =
      result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
    const data = value?.['data'];
    if (!Array.isArray(data)) return [];
    const out: DiscoveredThread[] = [];
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') continue;
      const t = raw as Record<string, unknown>;
      if (typeof t['id'] !== 'string' || typeof t['cwd'] !== 'string') continue;
      out.push({
        id: t['id'],
        cwd: t['cwd'],
        ...(typeof t['name'] === 'string' ? { name: t['name'] } : {}),
        ...(typeof t['preview'] === 'string' ? { preview: t['preview'] } : {}),
        ...(typeof t['updatedAt'] === 'number' ? { updatedAt: t['updatedAt'] } : {}),
      });
    }
    return out;
  }

  private request(method: string, params: object): Promise<unknown> {
    if (this.protocolError) return Promise.reject(new Error(this.protocolError));
    return new Promise((resolve, reject) => {
      const id = this.pending.open(method, resolve, reject);
      this.write({ id, method, params });
    });
  }

  private notify(method: string): void {
    this.write({ method });
  }

  private write(message: object): void {
    if (!this.child?.stdin?.writable) {
      this.protocolError = this.protocolError ?? 'Codex app-server stdin is unavailable.';
      return;
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error)
        this.protocolError =
          this.protocolError ?? `Codex app-server write failed: ${error.message}`;
    });
  }

  private handleLine(line: string): void {
    routeJsonRpcLine(line, this.pending, {
      onRequest: () => {
        // Discovery answers no server requests; a request is a protocol surprise.
        this.protocolError = this.protocolError ?? 'Codex app-server sent an unexpected request.';
      },
      onNotification: () => {
        // Notifications are not part of the thread/list contract; ignore.
      },
      onProtocolError: (message) => {
        this.protocolError = this.protocolError ?? message;
      },
    });
  }

  async dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.input?.close();
    this.input = undefined;
    this.pending.rejectAll(new Error('Codex discovery disposed.'));
    if (child) await terminateProcessTree(child);
  }
}

export interface ThreadMatchQuery {
  /** Match threads started in this working directory (case-insensitive). */
  cwd?: string;
  /** Match a user-facing title (case-insensitive, substring). */
  name?: string;
}

/**
 * Resolve a discovered-thread list to a single thread (acceptance criterion #1:
 * no match, one match, multiple matches). A match is by `cwd` (when given) and
 * `name` (when given); with neither, every thread is a candidate. Returns the
 * one thread on an unambiguous match, or the candidate list when ambiguous.
 */
export function matchThread(
  threads: DiscoveredThread[],
  query: ThreadMatchQuery,
): { thread: DiscoveredThread } | { ambiguous: DiscoveredThread[] } | { none: true } {
  const byCwd = query.cwd ? query.cwd.trim().toLowerCase() : undefined;
  const byName = query.name ? query.name.trim().toLowerCase() : undefined;
  const candidates = threads.filter((t) => {
    if (byCwd && t.cwd.toLowerCase() !== byCwd) return false;
    if (byName && !(t.name ?? '').toLowerCase().includes(byName)) return false;
    return true;
  });
  if (candidates.length === 0) return { none: true };
  if (candidates.length === 1) return { thread: candidates[0] };
  return { ambiguous: candidates };
}
