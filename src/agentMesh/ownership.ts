import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { getHostIdentity, isHostAlive, type HostId, type HostLivenessDeps } from './hostIdentity';
import { getAlias, registerAlias, type AgentKind } from './aliasRegistry';

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
  /**
   * F-07: the last activity timestamp (a message sent or received on the
   * owned session). The idle TTL reaper uses this to reap a long-idle owned
   * session (keeping `thread_id` for resume). Absent on older records.
   */
  last_activity?: number;
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
      ...(typeof rec.last_activity === 'number' ? { last_activity: rec.last_activity } : {}),
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
  deps: HostLivenessDeps = {},
): ClaimResult {
  const alive = deps.isHostAlive ?? ((h: HostId) => isHostAlive(h, deps));
  const file = claimPath(root, alias);
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
      // Torn/empty: no host to prove dead. M2 says reclaim only on proven
      // death, so we never steal it — and we never block on it (a synchronous
      // wait would freeze the extension host). Report "in progress"; the
      // caller backs off. A genuinely orphaned torn claim (crash mid-write) is
      // rare and self-limits: it cannot cause a double spawn, and it is cleared
      // by a later provably-dead reclaim or owner-host-death recovery.
      return { claimed: false };
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
    // F-04: a torn/empty claim with a matching record is a leftover (the
    // claimant finished and released its claim). Clear it so it cannot
    // deadlock every later first creation.
    clearTornClaimWithRecord(root, alias);
    if (rec.owner_host && alive(rec.owner_host)) {
      actions.push({ alias, action: 'untouched' });
      continue;
    }
    // F-02: an already-null owner is a CLEAN close (or a prior reap), not a
    // crash. Reporting it as `reaped` would emit a false `crash-<alias>` board
    // event on every restart. Only a record that named a now-dead host is a
    // genuine reap.
    if (!rec.owner_host) {
      actions.push({ alias, action: 'untouched' });
      continue;
    }
    // Owner host dead: reap, keep thread_id.
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

/**
 * Is `owner` THIS host? The pid is the discriminator: a foreign window has a
 * different pid, so a pid match means the record is ours. `isHostAlive` alone
 * is wrong here — it returns true for a foreign live host too, which would let
 * a peer window pass an owner check and mutate a session it does not own (the
 * F-02 defect). The start time is deliberately NOT re-checked: the M1
 * `isHostAlive` guard carries it for liveness decisions, and re-checking it
 * here would be load-fragile (under CPU pressure the Windows start-time read
 * can fall back to `Date.now()`, which will not match the record's OS start
 * time and would wrongly reject a correct pid match). A recycled pid is the
 * only false-positive risk, and it is rare.
 */
export function isOwnerOf(
  deps: HostLivenessDeps,
  owner: { pid: number; startedAt: number },
): boolean {
  return owner.pid === getHostIdentity(deps).pid;
}

/**
 * Is `owner` a live host that is NOT this one? `isHostAlive` is true for self,
 * so the pid comparison is what separates "I own it" (resume is safe) from
 * "another window owns it" (never race it).
 */
export function isForeignLiveOwner(
  deps: HostLivenessDeps,
  owner: { pid: number; startedAt: number },
): boolean {
  if (!isHostAlive(owner, deps)) return false;
  return owner.pid !== getHostIdentity(deps).pid;
}

/**
 * F-04: wait (bounded, async) for an ownership record to appear. A second
 * caller that loses the creation lease to a live holder polls until the holder
 * writes its record (or the deadline), so it can join the peer's session
 * instead of reporting "in progress" while the peer is about to be ready.
 * Returns the record once present, or undefined on timeout.
 */
export async function waitForRecord(
  root: string,
  alias: string,
  deadlineMs: number,
): Promise<OwnershipRecord | undefined> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const rec = readOwnership(root, alias);
    if (rec) return rec;
    if (Date.now() >= end) return undefined;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * F-04: a torn/empty claim file that names no host is not proof of death, so
 * `claimCreation` never reclaims it. But if the ownership record for that alias
 * already exists, the claimant finished and released its claim — the torn file
 * is a leftover that would otherwise deadlock every later first creation. This
 * clears it. Returns true when a leftover claim was removed.
 */
export function clearTornClaimWithRecord(root: string, alias: string): boolean {
  const file = claimPath(root, alias);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false; // no claim
  }
  let rec: ClaimRecord | undefined;
  try {
    rec = JSON.parse(raw) as ClaimRecord;
  } catch {
    rec = undefined; // torn/empty
  }
  if (rec && Number.isFinite(rec.host_pid) && Number.isFinite(rec.host_started_at)) {
    return false; // well-formed: leave it to the normal dead-holder reclaim
  }
  if (!readOwnership(root, alias)) return false; // no record: a live creator may be mid-spawn
  unlinkQuiet(file);
  return true;
}

/**
 * Save an owned session's id once its first turn has confirmed it. Creation
 * writes the record before a fresh session has an id, so without this the
 * record kept `""` and every reload "resumed" into a new, empty thread.
 */
export function recordConfirmedId(root: string, alias: string, id: string | undefined): void {
  if (!id) return;
  const rec = readOwnership(root, alias);
  if (rec && rec.session_id !== id) {
    const thread = rec.agent === 'codex' ? { thread_id: id } : {};
    writeOwnership(root, { ...rec, session_id: id, ...thread });
  }
  const aliasRec = getAlias(root, alias);
  if (aliasRec?.peer_pid !== undefined || aliasRec?.session_id === id) return;
  if (aliasRec?.by === 'user') return; // a user's pin is theirs to change
  registerAlias(root, alias, {
    agent: rec?.agent ?? (alias === 'codex' ? 'codex' : 'claude'),
    session_id: id,
    registered_at: Date.now(),
    by: 'forge',
  });
}
