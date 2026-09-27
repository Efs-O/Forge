import * as os from 'os';
import type { ForgeConfig } from '../config/types';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import type { CodexAppServerSession } from '../agents/CodexAppServerSession';
import type { ClaudeOwnedSession } from '../agents/ClaudeOwnedSession';
import { queueToCodex } from '../agentBus/codexDelivery';
import { registerAlias } from './aliasRegistry';
import { ClaudeOwnedAdapter, CodexOwnedAdapter } from './adapters';
import { CodexIdleRelease } from './codexIdleRelease';
import { codexQueueAdapterIfLive } from './codexPinLiveness';
import {
  beginCreation,
  defaultClaudeFactory,
  defaultCodexFactory,
  type OwnedClaudeFactory,
  type OwnedCodexFactory,
} from './creationPreamble';
import type { MeshAdapter } from './meshAdapter';
import type { HostLivenessDeps } from './hostIdentity';
import { isForeignLiveOwner, recordConfirmedId, releaseClaim, writeOwnership } from './ownership';

/**
 * The Forge-owned Codex and Claude session construction (P2). Extracted from
 * `sessionProvider.ts` (at the 500-line lint limit) the same way the Copilot
 * owned path lives in `copilotOwned.ts`. The factory owns the in-memory
 * session maps, the in-flight creation dedup, the idle-release handles, and
 * the single async create/ensure path for each agent. The `MeshSessionProvider`
 * keeps alias resolution, the FIFO-facing orchestration, and the record-based
 * lifecycle (park/wake/reap/close/dispose), delegating the in-memory session
 * work here.
 */

export interface OwnedSessionFactoryDeps extends HostLivenessDeps {
  busRoot: string;
  getConfig: () => ForgeConfig;
  workspaceRoots: () => string[];
  /** Injectable for tests; production runs `codex queue`. */
  queueCodex?: typeof queueToCodex;
  /** Injectable for tests; production spawns a real app-server. */
  codexFactory?: OwnedCodexFactory;
  /** Injectable for tests; production spawns a real owned Claude stdio session. */
  claudeFactory?: OwnedClaudeFactory;
  /** Called when a session RESUME fails (M3): a visible `context_lost` event. */
  onContextLost?: (alias: string, reason: string) => void;
  /** The provider's joined-Claude peer adapter (the join fallback). */
  claudePeerAdapter: () => MeshAdapter | undefined;
}

export class OwnedSessionFactory {
  private readonly owned = new Map<string, CodexAppServerSession>();
  private readonly claudeOwned = new Map<string, ClaudeOwnedSession>();
  private readonly creating = new Map<string, Promise<MeshAdapter | { error: string }>>();
  private readonly codexIdleRelease = new CodexIdleRelease();

  constructor(private readonly deps: OwnedSessionFactoryDeps) {}

  /** The in-memory owned Codex session for an alias, if this window holds it. */
  getOwnedCodex(alias: string): CodexAppServerSession | undefined {
    return this.owned.get(alias.trim().toLowerCase());
  }

  /** The in-memory owned Claude session for an alias, if this window holds it. */
  getOwnedClaude(alias: string): ClaudeOwnedSession | undefined {
    return this.claudeOwned.get(alias.trim().toLowerCase());
  }

  isOwned(alias: string): boolean {
    const a = alias.trim().toLowerCase();
    return this.owned.has(a) || this.claudeOwned.has(a);
  }

  /** Wait for an in-flight idle release of the alias's Codex app-server. */
  async waitCodexIdle(alias: string): Promise<void> {
    await this.codexIdleRelease.wait(alias.trim().toLowerCase());
  }

  codexOwnedAdapter(alias: string, s: CodexAppServerSession): CodexOwnedAdapter {
    return new CodexOwnedAdapter(
      s,
      () => recordConfirmedId(this.deps.busRoot, alias, s.confirmedSessionId, this.deps),
      () => this.releaseCodexWhenIdle(alias, s),
    );
  }

  claudeOwnedAdapter(alias: string, s: ClaudeOwnedSession): ClaudeOwnedAdapter {
    return new ClaudeOwnedAdapter(s, () =>
      recordConfirmedId(this.deps.busRoot, alias, s.confirmedSessionId, this.deps),
    );
  }

