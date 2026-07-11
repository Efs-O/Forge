import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { waitForHealthy, probeHealthy } from './HealthCheck';
import { getLogger } from '../util/logger';

const log = getLogger();

export interface OllamaSuperviseOptions {
  auto_start?: boolean;
  executable?: string;
}

export function normalizeOllamaEndpoint(endpoint: string): string {
  return endpoint.replace(/\/$/, '').replace(/\/(v1|api)$/, '');
}

function nativeApiBase(endpoint: string): string {
  return `${normalizeOllamaEndpoint(endpoint)}/api`;
}

function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

interface SpawnCandidate {
  exe: string;
  args: string[];
}

/**
 * Candidate launch commands, most explicit first: config override, then
 * `ollama serve` (CLI from the standard %LOCALAPPDATA% install or PATH —
 * never a hardcoded user path), then the Windows tray app as a last resort.
 * Bare `ollama serve` is preferred: launched programmatically it came up
 * reliably in seconds, while the tray app repeatedly spawned without ever
 * starting its server (its retry loop only re-connects, it does not
 * re-spawn). Note `ollama serve` reads only env vars — users with a custom
 * model directory must set OLLAMA_MODELS, the app-side setting does not
 * apply to it.
 */
function ollamaLaunchCandidates(configured?: string): SpawnCandidate[] {
  const candidates: SpawnCandidate[] = [];
  if (configured) {
    // The tray app starts the server by itself; the CLI needs `serve`.
    const isTrayApp = /app/i.test(path.basename(configured));
    candidates.push({ exe: configured, args: isTrayApp ? [] : ['serve'] });
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installDir = path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama');
    const cli = path.join(installDir, 'ollama.exe');
    if (fs.existsSync(cli)) candidates.push({ exe: cli, args: ['serve'] });
  }
  candidates.push({ exe: 'ollama', args: ['serve'] });
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const trayApp = path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama app.exe');
    if (fs.existsSync(trayApp)) candidates.push({ exe: trayApp, args: [] });
  }
  return candidates;
}

/** Spawn the candidate detached; resolves true once the child actually spawned. */
function trySpawnServe(candidate: SpawnCandidate): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      // Windows: do NOT detach — a detached process has no console, so every
      // console child ollama spawns (runners, GPU probes) flashes its own DOS
      // window. Non-detached + windowsHide gives the daemon one HIDDEN console
      // that all its children inherit. Orphaned children survive extension
      // host exit on Windows, so the daemon outlives reloads anyway.
      const child = spawn(candidate.exe, candidate.args, {
        detached: process.platform !== 'win32',
        stdio: 'ignore',
        windowsHide: true,
      });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export async function ensureOllamaReady(
  endpoint: string,
  signal?: AbortSignal,
  supervise?: OllamaSuperviseOptions,
): Promise<void> {
  const baseUrl = normalizeOllamaEndpoint(endpoint);
  if (await probeHealthy(baseUrl)) return;

  // Daemon down. For LOCAL endpoints, launch it ourselves unless opted out.
  // Candidates are tried IN SEQUENCE with a per-candidate health wait: e.g. the
  // tray app can spawn yet fail to bring its server up (seen live: pending
  // self-update), in which case the next candidate (bare `ollama serve`) wins.
  const autoStartWanted = (supervise?.auto_start ?? true) && isLocalEndpoint(baseUrl);
  let anySpawned = false;
  if (autoStartWanted) {
    for (const candidate of ollamaLaunchCandidates(supervise?.executable)) {
      if (signal?.aborted) break;
      if (!(await trySpawnServe(candidate))) continue;
      anySpawned = true;
      const label = `${candidate.exe}${candidate.args.length ? ' ' + candidate.args.join(' ') : ''}`;
      log.info(`[OllamaAdapter] daemon down at ${baseUrl} — launched "${label}"`);
      const result = await waitForHealthy({ baseUrl, timeoutMs: 15_000 }, undefined, signal);
      if (result.ok) return;
      log.warn(
        `[OllamaAdapter] "${label}" spawned but ${baseUrl} still down — trying next candidate`,
      );
    }
  }

  const result = await waitForHealthy({ baseUrl, timeoutMs: 10_000 }, undefined, signal);
  if (!result.ok) {
    const attempted = anySpawned
      ? `Forge launched the ollama daemon but it did not become reachable: ${result.message}. `
      : autoStartWanted
        ? `${result.message}. Forge could not find an ollama executable to auto-start ` +
          `(set ollama.executable in config.yaml), so start it with "ollama serve" yourself. `
        : `${result.message}. Start it with "ollama serve". `;
    throw new Error(
      `Ollama daemon not reachable at ${baseUrl}: ${attempted}` +
        `The tray app alone does not always run the server. Also check the model's endpoint in config.yaml.`,
    );
  }
}

/**
 * Ask the daemon whether it can actually serve `model` (POST /api/show), so
 * unknown / unpulled / entitlement-gated models fail at ensure time with the
 * daemon's own reason instead of at first chat call.
 */
export async function probeOllamaModel(
  endpoint: string,
  model: string,
  signal?: AbortSignal,
): Promise<void> {
  // Always bound the probe: a hung daemon must not stall hotSwap even when
  // the caller supplied its own abort signal.
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(`${nativeApiBase(endpoint)}/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // older daemons expect "name", newer accept "model" — send both
    body: JSON.stringify({ model, name: model }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama cannot serve "${model}": HTTP ${response.status} ${body}`.trim());
  }
}

export async function releaseOllamaModel(endpoint: string, model: string): Promise<void> {
  const response = await fetch(`${nativeApiBase(endpoint)}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      keep_alive: 0,
    }),
    // A hung daemon must not block stop()/hotSwap()/deactivate forever.
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama release failed for "${model}": HTTP ${response.status} ${body}`.trim());
  }
}
