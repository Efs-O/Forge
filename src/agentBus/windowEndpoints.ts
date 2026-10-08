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

export function removeDeadWindowEndpoints(
  root: string,
  isAlive: (pid: number) => boolean = processIsAlive,
): string[] {
  const directory = windowEndpointsDirectory(root);
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    const file = path.join(directory, name);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    } catch (error) {
      log.warn(`[windowEndpoints] could not parse ${name}: ${String(error)}`);
      continue;
    }
    const parsed = endpointSchema.safeParse(raw);
    if (!parsed.success) {
      log.warn(`[windowEndpoints] invalid endpoint ${name}: ${parsed.error.message}`);
      continue;
    }
    if (isAlive(parsed.data.pid)) continue;
    fs.unlinkSync(file);
    removed.push(parsed.data.windowId);
  }
  return removed;
}
