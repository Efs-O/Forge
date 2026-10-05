import * as os from 'os';
import type { ForgeConfig } from '../config/types';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import type { CodexAppServerSession } from '../agents/CodexAppServerSession';
import type { AliasRecord } from './aliasRegistry';
import { CodexOwnedAdapter, standInDeliveryLabel } from './adapters';
import { defaultCodexFactory, type OwnedCodexFactory } from './creationPreamble';
import type { MeshAdapter } from './meshAdapter';

/**
 * The stand-in that answers for a user-joined Codex whose window is closed
 * (CODEX_STAND_IN_PLAN).
 *
 * A user-joined Codex (`forge.sh join codex`, `by: "user"`) is an interactive
 * thread. While its window is open it has an active writer, so Forge reaches
 * it through `codex queue` (the non-observing queue adapter). When the window
 * is CLOSED there is no writer, and Forge spawns a transient headless
 * `codex app-server` that resumes that exact thread, answers through the mesh,
 * and disposes itself after one FIFO drain.
 *
 * The live/dead decision is made by the resume attempt itself: `thread/resume`
 * fails with `already has an active writer` exactly when a window holds the
 * thread (Phase 0). On that error the stand-in disposes and falls back to the
 * queue adapter; it never kills or races the user's process.
 *
 * A stand-in is NOT an owned session: it never enters the provider's owned
 * map, and nothing here writes an ownership or alias record. M3 resume,
 * recovery and the TTL reaper cannot see it, and the user's thread id can
 * never leak into `ownership/codex.json`. It lives for one FIFO drain
 * (`onIdle`), a writer-conflict fallback, a standby timeout (created but
 * never sent to), or provider dispose.
 */

/** The exact substring Phase 0 recorded from `thread/resume` on a held thread. */
const WRITER_CONFLICT = 'already has an active writer';

/** A resume that hangs (dead CLI, wedged protocol) must not wedge the alias:
 *  the `creating` promise would pin every later codex resolve to it. */
const RESUME_TIMEOUT_MS = 30_000;

/** A stand-in that is created but never sent to (a failed durable enqueue, a
 *  resolve that only reads the note) would otherwise hold the thread's writer
 *  until the host exits; one unused this long is disposed. */
const STANDBY_TIMEOUT_MS = 60_000;

const DEAD = '⚠️ The Codex session the user joined is not running (its window is closed)';

/** Shown to the agent with the result whenever a stand-in answers for a dead joined session. */
export function codexStandInNote(threadId: string | undefined): string {
  return threadId
    ? `${DEAD}, so Forge resumed that thread headless to answer; the answer is in its history. ` +
        `Tell the user: reopening that window continues it there.`
    : `${DEAD}, so a Forge-owned Codex session answered instead. It does NOT have the ` +
        `context of the joined conversation (the join recorded no thread id). Tell the user, ` +
        `and that reopening that window and running \`forge.sh join codex\` there reconnects ` +
        `their own session.`;
}

/** The same event, addressed to the user (VS Code, Telegram) rather than to the agent. */
export function codexStandInUserNote(threadId: string | undefined): string {
  return threadId
    ? `⚠️ Your Codex session was closed, so Forge answered for it headless. The answer is ` +
        `in that session's history; reopening its window continues it.`
    : `⚠️ Your Codex session was closed, so a separate Forge-owned Codex answered without ` +
        `its context. Reopen that window and run \`forge.sh join codex\` there to reconnect it.`;
}

export interface CodexStandInDeps {
  busRoot: string;
  getConfig: () => ForgeConfig;
  workspaceRoots: () => string[];
  /** Injectable for tests; production spawns a real app-server. */
  codexFactory?: OwnedCodexFactory;
  /** Tells the user a stand-in answered for a dead joined session (plan Phase 2). */
  onStandIn?: (alias: string, note: string) => void;
  /**
   * The non-observing queue-adapter fallback when the thread has a live writer.
   * The provider passes `() => this.factory.codexAdapterIfLive()`, so the
   * stand-in reuses the existing queue-adapter path instead of building its own
   * `CodexPinContext`.
   */
  queueAdapter: () => Promise<MeshAdapter | undefined>;
}

interface StandInEntry {
  session: CodexAppServerSession;
  adapter: MeshAdapter | undefined;
  /** True once the FIFO has sent the first message (onIdle owns the lifetime). */
  used: boolean;
  /** Safety net for a stand-in that is never sent to (STANDBY_TIMEOUT_MS). */
  standby: ReturnType<typeof setTimeout> | undefined;
}

export class CodexStandIn {
  private standIn: StandInEntry | undefined;
  private creating: Promise<MeshAdapter | undefined> | undefined;
  /** Makes each stand-in's key unique, so the FIFO never reuses a disposed one. */
  private seq = 0;
  /** Set by dispose(): a racing creation observes it and tears itself down. */
  private disposed = false;

  constructor(private readonly deps: CodexStandInDeps) {}

