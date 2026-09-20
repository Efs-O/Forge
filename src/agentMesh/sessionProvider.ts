import * as os from 'os';
import type { ForgeConfig } from '../config/types';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import type { CodexAppServerSession } from '../agents/CodexAppServerSession';
import { queueToCodex } from '../agentBus/codexDelivery';
import {
  pickClaudeSession,
  readClaudeSessions,
  sendPeerMessage,
  type ClaudeSession,
} from '../agentBus/claudePeer';
import { relayToClaude } from '../agentBus/claudeRelay';
import { getAlias, registerAlias, resolveSessionIdentity } from './aliasRegistry';
import { ClaudePeerAdapter, CodexOwnedAdapter, CodexQueueAdapter } from './adapters';
import type { MeshAdapter } from './meshAdapter';
import { getHostIdentity, isHostAlive, type HostLivenessDeps } from './hostIdentity';
import { claimCreation, readOwnership, releaseClaim, writeOwnership } from './ownership';
import type { SessionProvider } from './meshOrchestrator';

/**
 * The session provider (AGENT_MESH_PLAN §0, M2, M3). The window that owns a
 * Forge-owned session holds it in memory here, keyed by alias, and is the only
 * window that may reap it.
 *
 * - **Detect:** a live owned session (in memory) is used directly. A
 *   registered alias with a `thread_id` resumes that thread in a new
 *   app-server (M3: warm survives a restart through the thread, not the
 *   process). A config pin with no alias uses the user-opened session
 *   (non-observing).
 * - **Create:** the first owned creation for an alias is consented
 *   (`requestConsent`), claims the creation lease (M2, no double-spawn),
 *   spawns the app-server, and records ownership with `owner_host` = this
 *   window. Subsequent reuse is automatic.
 * - **Reap:** `reap(alias)` disposes the in-memory session. Called by startup
 *   recovery when this window's owned session's owner host is dead (M2/M3).
 */

export interface OwnedCodexFactory {
  create(options: {
    alias: string;
    threadId: string | undefined;
    executable: string;
    cwd: string;
    model?: string;
  }): Promise<CodexAppServerSession>;
}

export interface SessionProviderDeps extends HostLivenessDeps {
  busRoot: string;
  getConfig: () => ForgeConfig;
  workspaceRoots: () => string[];
  /** Injectable for tests; production reads ~/.claude/sessions. */
  claudeSessions?: () => ClaudeSession[];
  /** Injectable for tests; production uses the configured transport. */
  sendClaude?: (session: ClaudeSession, message: string, signal?: AbortSignal) => Promise<void>;
  /** Injectable for tests; production runs `codex queue`. */
  queueCodex?: typeof queueToCodex;
  /** Injectable for tests; production spawns a real app-server. */
  codexFactory?: OwnedCodexFactory;
  /** First-creation consent gate (M2). Returns true to allow. */
  requestConsent?: (alias: string) => Promise<boolean>;
  /**
   * Called when a thread RESUME fails (M3). The plan never swaps in a fresh
   * thread silently: a failed resume is a visible `context_lost` board event.
   * A fresh creation (no prior thread) failing is not a context loss — it is
   * just a creation error.
   */
  onContextLost?: (alias: string, reason: string) => void;
}

export class MeshSessionProvider implements SessionProvider {
  private readonly owned = new Map<string, CodexAppServerSession>();
  private readonly creating = new Map<string, Promise<MeshAdapter | { error: string }>>();

  constructor(private readonly deps: SessionProviderDeps) {}

  /** The in-memory owned session for an alias, if this window holds it. */
  getOwned(alias: string): CodexAppServerSession | undefined {
    return this.owned.get(alias);
  }

  isOwned(alias: string): boolean {
    return this.owned.has(alias);
  }

  /**
   * Resolve the adapter for an alias (the orchestrator's `resolveAdapter`).
   *
   * codex: in-memory owned → owned adapter; a registered alias (or a prior
   * thread_id) → resume owned (M3, no consent, async); config pin with no
   * alias → user-opened queue adapter (non-observing). claude: a live
   * registry session → peer adapter.
   */
  async resolveAdapter(alias: string): Promise<MeshAdapter | undefined> {
    const a = alias.trim().toLowerCase();
    if (a === 'claude') return this.claudeAdapter();
    if (a === 'codex') return this.codexAdapterAsync();
    return undefined;
  }