  private releaseCodexWhenIdle(alias: string, session: CodexAppServerSession): void {
    if (this.owned.get(alias) !== session) return;
    this.owned.delete(alias);
    this.codexIdleRelease.release(alias, session);
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
  async codexAdapterIfLive(): Promise<MeshAdapter | undefined> {
    return codexQueueAdapterIfLive(this.codexAdapterCtx());
  }

  private isForeignLiveOwner(owner: { pid: number; startedAt: number }): boolean {
    return isForeignLiveOwner(this.deps, owner);
  }

  /**
   * Ensure an owned Codex session for the alias, creating or
   * resuming (M3) as needed. The single async creation path. Idempotent: a
   * concurrent call for the same alias awaits the same in-flight creation.
   */
  ensureOwnedCodex(alias: string): Promise<MeshAdapter | { error: string }> {
    const a = alias.trim().toLowerCase();
    const existing = this.owned.get(a);
    if (existing) return Promise.resolve(this.codexOwnedAdapter(a, existing));
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
        registerAlias(
          this.deps.busRoot,
          alias,
          {
            agent: 'codex',
            session_id: newThreadId ?? '',
            registered_at: Date.now(),
            by: 'forge',
          },
          this.deps,
        );
      }
      return this.codexOwnedAdapter(alias, session);
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
    const existing = this.claudeOwned.get(a);
    if (existing) return Promise.resolve(this.claudeOwnedAdapter(a, existing));
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
      return this.deps.claudePeerAdapter() ?? { error: `another window owns the ${alias} session` };
    if (start.kind === 'refuse') return { error: start.error };
    const { host, rec } = start;
    // A joined (user-opened) record is not an owned identity: never resumed here.
    const aliasRec = start.aliasRec?.peer_pid === undefined ? start.aliasRec : undefined;
    const sessionId = rec?.session_id || aliasRec?.session_id || undefined;
    try {
      const bus = this.deps.getConfig().agent_bus;
      const factory = this.deps.claudeFactory ?? defaultClaudeFactory();
      // Injected factories are already test doubles; resolving a real CLI
      // before calling them makes the deterministic mesh tests depend on the
      // host having Claude installed. Production still resolves the configured
      // executable through the default factory path.
      const executable = this.deps.claudeFactory
        ? (bus?.claude_cli ?? 'claude')
        : await resolveCliExecutable(bus?.claude_cli ?? 'claude', 'claude');
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
      if (!start.aliasRec) {
        registerAlias(
          this.deps.busRoot,
          alias,
          {
            agent: 'claude',
            session_id: newSessionId ?? '',
            registered_at: Date.now(),
            by: 'forge',
          },
          this.deps,
        );
      }
      return this.claudeOwnedAdapter(alias, session);
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
   * Reap the in-memory owned Codex/Claude session for an alias (owner-host-death
   * recovery, M2/M3). The ownership record's `owner_host` is cleared by the
   * caller (recoverOwnership); the resume identity is kept for the next creation.
   */
  async reapInMemory(alias: string): Promise<void> {
    const a = alias.trim().toLowerCase();
    await this.codexIdleRelease.wait(a);
    const codex = this.owned.get(a);
    const claude = this.claudeOwned.get(a);
    if (!codex && !claude) return;
    this.owned.delete(a);
    this.claudeOwned.delete(a);
    if (codex) await codex.dispose();
    if (claude) await claude.dispose();
  }

  /**
   * Dispose the in-memory owned Codex/Claude session for an alias (the
   * provider's `close` calls this after its ownership check + record clear).
   */
  async closeInMemory(alias: string): Promise<void> {
    const a = alias.trim().toLowerCase();
    await this.codexIdleRelease.wait(a);
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
  }

  /** Dispose all in-memory owned sessions (window shutdown). */
  async disposeAll(): Promise<void> {
    const sessions = [...this.owned.values(), ...this.claudeOwned.values()];
    this.owned.clear();
    this.claudeOwned.clear();
    await Promise.all([...sessions.map((s) => s.dispose()), ...this.codexIdleRelease.all()]);
  }
}
