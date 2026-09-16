import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { BUS_README, CLIENT_SCRIPT } from './busContent';

/**
 * The agent-bus files (docs/plans/AGENT_MESSAGING_PLAN.md). Every artifact
 * below has a row in that plan's state × lifecycle ledger; a new one needs a
 * row there and cleanup here, or the "leaves nothing behind" test fails.
 */

/** Ids this module mints start with this, so orphan detection never claims
 *  a reply that belongs to another asker (a Codex shell, a script). */
export const FORGE_ID_PREFIX = 'fg';

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
  for (const name of LEGACY_FILES) unlinkQuiet(path.join(paths.root, name));
  for (const name of fs.readdirSync(paths.inbox)) {
    if (name.endsWith('.notified')) unlinkQuiet(path.join(paths.inbox, name));
  }
}

export function newBusId(now: number = Date.now(), random: () => string = randomHex): string {
  return `${FORGE_ID_PREFIX}${now}-${random()}`;
}

function randomHex(): string {
  return randomBytes(4).toString('hex');
}

const questionFile = (paths: BusPaths, id: string): string =>
  path.join(paths.inbox, `${id}-forge.md`);
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

function writeAtomic(file: string, text: string): void {
  fs.writeFileSync(`${file}.tmp`, text, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

/** The answer a waiting {@link waitForReply} picks up (the `/agent/reply` route). */
export function writeReply(paths: BusPaths, id: string, text: string): void {
  if (!BUS_ID_PATTERN.test(id)) throw new Error(`not a bus id: ${id}`);
  fs.mkdirSync(paths.outbox, { recursive: true });
  writeAtomic(replyFile(paths, id), text);
}

/** The record that a question is still waited on: {@link takeOrphans} leaves
 *  its reply alone. Written via .tmp and a rename, like every bus file. */
export function writeQuestion(paths: BusPaths, id: string, subject: string, body: string): void {
  const text =
    `Subject: ${subject}\n\n${body}\n\n` +
    `(Reply with forge.sh reply ${id}, or write outbox/${id}-reply.md via a .tmp file and a rename.)\n`;
  writeAtomic(questionFile(paths, id), text);
}

/** Remove the question. A reply that lands after this is an orphan,
 *  announced once by {@link takeOrphans}. */
export function withdrawQuestion(paths: BusPaths, id: string): void {
  unlinkQuiet(questionFile(paths, id));
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

export interface Orphans {
  shown: { id: string; text: string }[];
  more: number;
}

/**
 * Replies to questions this module already withdrew (the wait timed out or was
 * stopped). Each is returned once and then deleted: never dropped unseen,
 * never announced twice. Only `fg` ids are ours to claim.
 */
export function takeOrphans(paths: BusPaths, limit: number): Orphans {
  let names: string[];
  try {
    names = fs.readdirSync(paths.outbox);
  } catch {
    return { shown: [], more: 0 };
  }
  const orphanIds = names
    .filter((n) => n.startsWith(FORGE_ID_PREFIX) && n.endsWith('-reply.md'))
    .map((n) => n.slice(0, -'-reply.md'.length))
    .filter((id) => !fs.existsSync(questionFile(paths, id)))
    .sort();
  const shown = orphanIds.slice(0, limit).map((id) => {
    const text = fs.readFileSync(replyFile(paths, id), 'utf8');
    unlinkQuiet(replyFile(paths, id));
    return { id, text };
  });
  return { shown, more: orphanIds.length - shown.length };
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
