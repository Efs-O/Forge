import * as os from 'os';
import type { ForgeConfig } from '../config/types';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import type { CodexAppServerSession } from '../agents/CodexAppServerSession';
import type { ClaudeOwnedSession } from '../agents/ClaudeOwnedSession';
import { queueToCodex } from '../agentBus/codexDelivery';
import { pickClaudePeer, readClaudeSessions, type ClaudeSession } from '../agentBus/claudePeer';
import { getAlias, registerAlias } from './aliasRegistry';
import { ClaudeOwnedAdapter, ClaudePeerAdapter, CodexOwnedAdapter } from './adapters';
import { codexQueueAdapterIfLive } from './codexPinLiveness';
import {
  beginCreation,
  defaultClaudeFactory,
  defaultCodexFactory,
  defaultSendClaude,
  type OwnedClaudeFactory,
  type OwnedCodexFactory,
} from './creationPreamble';
import type { MeshAdapter } from './meshAdapter';
import type { HostLivenessDeps } from './hostIdentity';
import {
  isForeignLiveOwner,
  isOwnerOf,
  readOwnership,
  releaseClaim,
  writeOwnership,
} from './ownership';
import type { SessionProvider } from './meshOrchestrator';

/**
 * The session provider (AGENT_MESH_PLAN §0, M2, M3, §10). The window that owns
 * a Forge-owned session holds it in memory here, keyed by alias, and is the
 * only window that may reap it.
 * - **Detect:** a joined Claude session (`forge.sh join`) while live; a live
 *   owned session; a registered alias or thread resumes (M3); an open Claude
 *   session in this workspace (non-observing).
 * - **Create:** otherwise Forge creates its own — under the creation lease (M2), ownership recorded with
 *   `owner_host` = this window. Subsequent reuse is automatic.
 * - **Reap:** `reap(alias)` disposes the in-memory session (recovery, M2/M3).
 */

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
  /** Injectable for tests; production spawns a real owned Claude stdio session. */
  claudeFactory?: OwnedClaudeFactory;
  /**
   * Called when a thread RESUME fails (M3): a failed resume is a visible
   * `context_lost` board event (a fresh creation failing is not a context loss).
   */
  onContextLost?: (alias: string, reason: string) => void;
}

export class MeshSessionProvider implements SessionProvider {
  private readonly owned = new Map<string, CodexAppServerSession>();
  private readonly claudeOwned = new Map<string, ClaudeOwnedSession>();
  private readonly creating = new Map<string, Promise<MeshAdapter | { error: string }>>();
  /** Aliases currently being disposed by TTL/recovery. */
  private readonly reaping = new Set<string>();
  constructor(private readonly deps: SessionProviderDeps) {}
  /** The in-memory owned session for an alias, if this window holds it. */
  getOwned(alias: string): CodexAppServerSession | undefined {
    return this.owned.get(alias);
  }

  isOwned(alias: string): boolean {
    return this.owned.has(alias) || this.claudeOwned.has(alias);
  }

  /**
   * F-07: record activity on the alias's ownership record (the idle-TTL
   * reaper's clock). Called when a message is sent to an owned session, so a
   * busy session is never reaped while in use. Parked sessions are exempt from
   * the TTL (park-but-warm), so this is a no-op for them.
   */
  touchActivity(alias: string): void {
    const a = alias.trim().toLowerCase();
    const rec = readOwnership(this.deps.busRoot, a);
    if (!rec) return;
    writeOwnership(this.deps.busRoot, { ...rec, last_activity: Date.now() });
  }

  /** True only when this window holds the adapter and can observe its turns. */
  isObserving(alias: string): boolean {
    return this.isOwned(alias);
  }

  /**
   * Resolve the adapter for an alias, in the order the class comment gives.
   * Undefined when none can be reached or created .
   * May create a Forge-owned session, so it is async.
   */
  async resolveAdapter(alias: string): Promise<MeshAdapter | undefined> {
    const a = alias.trim().toLowerCase();
    if (this.reaping.has(a)) return undefined;
    if (a === 'claude') return this.claudeAdapterAsync();
    if (a === 'codex') return this.codexAdapterAsync();
    return undefined;
  }

