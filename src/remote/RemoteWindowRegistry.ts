/**
 * The window files: one record per Forge window, and the count a `new-window`
 * switch is capped against.
 *
 * `globalStorage/remote-windows/<windowId>.json`, keyed by the agent mesh's
 * `HostId` (pid + OS start time), is written at activation, unlinked by that
 * window at `deactivate()`, and pruned by any reader once `isHostAlive` proves
 * the owner dead. **No heartbeat and no busy column**: a heartbeat write every
 * few seconds would reset the modified time every other window's coordinator
 * poll is gated on, and a busy column would be a lie the moment it was written.
 * The close-request and close-result files live in this same folder — see
 * `RemoteWindowClose.ts` — rather than as fields of `remote-state-v2.json`, so a
 * state-file write by any build cannot reach them and an older window's parse is
 * never asked to carry them.
 *
 * The count has no union: on Windows the total IS the OS count and these files
 * only name the windows Close can be offered for, because every window of one
 * VS Code instance belongs to the same `Code.exe` process and there is no pid to
 * join on. Elsewhere the files are the only thing Forge can see, and the refuse
 * message says that is what it counted.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { z } from 'zod';
import type { HostId } from '../agentMesh/hostIdentity';
import { getHostIdentity, isHostAlive } from '../agentMesh/hostIdentity';
import { isProcessAlive } from '../util/processLiveness';
import { writeFileAtomic } from '../util/atomicWrite';
import { workspaceIdFor } from './RemoteWorkspaceHandoff';
import type { ProbeOutcome } from './RemoteWindowsProbe';

const RECORD_SUFFIX = '.json';

/**
 * Where the window files live: `remote-windows/` under the window's global
 * storage. One derivation, because the activation writer, the close handler and
 * the cap check all have to agree on it and global storage is per profile.
 */
export function windowDirectory(storageDirectory: string): string {
  return path.join(storageDirectory, 'remote-windows');
}

const WindowRecordSchema = z.object({
  windowId: z.string().regex(/^\d+-\d+$/u),
  host: z.object({ pid: z.number().int(), startedAt: z.number() }),
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1).max(120),
  /** The path too: two windows can share a folder name, and the owner has to be able to tell them apart. */
  workspacePath: z.string().min(1).max(500),
  alias: z.string().min(1).max(32).optional(),
  /** What this window knew when it wrote. A reader that has to be sure asks the lease, not this. */
  serving: z.boolean(),
  writtenAt: z.number(),
});

export const CloseRequestSchema = z.object({
  windowId: z.string().regex(/^\d+-\d+$/u),
  /** Who asked, so the target can prune this once the asking window is gone. */
  requester: z.object({ pid: z.number().int(), startedAt: z.number() }),
  channel: z.enum(['fake', 'telegram', 'whatsapp']),
  chatId: z.string().min(1),
  requestedAt: z.number(),
});

export const CloseResultSchema = z.object({
  windowId: z.string().regex(/^\d+-\d+$/u),
  windowName: z.string().min(1).max(120),
  /** `unknown` is the honest answer for a window Forge could not confirm; it is never written as success. */
  outcome: z.enum(['closed', 'refused', 'unknown']),
  detail: z.string().min(1).max(400).optional(),
  channel: z.enum(['fake', 'telegram', 'whatsapp']),
  chatId: z.string().min(1),
  writtenAt: z.number(),
});

export type RemoteWindowRecord = z.infer<typeof WindowRecordSchema>;
export type CloseRequest = z.infer<typeof CloseRequestSchema>;
export type CloseResult = z.infer<typeof CloseResultSchema>;
export type CloseChannel = CloseRequest['channel'];

/** The file key: a window IS its host, so two windows never collide and a recycled pid never reads an old record. */
export function windowIdFor(host: HostId): string {
  return `${host.pid}-${host.startedAt}`;
}

/**
 * Is this `workspaces` selection the open-window list rather than the alias list
 * or the switch keyboard? A window id is `<pid>-<startMs>` and a workspace alias
 * has to start with a letter, so the two can never look alike — which is what
 * makes one selection `kind` carry both lists without an older window's parse
 * throwing on a new `kind` value.
 */
