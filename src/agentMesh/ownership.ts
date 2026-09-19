import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHostIdentity, isHostAlive, type HostId, type HostLivenessDeps } from './hostIdentity';
import type { AgentKind } from './aliasRegistry';

/**
 * Per-alias ownership of Forge-owned sessions (AGENT_MESH_PLAN §0, M2, M3).
 *
 * Records are **per alias** (`ownership/<alias>.json`), not one shared file
 * several windows rewrite (last-writer-wins loses updates). Each record names
 * the host that holds the stdio pipe as `owner_host: {pid, startedAt}`.
 *
 * The load-bearing rule (M2): **startup recovery may reap a session only if
 * its `owner_host` is dead.** "The pid is alive but *I* don't hold its pipe"
 * is the normal state for a session another open window owns; reaping on that
 * would kill a peer window's live session.
 *
 * M3: when the owner host is dead, recovery reaps the orphan process but
 * **keeps `thread_id`** so the next message resumes the same thread (no
 * consent, full context). A user-opened session has no ownership record and is
 * never reaped.
 */

export const OWNERSHIP_DIR_NAME = 'ownership';

export interface OwnershipRecord {
  alias: string;
  agent: AgentKind;
  /** The session identity (Claude session name / Codex thread id at creation). */
  session_id: string;
  /** The Codex thread id to resume. Kept across reaps (M3). */
  thread_id?: string;
  /**
   * The host holding the stdio pipe. `null` means no live owner, but a
   * `thread_id` (when present) is still resumable by the next creation.
   */
  owner_host: HostId | null;
  workspace: string;
  created_at: number;
  /** Parked (park-but-warm): exempt from the idle TTL (M4). */
  parked: boolean;
}

export interface ClaimRecord {
  host_pid: number;
  host_started_at: number;
  token: string;
  claimed_at: number;
}

export function ownershipDir(root: string): string {
  return path.join(root, OWNERSHIP_DIR_NAME);
}

export function ownershipPath(root: string, alias: string): string {
  return path.join(ownershipDir(root), `${alias}.json`);
}

export function claimPath(root: string, alias: string): string {
  return path.join(ownershipDir(root), `${alias}.claim`);
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

// ---------------------------------------------------------------------------
// Ownership records
// ---------------------------------------------------------------------------

export function readOwnership(root: string, alias: string): OwnershipRecord | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(ownershipPath(root, alias), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const rec = JSON.parse(raw) as Partial<OwnershipRecord>;
    if (typeof rec.alias !== 'string' || (rec.agent !== 'claude' && rec.agent !== 'codex'))
      return undefined;
    return {
      alias: rec.alias,
      agent: rec.agent,
      session_id: typeof rec.session_id === 'string' ? rec.session_id : '',
      ...(typeof rec.thread_id === 'string' ? { thread_id: rec.thread_id } : {}),
      owner_host:
        rec.owner_host &&
        typeof rec.owner_host === 'object' &&
        Number.isFinite((rec.owner_host as HostId).pid)
          ? (rec.owner_host as HostId)
          : null,
      workspace: typeof rec.workspace === 'string' ? rec.workspace : '',
      created_at: typeof rec.created_at === 'number' ? rec.created_at : 0,
      parked: rec.parked === true,
    };
  } catch {
    return undefined; // corrupt: treat as absent; the next write repairs it
  }
}

export function writeOwnership(root: string, record: OwnershipRecord): void {
  writeAtomic(ownershipPath(root, record.alias), `${JSON.stringify(record, null, 2)}\n`);
}

export function removeOwnership(root: string, alias: string): void {
  unlinkQuiet(ownershipPath(root, alias));
}

/** All owned aliases (for startup recovery). */
export function listOwnedAliases(root: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(ownershipDir(root));
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length));
}

// ---------------------------------------------------------------------------
// Creation lease (M2): prevents a concurrent double-spawn.
// ---------------------------------------------------------------------------

export type ClaimResult = { claimed: true } | { claimed: false; holder?: HostId };

/**
 * Claim the creation lease for an alias. O_EXCL create; if the claim exists and
 * its holder is alive, we lose (we wait on the record instead of racing). A
 * claim whose holder is **proven dead** — or that names our own pid — is
 * reclaimed.
 *
 * M2 safety: a torn or empty claim file (a claimant mid-write, or a crash
 * mid-write) names no host, so it is **not** proof of death. Reclaiming it
 * would race a possibly-live creator into a double spawn. Instead the waiter
 * waits (bounded by `deadlineMs`) and then reports "in progress" — it never
 * reclaims a claim it cannot attribute to a dead host. A genuinely orphaned
 * torn claim (crash mid-write) is rare and self-limits: the next owner-host
 * death recovery clears it, and no second spawn is ever started in the mean
 * time.
 */
