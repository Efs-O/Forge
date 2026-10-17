import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { BUS_README, CLIENT_SCRIPT } from './busContent';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import { abortableSleep } from '../util/abortableSleep';

/**
 * The agent-bus files (docs/plans/AGENT_MESSAGING_PLAN.md). Every artifact
 * below has a row in that plan's state × lifecycle ledger; a new one needs a
 * row there and cleanup here, or the "leaves nothing behind" test fails.
 */

/** Ids this module mints start with this, so orphan detection never claims
 *  a reply that belongs to another asker (a Codex shell, a script). */
const FORGE_ID_PREFIX = 'fg';

/** Anything older than this is swept at the start of a call. */
export const TTL_MS = 24 * 60 * 60_000;

export interface BusPaths {
  root: string;
  inbox: string;
  outbox: string;
  /** `{url, token}` of the running Forge's inbound routes. */
  endpoint: string;
  /** The client other agents run (`forge.sh`). */
  script: string;
}

/** Written by the 0.16.4 watcher design; deleted on sight. */
const LEGACY_FILES = ['watch.sh', 'listening'];

/**
 * A pending question's record. Not `.md`: a 0.16.4 watcher still running in
 * some Claude session globs `inbox/*.md`, and would hand our question to that
 * session instead of the one we asked.
 */
const PENDING_SUFFIX = '-forge.pending';
const log = getLogger();

/** The bus lives under the OS profile, never the workspace: a
 *  `workspaceFolders[0]` that is not the repo root cannot move it. */
export function busPaths(home: string = os.homedir()): BusPaths {
  const root = path.join(home, '.forge', 'agent-bus');
  return {
    root,
    inbox: path.join(root, 'inbox'),
    outbox: path.join(root, 'outbox'),
    endpoint: path.join(root, 'endpoint.json'),
    script: path.join(root, 'forge.sh'),
  };
}

function writeIfChanged(file: string, content: string): void {
  let current: string | undefined;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== content) fs.writeFileSync(file, content, 'utf8');
}

/** Create the folders, (re)write the shipped README and client, and delete
 *  what the watcher design left behind. */
export function ensureBus(paths: BusPaths): void {
  fs.mkdirSync(paths.inbox, { recursive: true });
  fs.mkdirSync(paths.outbox, { recursive: true });
  writeIfChanged(path.join(paths.root, 'README.md'), BUS_README);
  writeIfChanged(paths.script, CLIENT_SCRIPT);
  const legacy = [
    ...LEGACY_FILES.map((name) => path.join(paths.root, name)),
    ...fs
      .readdirSync(paths.inbox)
      .filter((name) => name.endsWith('.notified'))
      .map((name) => path.join(paths.inbox, name)),
  ];
  for (const file of legacy) {
    try {
      unlinkQuiet(file);
    } catch {
      // Best effort: a leftover must never block a question. Retried next call.
    }
  }
  // At activation and before every question: late replies to withdrawn
  // questions and other askers' leftovers go after the README's 24 hours.
  sweepStale(paths);
}

/** Remove the pre-link alias ownership records once during extension activation. */
export function removeLegacyAliasFiles(
  paths: BusPaths,
  showWarning: (message: string) => void,
): string[] {
  const ownershipDir = path.join(paths.root, 'ownership');
  let names: string[] = [];
  try {
    names = fs.readdirSync(ownershipDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const message = `Could not inspect legacy agent ownership files: ${String(error)}`;
      log.error(message);
      showWarning(message);
      return [];
    }
  }
  let rootNames: string[] = [];
  try {
    rootNames = fs.readdirSync(paths.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const message = `Could not inspect legacy agent ownership files: ${String(error)}`;
      log.error(message);
      showWarning(message);
      return [];
    }
  }
  const files = [
    ...names
      .filter((name) => name.endsWith('.json') || name.endsWith('.claim'))
      .map((name) => path.join(ownershipDir, name)),
    ...rootNames
      .filter((name) => name.endsWith('.claim'))
      .map((name) => path.join(paths.root, name)),
  ];
  const removed: string[] = [];
  const failures: string[] = [];
  for (const file of files) {
    try {
      fs.unlinkSync(file);
      removed.push(file);
      log.info(`Removed legacy agent ownership file: ${file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      failures.push(`${file}: ${String(error)}`);
    }
  }
  if (failures.length > 0) {
    const message = `Could not remove legacy agent ownership files: ${failures.join('; ')}`;
    log.error(message);
    showWarning(message);
  }
  return removed;
}

export function newBusId(now: number = Date.now(), random: () => string = randomHex): string {
  return `${FORGE_ID_PREFIX}${now}-${random()}`;
}

function randomHex(): string {
  return randomBytes(4).toString('hex');
}

const questionFile = (paths: BusPaths, id: string): string =>
  path.join(paths.inbox, `${id}${PENDING_SUFFIX}`);
export const replyFile = (paths: BusPaths, id: string): string =>
  path.join(paths.outbox, `${id}-reply.md`);

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Replies are ids from any asker, so they are checked before they name a file. */
export const BUS_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

/** The answer a waiting {@link waitForReply} picks up (the `/agent/reply` route). */
export function writeReply(paths: BusPaths, id: string, text: string): void {
  if (!BUS_ID_PATTERN.test(id)) throw new Error(`not a bus id: ${id}`);
  fs.mkdirSync(paths.outbox, { recursive: true });
  writeFileAtomicSync(replyFile(paths, id), text);
}

/** The record that a question is still waited on. Written via .tmp and a
 *  rename, like every bus file. */
export function writeQuestion(paths: BusPaths, id: string, subject: string, body: string): void {
  const text =
    `Subject: ${subject}\n\n${body}\n\n` +
    `(Reply with forge.sh reply ${id}, or write outbox/${id}-reply.md via a .tmp file and a rename.)\n`;
  writeFileAtomicSync(questionFile(paths, id), text);
}

/** Remove the question. A reply that lands after this is left for
 *  {@link sweepStale}. */
export function withdrawQuestion(paths: BusPaths, id: string): void {
  unlinkQuiet(questionFile(paths, id));
}

/**
 * Wait for `<id>-reply.md`. Every writer renames a finished .tmp into place,
 * so the file is complete whenever it exists. Resolves undefined on timeout or
 * abort. Polling a local stat once a second costs nothing.
 */
export async function waitForReply(
  paths: BusPaths,
  id: string,
  timeoutMs: number,
  signal?: AbortSignal,
  pollMs = 1000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  const file = replyFile(paths, id);
  for (;;) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const remaining = deadline - Date.now();
    if (signal?.aborted || remaining <= 0) return undefined;
    await abortableSleep(Math.min(pollMs, remaining), signal);
  }
}

/** A finished exchange leaves nothing behind (the ledger's CI row). */
export function clearExchange(paths: BusPaths, id: string): void {
  withdrawQuestion(paths, id);
  unlinkQuiet(replyFile(paths, id));
}

/** Delete anything older than the TTL in either folder, from any asker. */
export function sweepStale(paths: BusPaths, now: number = Date.now()): void {
  for (const dir of [paths.inbox, paths.outbox]) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > TTL_MS) unlinkQuiet(full);
      } catch {
        // Vanished between readdir and stat: another asker cleaned up first.
      }
    }
  }
}
