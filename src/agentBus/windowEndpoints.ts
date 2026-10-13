import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';

const log = getLogger();

const endpointSchema = z
  .object({
    windowId: z.string().uuid(),
    url: z.string().url(),
    token: z.string().min(32),
    pid: z.number().int().positive(),
  })
  .strict();

export type WindowEndpoint = z.infer<typeof endpointSchema>;

export function windowEndpointsDirectory(root: string): string {
  return path.join(root, 'endpoints');
}

export function windowEndpointPath(root: string, windowId: string): string {
  return path.join(windowEndpointsDirectory(root), `${z.string().uuid().parse(windowId)}.json`);
}

export function writeWindowEndpoint(root: string, endpoint: WindowEndpoint): void {
  const parsed = endpointSchema.parse(endpoint);
  const directory = windowEndpointsDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  writeFileAtomicSync(
    windowEndpointPath(root, parsed.windowId),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
}

export function removeWindowEndpoint(root: string, windowId: string, token: string): void {
  const file = windowEndpointPath(root, windowId);
  let current: WindowEndpoint;
  try {
    current = endpointSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (current.token === token) fs.unlinkSync(file);
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One endpoint file; undefined when it is absent or not a valid endpoint (warned). */
export function readWindowEndpoint(file: string): WindowEndpoint | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    log.warn(`[windowEndpoints] could not parse ${path.basename(file)}: ${String(error)}`);
    return undefined;
  }
  const parsed = endpointSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn(`[windowEndpoints] invalid endpoint ${path.basename(file)}: ${parsed.error.message}`);
    return undefined;
  }
  return parsed.data;
}

function windowEndpointFiles(root: string): string[] {
  const directory = windowEndpointsDirectory(root);
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Live windows other than `exceptWindowId`, the most recently started first. */
export function liveWindowEndpoints(
  root: string,
  exceptWindowId: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): WindowEndpoint[] {
  const live: { endpoint: WindowEndpoint; started: number }[] = [];
  for (const file of windowEndpointFiles(root)) {
    const endpoint = readWindowEndpoint(file);
    if (!endpoint || endpoint.windowId === exceptWindowId || !isAlive(endpoint.pid)) continue;
    live.push({ endpoint, started: fs.statSync(file).mtimeMs });
  }
  return live.sort((a, b) => b.started - a.started).map((entry) => entry.endpoint);
}

export function removeDeadWindowEndpoints(
  root: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): string[] {
  const removed: string[] = [];
  for (const file of windowEndpointFiles(root)) {
    const endpoint = readWindowEndpoint(file);
    if (!endpoint || isAlive(endpoint.pid)) continue;
    fs.unlinkSync(file);
    removed.push(endpoint.windowId);
  }
  return removed;
}