  /**
   * The async Codex path: an in-memory owned session, else a resume/creation
   * (M3). The config pin is used only when another window owns the session.
   */
  private async codexAdapterAsync(): Promise<MeshAdapter | undefined> {
    const existing = this.owned.get('codex');
    if (existing) return new CodexOwnedAdapter(existing);
    const rec = readOwnership(this.deps.busRoot, 'codex');
    // M2: a session another LIVE window owns is never re-spawned here. This
    // window does not hold its stdio pipe, so it cannot drive it; spawning a
    // second app-server for the same thread would leave two live pipes on one
    // alias. Fall back to a user-opened queue session (if pinned), else none.
    if (rec?.owner_host && this.isForeignLiveOwner(rec.owner_host)) {
      return this.codexAdapterIfLive();
    }
    // A registered alias or prior thread resumes (M3); with neither, Forge
    // creates its own . Not the config pin: `codex queue` only
    // reaches a thread open in a Codex window, and "live" there only proves the
    // thread exists on disk, so a question queued to it waited unread.
    const result = await this.ensureOwnedCodex('codex');
    return 'error' in result ? undefined : result;
  }

  /**
   * True when `owner` is a live host that is NOT this one. `isHostAlive` is
   * true for self, so the pid comparison is what separates "I own it" (resume
   * is safe) from "another window owns it" (never race it).
   */
  private isForeignLiveOwner(owner: { pid: number; startedAt: number }): boolean {
    return isForeignLiveOwner(this.deps, owner);
  }

  /**
   * True when THIS window is the live owner of the alias's record (F-02). Only
   * the owner may mutate parked/close the record or reap it: a peer window that
   * cleared another window's `owner_host` would orphan the live stdio pipe and
   * let a later message spawn a second pipe on the same alias. Public so the
   * maintenance loop can reap only sessions it owns.
   */
  isOwner(alias: string): boolean {
    const rec = readOwnership(this.deps.busRoot, alias);
    if (!rec?.owner_host) return false;
    return isOwnerOf(this.deps, rec.owner_host);
  }

  /**
   * The async Claude path (P4, §10): a joined session, an owned stdio session,
   * a resume (M3), an open session in this workspace (the sync
   * `claudeAdapter`), else a new Forge-owned one.
   */
  private async claudeAdapterAsync(): Promise<MeshAdapter | undefined> {
    const aliasRec = getAlias(this.deps.busRoot, 'claude');
    // A session that joined itself (`forge.sh join`) wins while it is live.
    const joined = aliasRec?.peer_pid !== undefined ? this.claudeAdapter() : undefined;
    if (joined) return joined;
    const existing = this.claudeOwned.get('claude');
    if (existing) return new ClaudeOwnedAdapter(existing);
    const rec = readOwnership(this.deps.busRoot, 'claude');
    // M2: a session another LIVE window owns is never re-spawned here. This
    // window does not hold its stdio pipe, so it cannot drive it; spawning a
    // second owned Claude for the same session would leave two live pipes on
    // one alias. Fall back to the user-opened peer/relay (non-observing).
    if (rec?.owner_host && this.isForeignLiveOwner(rec.owner_host)) {
      return this.claudeAdapter();
    }
    // A prior owned session resumes (M3). Otherwise an open session in this
    // workspace (non-observing), else Forge creates its own .
    if (rec?.session_id || (aliasRec && aliasRec.peer_pid === undefined)) {
      const result = await this.ensureOwnedClaude('claude');
      return 'error' in result ? undefined : result;
    }
    const peer = this.claudeAdapter();
    if (peer) return peer;
    const created = await this.ensureOwnedClaude('claude');
    return 'error' in created ? undefined : created;
  }