export function isWindowListSelection(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => /^\d+-\d+$/u.test(value));
}

/** This window's own key. `getHostIdentity` caches its one OS read, so calling this again is cheap. */
export function ownWindowId(): string {
  return windowIdFor(getHostIdentity());
}

export function windowRecordPath(directory: string, windowId: string): string {
  return path.join(directory, `${windowId}${RECORD_SUFFIX}`);
}
export function closeRequestPath(directory: string, windowId: string): string {
  return path.join(directory, `${windowId}.close-request.json`);
}
export function closeResultPath(directory: string, windowId: string): string {
  return path.join(directory, `${windowId}.close-result.json`);
}

/**
 * Publish this window's record. Written at activation and again when the window
 * starts or stops serving — a change of state, not a heartbeat: a window that is
 * merely not serving writes nothing every tick.
 */
export async function publishWindowRecord(input: {
  directory: string;
  record: RemoteWindowRecord;
}): Promise<void> {
  await ensureDirectory(input.directory);
  await writeFileAtomic(
    windowRecordPath(input.directory, input.record.windowId),
    `${JSON.stringify(input.record)}\n`,
    { mode: 0o600 },
  );
}

/** Give up this window's record on the way out; a file that is already gone is done. */
export async function removeWindowRecord(input: {
  directory: string;
  windowId: string;
}): Promise<void> {
  await fs.unlink(windowRecordPath(input.directory, input.windowId)).catch(() => undefined);
}

export interface WindowRead {
  records: RemoteWindowRecord[];
  /** Files that exist but will not parse: counted as windows, never closable. */
  unreadable: number;
  /** Records whose owner is proven dead, unlinked here because any reader may prune them. */
  pruned: number;
}

/**
 * Read every live window record, pruning the ones whose owner is dead.
 *
 * Death is proven (`isHostAlive`: the pid is gone, or the pid is alive but is a
 * different process), never by age: a slow but live window keeps its record, and
 * a record nobody refreshed is still a live window. This is the only prune path —
 * no clock watches this folder.
 */
export async function readWindowRecords(input: {
  directory: string;
  isHostAlive?: (recorded: HostId) => boolean;
  /** Only for a record whose JSON will not parse, where the host fields are
   *   unreadable and the pid in the file name is all there is. */
  isPidAlive?: (pid: number) => boolean;
}): Promise<WindowRead> {
  const alive = input.isHostAlive ?? isHostAlive;
  const alivePid = input.isPidAlive ?? isProcessAlive;
  const names = await listPlainRecords(input.directory);
  const records: RemoteWindowRecord[] = [];
  let unreadable = 0;
  let pruned = 0;
  for (const name of names) {
    const filePath = path.join(input.directory, name);
    const text = await readText(filePath);
    if (text === undefined) continue; // gone between listing and reading
    const parsed = WindowRecordSchema.safeParse(safeJson(text));
    if (parsed.success) {
      if (alive(parsed.data.host)) {
        records.push(parsed.data);
        continue;
      }
      await fs.unlink(filePath).catch(() => undefined);
      pruned += 1;
      continue;
    }
    // A record this build cannot read is still a window that exists: it counts,
    // it just cannot be named or closed. It is pruned only when the pid in its
    // own name is gone, because a foreign shape is not evidence of death.
    if (pruneDeadByName(name, alivePid)) {
      await fs.unlink(filePath).catch(() => undefined);
      pruned += 1;
      continue;
    }
    unreadable += 1;
  }
  return {
    records: records.sort((left, right) => left.writtenAt - right.writtenAt),
    unreadable,
    pruned,
  };
}

/** `<pid>-<start>.json`: an unreadable record is pruned only when its pid is gone. */
function pruneDeadByName(name: string, isAlive: (pid: number) => boolean): boolean {
  const stem = name.slice(0, -RECORD_SUFFIX.length);
  if (!/^\d+-\d+$/u.test(stem)) return false;
  return !isAlive(Number(stem.split('-')[0]));
}