  /** A user-joined alias: a live stand-in, else one that resumes its thread. */
  async resolve(aliasRec: AliasRecord): Promise<MeshAdapter | undefined> {
    if (this.disposed) return undefined;
    if (this.standIn) return this.standIn.adapter;
    this.creating ??= this.createStandIn(aliasRec).finally(() => {
      this.creating = undefined;
    });
    return this.creating;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Let an in-flight creation finish so it observes `disposed` and tears its
    // session down itself; otherwise a dispose racing the eager resume would
    // leave a resumed app-server holding the thread's writer (audit, major 1).
    await this.creating;
    await this.disposeStandIn();
  }

  private async createStandIn(aliasRec: AliasRecord): Promise<MeshAdapter | undefined> {
    const threadId = aliasRec.session_id || undefined;
    const bus = this.deps.getConfig().agent_bus;
    const cwd = this.deps.workspaceRoots()[0] ?? os.homedir();
    let session: CodexAppServerSession;
    try {
      // Injected factories are test doubles; see createOwnedCodex.
      const executable = this.deps.codexFactory
        ? (bus?.codex_cli ?? 'codex')
        : await resolveCliExecutable(bus?.codex_cli ?? 'codex', 'codex');
      session = await (this.deps.codexFactory ?? defaultCodexFactory()).create({
        alias: 'codex',
        threadId,
        executable,
        cwd,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.deps.onStandIn?.('codex', `${DEAD}, and Forge could not start a stand-in: ${why}`);
      return undefined;
    }
    // Eager resume (Phase 1–2): the live/dead decision is made here, before an
    // adapter is handed out. `ensureStarted` is idempotent, so the first
    // `send` reuses this same start. Bounded: a hang must not wedge the alias
    // (the `creating` promise would pin every later codex resolve to it).
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        session.ensureStarted(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${RESUME_TIMEOUT_MS} ms`)),
            RESUME_TIMEOUT_MS,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      await session.dispose();
      if (this.disposed) return undefined;
      if (why.includes(WRITER_CONFLICT)) {
        // A window holds the thread: fall back to the queue adapter. Never
        // kill or race the user's process (invariant 4). No stand-in note —
        // the answer is going to the live window, not a stand-in.
        return this.deps.queueAdapter();
      }
      // Mismatched id, protocol error, or timeout: refuse plainly and start no
      // fresh thread (invariant 5). A failed resume is unknown, never proof of
      // death.
      this.deps.onStandIn?.('codex', `${DEAD}, and Forge could not resume it: ${why}`);
      return undefined;
    }
    if (this.disposed) {
      // A provider dispose raced the eager resume: tear the session down and
      // hand out neither an adapter nor a note after teardown (audit, major 1).
      await session.dispose();
      return undefined;
    }
    const inner = new CodexOwnedAdapter(
      session,
      // No `onTurnEnd`: the stand-in must not record the thread into an
      // ownership record (invariant 2). The thread id is already known (it was
      // resumed with it), and Codex `thread/resume` never forks.
      undefined,
      // No idle callback: the FIFO holds the OUTER adapter, whose `onIdle`
      // disposes; the inner one's would never be called.
      undefined,
    );
    const entry: StandInEntry = { session, adapter: undefined, used: false, standby: undefined };
    const adapter: MeshAdapter = {
      kind: 'codex',
      observesTurns: true,
      key: `codex-stand-in:${threadId ?? 'blank'}:${++this.seq}`,
      note: codexStandInNote(threadId),
      deliveredTo: standInDeliveryLabel('codex', threadId, this.deps.workspaceRoots()[0]),
      send: (message, options) => {
        // First real use: the FIFO now owns the lifetime (onIdle), so the
        // standby safety net no longer applies.
        entry.used = true;
        if (entry.standby) clearTimeout(entry.standby);
        return inner.send(message, options);
      },
      interrupt: () => inner.interrupt(),
      onIdle: () =>
        void this.disposeStandIn(adapter).catch((err: unknown) =>
          this.deps.onStandIn?.('codex', `The Codex stand-in did not stop cleanly: ${String(err)}`),
        ),
    };
    entry.adapter = adapter;
    // Safety net (audit, major 2): a resolve that never reaches a FIFO — a
    // failed durable enqueue, a resolve that only reads the note — would
    // otherwise hold the thread's writer until the host exits. A stand-in
    // never sent to within STANDBY_TIMEOUT_MS is disposed.
    entry.standby = setTimeout(() => {
      if (this.standIn === entry && !entry.used) {
        void this.disposeStandIn(adapter).catch((err: unknown) =>
          this.deps.onStandIn?.('codex', `The Codex stand-in did not stop cleanly: ${String(err)}`),
        );
      }
    }, STANDBY_TIMEOUT_MS);
    this.standIn = entry;
    this.deps.onStandIn?.('codex', codexStandInUserNote(threadId));
    return adapter;
  }

  /** Dispose the current stand-in; with `only`, only if it is still that one. */
  private async disposeStandIn(only?: MeshAdapter): Promise<void> {
    const current = this.standIn;
    if (!current || (only && current.adapter !== only)) return;
    this.standIn = undefined;
    if (current.standby) clearTimeout(current.standby);
    await current.session.dispose();
  }
}