  private claudeAdapter(): MeshAdapter | undefined {
    const bus = this.deps.getConfig().agent_bus;
    const sessions = this.deps.claudeSessions ? this.deps.claudeSessions() : readClaudeSessions();
    const joinedPid = getAlias(this.deps.busRoot, 'claude')?.peer_pid;
    const picked = pickClaudePeer(
      sessions,
      { joinedPid, pin: bus?.claude_session },
      this.deps.workspaceRoots(),
    );
    if ('error' in picked) return undefined;
    const send = this.deps.sendClaude ?? defaultSendClaude(this.deps.getConfig().agent_bus);
    return new ClaudePeerAdapter(picked.session, send);
  }

  private codexAdapterCtx() {
    return {
      ownedCodex: this.owned.get('codex'),
      getConfig: this.deps.getConfig,
      busRoot: this.deps.busRoot,
      ...(this.deps.queueCodex ? { queueCodex: this.deps.queueCodex } : {}),
    };
  }

  /**
   * The non-observing queue adapter, but only when the config pin is a LIVE
   * thread (F-05). A dead UUID in `agent_bus.codex_thread` is not a live
   * identity: returning no adapter makes `tell` refuse rather than record an
   * accepted exchange against a ghost thread.
   */
  private async codexAdapterIfLive(): Promise<MeshAdapter | undefined> {
    return codexQueueAdapterIfLive(this.codexAdapterCtx());
  }

  /**
   * Ensure an owned Codex session for the alias, creating or
   * resuming (M3) as needed. The single async creation path. Idempotent: a
   * concurrent call for the same alias awaits the same in-flight creation.
   */
  ensureOwnedCodex(alias: string): Promise<MeshAdapter | { error: string }> {
    const a = alias.trim().toLowerCase();
    if (this.reaping.has(a))
      return Promise.resolve({ error: `owned ${a} session is being reaped; try again shortly` });
    const existing = this.owned.get(a);
    if (existing) return Promise.resolve(new CodexOwnedAdapter(existing));
    const inflight = this.creating.get(a);
    if (inflight) return inflight;
    const promise = this.createOwnedCodex(a).finally(() => this.creating.delete(a));
    this.creating.set(a, promise);
    return promise;
  }