/**
 * Is the window this `windowId` names proven **gone** — the proof a `closed`
 * report has to wait for, so the phone is never told a success that did not
 * happen. Two ways, in order: its record file is absent (a cleanly closed window
 * gives it up at `deactivate()`, and a reader has already pruned a dead one), or
 * its host is proven dead by `isHostAlive` — the same proof `readWindowRecords`
 * prunes on, so a crash or a kill is caught too. A record this build cannot read
 * is not evidence of death: only the pid in the window id can prove it, exactly
 * as `readWindowRecords` treats an unreadable file. Age proves nothing here, as
 * everywhere in this folder: a window that is merely slow keeps its record.
 */
export async function windowRecordIsGone(input: {
  directory: string;
  /** A parsed record's or result's `windowId`, which is `<pid>-<startMs>`. */
  windowId: string;
  isHostAlive?: (recorded: HostId) => boolean;
  isPidAlive?: (pid: number) => boolean;
}): Promise<boolean> {
  const filePath = windowRecordPath(input.directory, input.windowId);
  const text = await readText(filePath);
  // Nothing left to contradict the claim: either the window said goodbye at
  // `deactivate()` or some reader proved it dead and cleared the file.
  if (text === undefined) return true;
  const parsed = WindowRecordSchema.safeParse(safeJson(text));
  if (parsed.success) {
    if ((input.isHostAlive ?? isHostAlive)(parsed.data.host)) return false;
    await fs.unlink(filePath).catch(() => undefined);
    return true;
  }
  // The window id carries the pid, so even a record this build cannot parse can
  // still be proven gone — and only that way.
  return !(input.isPidAlive ?? isProcessAlive)(Number(input.windowId.split('-')[0]));
}

/** The plain `<windowId>.json` files; the two close files share the folder but are not windows. */
async function listPlainRecords(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory);
    return entries
      .filter((name) => name.endsWith(RECORD_SUFFIX))
      .filter((name) => !name.includes('.close-request.') && !name.includes('.close-result.'));
  } catch {
    // No folder yet is the normal state of a machine running one window on an
    // older Forge, not an error to report.
    return [];
  }
}

export async function readText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Ask a window to close. This only writes the file — the target decides, and
 * nothing here closes a window because a cap asked it to.
 */
export async function writeCloseRequest(input: {
  directory: string;
  windowId: string;
  channel: CloseChannel;
  chatId: string;
  requester?: HostId;
}): Promise<void> {
  const request: CloseRequest = {
    windowId: input.windowId,
    requester: input.requester ?? getHostIdentity(),
    channel: input.channel,
    chatId: input.chatId,
    requestedAt: Date.now(),
  };
  await ensureDirectory(input.directory);
  await writeFileAtomic(
    closeRequestPath(input.directory, input.windowId),
    `${JSON.stringify(request)}\n`,
    { mode: 0o600 },
  );
}

/**
 * The folder is created by the window that writes into it, not read into
 * existence: `writeFileAtomic` renames within the directory, so the directory
 * has to exist first, and the first window on a machine with no
 * `remote-windows/` yet is the one that makes it.
 */
export async function ensureDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export interface WindowCount {
  total: number;
  /** Names of the windows Forge can close: the ones with a record here. */
  forgeWindows: string[];
  /** Windows the OS counted that Forge cannot close. */
  otherWindows: number;
  counted: 'os' | 'files';
  /** Why the count came from the files, when it did. */
  probeReason?: string;
}

/**
 * The count, with no union. On Windows the total IS the OS count and the files
 * only name the closable ones; elsewhere the total is the file count and the
 * message has to admit that is what it counted. There is no join by pid: every
 * window of one VS Code instance belongs to the same process, which is exactly
 * what the probe fake returns.
 */
export function countOpenWindows(input: { read: WindowRead; probe: ProbeOutcome }): WindowCount {
  const forgeWindows = input.read.records.map((record) => record.workspaceName);
  if (input.probe.source === 'os') {
    return {
      total: input.probe.windows.length,
      forgeWindows,
      otherWindows: Math.max(0, input.probe.windows.length - input.read.records.length),
      counted: 'os',
    };
  }
  return {
    total: input.read.records.length + input.read.unreadable,
    forgeWindows,
    otherWindows: 0,
    counted: 'files',
    probeReason: input.probe.reason,
  };
}

