import * as fs from 'fs';
import * as path from 'path';

/**
 * Lightweight `last_used` tracking for the Model Manager's zoo-hygiene view
 * (F7/§2.3). Deliberately NOT part of config.yaml — this is UI/UX metadata,
 * not semantic config, and writing it there would trigger the config watcher
 * (and comment-preserving writer) on every single chat turn. Lives in
 * `.forge/state.json`, next to config.yaml. See docs/OWNERS.md.
 */

export interface ForgeState {
  last_used: Record<string, string>; // model name -> ISO timestamp
}

const EMPTY_STATE: ForgeState = { last_used: {} };

function stateFilePath(configPath: string): string {
  return path.join(path.dirname(configPath), 'state.json');
}

/** Read `.forge/state.json`. Never throws — a missing or corrupt file reads
 *  as empty state so callers never need a try/catch of their own. */
export function readForgeState(configPath: string): ForgeState {
  try {
    const raw = fs.readFileSync(stateFilePath(configPath), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ForgeState>;
    return { last_used: parsed.last_used ?? {} };
  } catch {
    return { ...EMPTY_STATE, last_used: {} };
  }
}

function writeForgeState(configPath: string, state: ForgeState): void {
  const target = stateFilePath(configPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

// Debounce per model name so a burst of tool-call round-trips within one turn
// doesn't hammer disk with redundant writes. The target is carried alongside
// the timer rather than parsed back out of the key — a model name is
// user-supplied and may contain the separator.
interface PendingWrite {
  configPath: string;
  modelName: string;
  timer: ReturnType<typeof setTimeout>;
}
const pendingWrites = new Map<string, PendingWrite>();
const DEBOUNCE_MS = 2000;

/**
 * Record that `modelName` was just dispatched. Fire-and-forget: debounced,
 * and any failure (readonly fs, race with another window) is swallowed —
 * usage tracking must never throw into the request path. Single hook site:
 * `AgentLoop.runTurn` (see docs/OWNERS.md).
 */
export function recordModelUsage(configPath: string, modelName: string): void {
  const key = `${configPath}::${modelName}`;
  const existing = pendingWrites.get(key);
  if (existing) clearTimeout(existing.timer);
  pendingWrites.set(key, {
    configPath,
    modelName,
    timer: setTimeout(() => flushOne(configPath, modelName, key), DEBOUNCE_MS),
  });
}

function flushOne(configPath: string, modelName: string, key: string): void {
  pendingWrites.delete(key);
  try {
    const state = readForgeState(configPath);
    state.last_used[modelName] = new Date().toISOString();
    writeForgeState(configPath, state);
  } catch {
    // never let usage tracking break a request
  }
}

/** Test-only escape hatch: force any debounced `recordModelUsage` write for
 *  `configPath`/`modelName` to happen immediately, synchronously. */
export function flushModelUsageForTest(configPath: string, modelName: string): void {
  const key = `${configPath}::${modelName}`;
  const existing = pendingWrites.get(key);
  if (existing) clearTimeout(existing.timer);
  flushOne(configPath, modelName, key);
}

/**
 * Write out every debounced `last_used` update now, synchronously.
 *
 * Hooked into `deactivate()`. Without it, closing the window within
 * DEBOUNCE_MS of a turn drops that turn's usage entirely — which is precisely
 * the "I used this model last thing before quitting" case the Model Manager's
 * zoo-hygiene view exists to show. Never throws: `flushOne` swallows per-model
 * failures, and shutdown is not a place to surface a disk error.
 */
export function flushPendingModelUsage(): void {
  for (const [key, pending] of [...pendingWrites]) {
    clearTimeout(pending.timer);
    flushOne(pending.configPath, pending.modelName, key);
  }
}