export function claimCreation(
  root: string,
  alias: string,
  host: HostId,
  deps: HostLivenessDeps & { deadlineMs?: number } = {},
): ClaimResult {
  const alive = deps.isHostAlive ?? ((h: HostId) => isHostAlive(h, deps));
  const file = claimPath(root, alias);
  const deadline = Date.now() + (deps.deadlineMs ?? 120_000);
  fs.mkdirSync(ownershipDir(root), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        const rec: ClaimRecord = {
          host_pid: host.pid,
          host_started_at: host.startedAt,
          token: randomUUID(),
          claimed_at: Date.now(),
        };
        fs.writeSync(fd, JSON.stringify(rec));
      } finally {
        fs.closeSync(fd);
      }
      return { claimed: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // Claim exists. Read it.
    let rec: ClaimRecord | undefined;
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8')) as ClaimRecord;
    } catch {
      rec = undefined; // torn or empty
    }
    const holder: HostId | undefined =
      rec && Number.isFinite(rec.host_pid) && Number.isFinite(rec.host_started_at)
        ? { pid: rec.host_pid, startedAt: rec.host_started_at }
        : undefined;
    if (!holder) {
      // Torn/empty: no host to prove dead. Never reclaim — wait (bounded).
      if (Date.now() >= deadline) return { claimed: false };
      sleepSync(20);
      continue;
    }
    if (holder.pid === host.pid) {
      // Ours: reclaim (a leftover from a prior attempt in this host).
      unlinkQuiet(file);
      continue;
    }
    if (!alive(holder)) {
      // Claimant proven dead: reclaim.
      unlinkQuiet(file);
      continue;
    }
    // Holder alive: we lose.
    return { claimed: false, holder };
  }
}

/** A short synchronous pause (the claim wait is not a hot loop). */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

export function releaseClaim(root: string, alias: string): void {
  unlinkQuiet(claimPath(root, alias));
}

/**
 * Is the creation claim for an alias stale (its holder proven dead)? A torn or
 * empty claim names no host, so it is NOT stale — it is not proof of death, and
 * reclaiming it would race a possibly-live creator (M2). Only a claim whose
 * named host is dead is stale.
 */
export function isClaimStale(root: string, alias: string, deps: HostLivenessDeps = {}): boolean {
  const alive = deps.isHostAlive ?? ((h: HostId) => isHostAlive(h, deps));
  let rec: ClaimRecord | undefined;
  try {
    rec = JSON.parse(fs.readFileSync(claimPath(root, alias), 'utf8')) as ClaimRecord;
  } catch {
    return false; // no claim
  }
  if (!rec || !Number.isFinite(rec.host_pid) || !Number.isFinite(rec.host_started_at)) return false;
  return !alive({ pid: rec.host_pid, startedAt: rec.host_started_at });
}

// ---------------------------------------------------------------------------
// Startup recovery (M2/M3)
// ---------------------------------------------------------------------------

export type RecoveryAction =
  | { alias: string; action: 'untouched' } // owner host alive (another window)
  | { alias: string; action: 'reaped'; thread_id?: string } // owner host dead: reap, keep thread
  | { alias: string; action: 'orphan-claim' }; // a stale claim with no record

export interface RecoveryResult {
  actions: RecoveryAction[];
}

/**
 * Startup recovery over the ownership records (M2/M3). For each owned alias:
 * - owner host alive → untouched (another window owns it; never race it).
 * - owner host dead → reap: the record's `owner_host` is cleared (kept
 *   `thread_id` for resume, M3), and a `crashed` board event is the caller's
 *   job (this module returns the decision; the caller writes the event and
 *   disposes any in-memory session it holds).
 *
 * A stale creation claim with no matching record is reported as
 * `orphan-claim` so the caller can reclaim it.
 *
 * No notice is sent during a crash (no code runs then); this is the
 * recovery-time pass.
 */
export function recoverOwnership(root: string, deps: HostLivenessDeps = {}): RecoveryResult {
  const alive = deps.isHostAlive ?? ((h: HostId) => isHostAlive(h, deps));
  const actions: RecoveryAction[] = [];
  for (const alias of listOwnedAliases(root)) {
    const rec = readOwnership(root, alias);
    if (!rec) continue;
    if (rec.owner_host && alive(rec.owner_host)) {
      actions.push({ alias, action: 'untouched' });
      continue;
    }
    // Owner host dead (or already null): reap, keep thread_id.
    const updated: OwnershipRecord = { ...rec, owner_host: null };
    writeOwnership(root, updated);
    actions.push({
      alias,
      action: 'reaped',
      ...(rec.thread_id ? { thread_id: rec.thread_id } : {}),
    });
  }
  // Stale claims with no record.
  let names: string[];
  try {
    names = fs.readdirSync(ownershipDir(root));
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.claim')) continue;
    const alias = name.slice(0, -'.claim'.length);
    if (!readOwnership(root, alias) && isClaimStale(root, alias, deps)) {
      actions.push({ alias, action: 'orphan-claim' });
    }
  }
  return { actions };
}

/** Convenience: the current host, for records written by this window. */
export function currentHost(deps: HostLivenessDeps = {}): HostId {
  return getHostIdentity(deps);
}