/** The one refuse form the plan allows, counting only what Forge can prove. */
export function refuseOverCap(count: WindowCount, cap: number): string | undefined {
  if (count.total < cap) return undefined;
  const names = count.forgeWindows.length
    ? count.forgeWindows.slice(0, 8).join(', ')
    : 'no windows with Forge in them';
  const others = count.otherWindows
    ? `, plus ${count.otherWindows} other VS Code window${count.otherWindows === 1 ? '' : 's'} Forge cannot close`
    : '';
  const limitation =
    count.counted === 'files'
      ? ` (counted only windows Forge can see — ${count.probeReason ?? 'this OS'}; there may be more)`
      : '';
  return (
    `${count.total} VS Code windows open — ${names}${others}${limitation}. ` +
    `The limit is ${cap}: close one with /workspace windows and its ✕, or raise the limit with ` +
    '/workspace cap <1-12>. Forge will not close a window on its own initiative.'
  );
}

/** One row of `/workspace windows`. */
export interface RemoteWindowRow {
  windowId: string;
  name: string;
  workspace: string;
  /** False for this window (it is answering the phone) and for a record Forge cannot read. */
  closable: boolean;
  whyNotClosable?: string;
  serving: boolean;
}

export interface RemoteWindowList {
  rows: RemoteWindowRow[];
  count: WindowCount;
}

/**
 * The phone-facing read of the folder: the list, the cap, and the Close button.
 * Built once per window in `remoteRuntimeSetup.ts` and handed to the command
 * path, so the command layer never touches the filesystem or PowerShell itself.
 */
export interface RemoteWindowSurface {
  list(): Promise<RemoteWindowList>;
  /** A reason not to open `alias` in a new window, or `undefined` when there is room. */
  capRefusal(alias: string): Promise<string | undefined>;
  requestClose(
    windowId: string,
    requester: { channel: CloseChannel; chatId: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  cap(): number;
  setCap(cap: number): Promise<void>;
}

export function createRemoteWindowSurface(deps: {
  directory: string;
  /** A window cannot close the window that is answering this phone. */
  ownWindowId?: () => string;
  probe: { count(): Promise<ProbeOutcome> };
  cap: () => number;
  setCap: (cap: number) => Promise<void>;
  /** The alias map the cap check resolves against — the same one `/workspace` lists. */
  aliasesFor: () => Record<string, { path: string; display_name: string }>;
  isHostAlive?: (recorded: HostId) => boolean;
}): RemoteWindowSurface {
  const own = deps.ownWindowId ?? ownWindowId;
  const read = () =>
    readWindowRecords({
      directory: deps.directory,
      ...(deps.isHostAlive ? { isHostAlive: deps.isHostAlive } : {}),
    });
  return {
    async list(): Promise<RemoteWindowList> {
      const live = await read();
      const count = countOpenWindows({ read: live, probe: await deps.probe.count() });
      const ownId = own();
      return {
        count,
        rows: live.records.map((record) => ({
          windowId: record.windowId,
          name: record.workspaceName,
          workspace: record.workspacePath,
          closable: record.windowId !== ownId,
          ...(record.windowId === ownId
            ? { whyNotClosable: 'it is answering this phone', serving: true }
            : { serving: record.serving }),
        })),
      };
    },
    async capRefusal(alias: string): Promise<string | undefined> {
      const target = deps.aliasesFor()[alias];
      if (!target) return `workspace “${alias}” was not found.`;
      const live = await read();
      // Opening a folder that is already open focuses it and adds no window, so
      // the cap has nothing to refuse for it.
      const targetId = workspaceIdFor(target.path);
      if (live.records.some((record) => record.workspaceId === targetId)) return undefined;
      return refuseOverCap(
        countOpenWindows({ read: live, probe: await deps.probe.count() }),
        deps.cap(),
      );
    },
    async requestClose(
      windowId: string,
      requester: { channel: CloseChannel; chatId: string },
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
      if (windowId === own()) {
        return {
          ok: false,
          reason: 'this window is answering your phone; closing it would leave the phone dark',
        };
      }
      await writeCloseRequest({
        directory: deps.directory,
        windowId,
        channel: requester.channel,
        chatId: requester.chatId,
      });
      return { ok: true };
    },
    cap: deps.cap,
    setCap: deps.setCap,
  };
}