  /**
   * The async Codex path: an in-memory owned session, else a resume/creation
   * (M3). A config pin with no alias is the non-observing user-opened queue.
   */
  private async codexAdapterAsync(): Promise<MeshAdapter | undefined> {
    const existing = this.owned.get('codex');
    if (existing) return new CodexOwnedAdapter(existing);
    const rec = readOwnership(this.deps.busRoot, 'codex');
    const aliasRec = getAlias(this.deps.busRoot, 'codex');
    // M2: a session another LIVE window owns is never re-spawned here. This
    // window does not hold its stdio pipe, so it cannot drive it; spawning a
    // second app-server for the same thread would leave two live pipes on one
    // alias. Fall back to a user-opened queue session (if pinned), else none.
    if (rec?.owner_host && this.isForeignLiveOwner(rec.owner_host)) {
      return this.codexAdapter();
    }
    // A registered alias or a prior thread_id → resume owned (M3).
    if (rec?.thread_id || aliasRec) {
      const result = await this.ensureOwnedCodex('codex');
      return 'error' in result ? undefined : result;
    }
    // No alias and no thread: the user-opened pin (non-observing).
    return this.codexAdapter();
  }

  /**
   * True when `owner` is a live host that is NOT this one. `isHostAlive` is
   * true for self, so the pid comparison is what separates "I own it" (resume
   * is safe) from "another window owns it" (never race it).
   */
  private isForeignLiveOwner(owner: { pid: number; startedAt: number }): boolean {
    if (!isHostAlive(owner, this.deps)) return false;
    return owner.pid !== getHostIdentity(this.deps).pid;
  }

  private claudeAdapter(): MeshAdapter | undefined {
    const bus = this.deps.getConfig().agent_bus;
    const sessions = this.deps.claudeSessions ? this.deps.claudeSessions() : readClaudeSessions();
    const pin = this.deps.busRoot ? getAlias(this.deps.busRoot, 'claude')?.session_id : undefined;
    const picked = pickClaudeSession(
      sessions,
      pin ?? bus?.claude_session,
      this.deps.workspaceRoots(),
    );
    if ('error' in picked) return undefined;
    const send = this.deps.sendClaude ?? defaultSendClaude(this.deps.getConfig().agent_bus);
    return new ClaudePeerAdapter(picked.session, send);
  }

  private codexAdapter(): MeshAdapter | undefined {
    const existing = this.owned.get('codex');
    if (existing) return new CodexOwnedAdapter(existing);
    // No in-memory owned session. A first creation or a resume is async
    // (ensureOwnedCodex); getAdapter is sync, so it only returns the
    // user-opened pin here (non-observing). The orchestrator's `tell` calls
    // ensureOwnedCodex for the owned path.
    const bus = this.deps.getConfig().agent_bus;
    const identity = resolveSessionIdentity(this.deps.busRoot, 'codex', bus?.codex_thread);
    if (identity && !identity.fromAlias) {
      return new CodexQueueAdapter(
        bus?.codex_cli ?? 'codex',
        identity.session_id,
        this.deps.queueCodex ?? queueToCodex,
      );
    }
    return undefined;
  }

  /**
   * Ensure an owned Codex session for the alias, creating (consented) or
   * resuming (M3) as needed. The single async creation path. Idempotent: a
   * concurrent call for the same alias awaits the same in-flight creation.
   */
  ensureOwnedCodex(alias: string): Promise<MeshAdapter | { error: string }> {
    const a = alias.trim().toLowerCase();
    const existing = this.owned.get(a);
    if (existing) return Promise.resolve(new CodexOwnedAdapter(existing));
    const inflight = this.creating.get(a);
    if (inflight) return inflight;
    const promise = this.createOwnedCodex(a).finally(() => this.creating.delete(a));
    this.creating.set(a, promise);
    return promise;
  }

  private async createOwnedCodex(alias: string): Promise<MeshAdapter | { error: string }> {
    const host = getHostIdentity(this.deps);
    const claim = claimCreation(this.deps.busRoot, alias, host, this.deps);
    if (!claim.claimed) {
      return {
        error: `creation for "${alias}" is already in progress (another window holds the lease)`,
      };
    }
    const rec = readOwnership(this.deps.busRoot, alias);
    const aliasRec = getAlias(this.deps.busRoot, alias);
    const threadId = rec?.thread_id ?? aliasRec?.session_id;
    try {
      const bus = this.deps.getConfig().agent_bus;

      // First creation (no prior consent recorded): gate it.
      if (!aliasRec && !threadId) {
        const consent = (this.deps.requestConsent ?? (async () => true))(alias);
        if (!consent) {
          return {
            error: `creating a Forge-owned ${alias} session was not consented; nothing was started`,
          };
        }
      }

      const executable = await resolveCliExecutable(bus?.codex_cli ?? 'codex', 'codex');
      const factory = this.deps.codexFactory ?? defaultCodexFactory();
      const session = await factory.create({
        alias,
        threadId,
        executable,
        cwd: this.deps.workspaceRoots()[0] ?? os.homedir(),
      });

      const newThreadId = session.confirmedSessionId ?? threadId;
      this.owned.set(alias, session);
      writeOwnership(this.deps.busRoot, {
        alias,
        agent: 'codex',
        session_id: newThreadId ?? '',
        ...(newThreadId ? { thread_id: newThreadId } : {}),
        owner_host: host,
        workspace: this.deps.workspaceRoots()[0] ?? '',
        created_at: Date.now(),
        parked: false,
      });
      if (!aliasRec) {
        registerAlias(this.deps.busRoot, alias, {
          agent: 'codex',
          session_id: newThreadId ?? '',
          registered_at: Date.now(),
          by: 'forge',
        });
      }
      return new CodexOwnedAdapter(session);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // M3: a failed RESUME (a prior thread existed) is a visible context loss —
      // the plan never swaps in a fresh thread silently. A fresh creation
      // failing (no prior thread) is just a creation error.
      if (threadId && this.deps.onContextLost) {
        this.deps.onContextLost(alias, why);
      }
      return { error: `could not create the owned ${alias} session: ${why}` };
    } finally {
      releaseClaim(this.deps.busRoot, alias);
    }
  }