  private async createOwnedCodex(alias: string): Promise<MeshAdapter | { error: string }> {
    const start = await beginCreation(
      this.deps.busRoot,
      alias,
      (o) => this.isForeignLiveOwner(o),
      this.deps,
    );
    if (start.kind === 'join') {
      const fallback = await this.codexAdapterIfLive();
      return fallback ?? { error: `another window owns the ${alias} session` };
    }
    if (start.kind === 'refuse') return { error: start.error };
    const { host, rec, aliasRec } = start;
    const threadId = rec?.thread_id ?? aliasRec?.session_id;
    try {
      const bus = this.deps.getConfig().agent_bus;
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
   * Ensure an owned Claude session for the alias, creating or
   * resuming (M3) as needed. The single async creation path for Claude. The
   * `sessionId` (Claude session id) is the resume identity — the equivalent of
   * Codex's `thread_id`. Idempotent: a concurrent call for the same alias
   * awaits the same in-flight creation.
   */
  ensureOwnedClaude(alias: string): Promise<MeshAdapter | { error: string }> {
    const a = alias.trim().toLowerCase();
    if (this.reaping.has(a))
      return Promise.resolve({ error: `owned ${a} session is being reaped; try again shortly` });
    const existing = this.claudeOwned.get(a);
    if (existing) return Promise.resolve(new ClaudeOwnedAdapter(existing));
    const inflight = this.creating.get(a);
    if (inflight) return inflight;
    const promise = this.createOwnedClaude(a).finally(() => this.creating.delete(a));
    this.creating.set(a, promise);
    return promise;
  }

  private async createOwnedClaude(alias: string): Promise<MeshAdapter | { error: string }> {
    const start = await beginCreation(
      this.deps.busRoot,
      alias,
      (o) => this.isForeignLiveOwner(o),
      this.deps,
    );
    if (start.kind === 'join')
      return this.claudeAdapter() ?? { error: `another window owns the ${alias} session` };
    if (start.kind === 'refuse') return { error: start.error };
    const { host, rec } = start;
    // A joined (user-opened) record is not an owned identity: never resumed here.
    const aliasRec = start.aliasRec?.peer_pid === undefined ? start.aliasRec : undefined;
    const sessionId = rec?.session_id || aliasRec?.session_id || undefined;
    try {
      const bus = this.deps.getConfig().agent_bus;
      const executable = await resolveCliExecutable(bus?.claude_cli ?? 'claude', 'claude');
      const factory = this.deps.claudeFactory ?? defaultClaudeFactory();
      const session = await factory.create({
        alias,
        sessionId,
        executable,
        cwd: this.deps.workspaceRoots()[0] ?? os.homedir(),
      });

      const newSessionId = session.confirmedSessionId ?? sessionId;
      this.claudeOwned.set(alias, session);
      writeOwnership(this.deps.busRoot, {
        alias,
        agent: 'claude',
        session_id: newSessionId ?? '',
        owner_host: host,
        workspace: this.deps.workspaceRoots()[0] ?? '',
        created_at: Date.now(),
        parked: false,
      });
      if (!aliasRec) {
        registerAlias(this.deps.busRoot, alias, {
          agent: 'claude',
          session_id: newSessionId ?? '',
          registered_at: Date.now(),
          by: 'forge',
        });
      }
      return new ClaudeOwnedAdapter(session);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      // M3: a failed RESUME (a prior session existed) is a visible context loss
      // — the plan never swaps in a fresh session silently. A fresh creation
      // failing (no prior session) is just a creation error.
      if (sessionId && this.deps.onContextLost) {
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
   * (recoverOwnership); the resume identity is kept for the next creation.
   */
  async reap(alias: string): Promise<void> {
    const a = alias.trim().toLowerCase();
    if (this.reaping.has(a)) return;
    this.reaping.add(a);
    try {
      const codex = this.owned.get(a);
      const claude = this.claudeOwned.get(a);
      if (!codex && !claude) return;
      this.owned.delete(a);
      this.claudeOwned.delete(a);
      if (codex) await codex.dispose();
      if (claude) await claude.dispose();
    } finally {
      this.reaping.delete(a);
    }
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
    // F-02: only the live owner may mutate the record. A peer window parking
    // another window's session would corrupt the ownership it does not hold.
    if (rec.owner_host && !this.isOwner(a)) return false;
    writeOwnership(this.deps.busRoot, { ...rec, parked: true });
    return true;
  }

  /** Wake a parked session (§2b). Clears `parked`; `undefined` when no record. */
  wake(alias: string): boolean {
    const a = alias.trim().toLowerCase();
    const rec = readOwnership(this.deps.busRoot, a);
    if (!rec) return false;
    // F-02: owner-only mutation (a peer window must not wake a session it does not hold).
    if (rec.owner_host && !this.isOwner(a)) return false;
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
    // F-02: only the live owner may close. A peer window that cleared another
    // window's `owner_host` would orphan the live stdio pipe (the process keeps
    // running with no owner record, and a later message spawns a second pipe on
    // the same alias). Refuse: the owner window must close its own session.
    if (rec.owner_host && !this.isOwner(a)) return false;
    const codex = this.owned.get(a);
    const claude = this.claudeOwned.get(a);
    if (codex) {
      this.owned.delete(a);
      await codex.dispose();
    }
    if (claude) {
      this.claudeOwned.delete(a);
      await claude.dispose();
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
    const sessions = [...this.owned.values(), ...this.claudeOwned.values()];
    this.owned.clear();
    this.claudeOwned.clear();
    await Promise.all(sessions.map((s) => s.dispose()));
  }
}