  /**
   * Reap the in-memory owned session for an alias (owner-host-death recovery,
   * M2/M3). The ownership record's `owner_host` is cleared by the caller
   * (recoverOwnership); the `thread_id` is kept for resume.
   */
  async reap(alias: string): Promise<void> {
    const session = this.owned.get(alias.trim().toLowerCase());
    if (!session) return;
    this.owned.delete(alias.trim().toLowerCase());
    await session.dispose();
  }

  /**
   * Standby: park-but-warm (§2b, P3). Sets `parked: true` on the ownership
   * record (durable: survives a restart, and exempts the session from the idle
   * TTL while parked, M4). The in-memory session is NOT disposed — "warm" means
   * the thread stays resumable. `undefined` when the alias has no ownership
   * record (nothing to park).
   */
  park(alias: string): boolean {
    const a = alias.trim().toLowerCase();
    const rec = readOwnership(this.deps.busRoot, a);
    if (!rec) return false;
    writeOwnership(this.deps.busRoot, { ...rec, parked: true });
    return true;
  }

  /** Wake a parked session (§2b). Clears `parked`; `undefined` when no record. */
  wake(alias: string): boolean {
    const a = alias.trim().toLowerCase();
    const rec = readOwnership(this.deps.busRoot, a);
    if (!rec) return false;
    writeOwnership(this.deps.busRoot, { ...rec, parked: false });
    return true;
  }

  /** Is the alias parked? (The board's `parked` state, §2b.) */
  isParked(alias: string): boolean {
    return readOwnership(this.deps.busRoot, alias.trim().toLowerCase())?.parked === true;
  }

  /**
   * Close: hard-kill a Forge-owned session (§8, P3). Disposes the in-memory
   * session (if this window holds it) and clears `owner_host` on the record.
   * The `thread_id` is kept (M3: a later `say`/`steer` resumes the same thread).
   * **Never** targets a user-opened session: a user-opened session has no
   * ownership record, so there is nothing to kill here. `undefined` when the
   * alias has no ownership record.
   */
  async close(alias: string): Promise<boolean> {
    const a = alias.trim().toLowerCase();
    const rec = readOwnership(this.deps.busRoot, a);
    if (!rec) return false;
    const session = this.owned.get(a);
    if (session) {
      this.owned.delete(a);
      await session.dispose();
    }
    writeOwnership(this.deps.busRoot, {
      ...rec,
      owner_host: null,
      parked: false,
    });
    return true;
  }

  /** Dispose all in-memory owned sessions (window shutdown). */
  async dispose(): Promise<void> {
    const sessions = [...this.owned.values()];
    this.owned.clear();
    await Promise.all(sessions.map((s) => s.dispose()));
  }
}

function defaultSendClaude(
  bus: ForgeConfig['agent_bus'],
): (session: ClaudeSession, message: string, signal?: AbortSignal) => Promise<void> {
  return (session, message, signal) => {
    if (bus?.claude_transport === 'relay') {
      return relayToClaude(bus.claude_cli, bus.relay_model, session.name, message, signal);
    }
    return sendPeerMessage(session, 'Forge', message);
  };
}

function defaultCodexFactory(): OwnedCodexFactory {
  return {
    create: async ({ executable, cwd, model, threadId }) => {
      const { CodexAppServerSession } = await import('../agents/CodexAppServerSession');
      return new CodexAppServerSession({
        executable,
        cwd,
        ...(model ? { model } : {}),
        ...(threadId ? { confirmedSessionId: threadId } : {}),
      });
    },
  };
}
