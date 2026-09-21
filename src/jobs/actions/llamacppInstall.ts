import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { pickAssets } from './llamacppAssets';
import { jobsDownloadBinary, jobsFetchReleaseByTag, type JobsFetchOptions } from '../jobsFetch';
import { buildDirForTag, newBinaryPath, stagingDir } from './stagedBuild';

/**
 * Stages 2-5 of a llama.cpp install — download, verify, extract, smoke test —
 * with no job attached. The `llamacpp_update` job action stages its build
 * through this, and so does the `install_llamacpp` agent tool, so there is one
 * pipeline whichever way a build arrives. Nothing here touches config.yaml;
 * switching `llama_server.binary` is the caller's decision.
 *
 *   2. Download the tag's main zip + its cudart (gated by allowed hosts).
 *   3. Verify each against the release API digest; no digest or a mismatch
 *      stops before anything is written.
 *   4. Extract both into `llama.cpp-<tag>\`; if that folder exists, stop.
 *   5. Smoke test: `--version` reports the tag, `--list-devices` runs, and (when
 *      embeddings are configured) one embedding round-trip on a free port.
 *
 * The zips are deleted on success and on failure; a build folder this run
 * created is removed on failure. Old build folders are never deleted.
 */

export interface LlamacppInstallEnv {
  /** The `%LOCALAPPDATA%\Forge` root the builds live under. */
  localRoot: string;
  /** The fetch options (allowed hosts + ETag cache). */
  fetchOptions: () => JobsFetchOptions;
  /** The current config, for the old binary and the embeddings smoke test. */
  getConfig: () => {
    currentBinary: string | undefined;
    embeddings: { enabled?: boolean; model_path?: string } | undefined;
    llama_server: { host?: string; port?: number } | undefined;
  };
  /** Run a command, returning {code, stdout, stderr}. */
  runCommand: (
    binary: string,
    args: string[],
    timeoutMs?: number,
  ) => Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>;
  /** SHA-256 (lowercase hex) of a file. */
  sha256File: (filePath: string) => Promise<string>;
  /** Extract a zip into a directory. */
  extractZip: (zipPath: string, destDir: string) => Promise<void>;
}

/** A build that passed stages 2-5. */
export interface InstalledBuild {
  newBinary: string;
  assets: { name: string; digest: string }[];
}

/** Run stages 2-5 for `tag`. Throws on any failure, after cleaning up. */
export async function installLlamacppBuild(
  repo: string,
  tag: string,
  assetPattern: string,
  env: LlamacppInstallEnv,
): Promise<InstalledBuild> {
  const downloaded: { name: string; path: string; digest: string }[] = [];
  // Whether THIS run created the build dir. A pre-existing `llama.cpp-<tag>\`
  // is never ours to delete (old builds are kept on purpose); a partial one we
  // created and then failed to fill must be removed, or it blocks every retry
  // of the tag at the "already exists" guard below (audit F3).
  let createdBuildDir = false;
  try {
    const release = await jobsFetchReleaseByTag(repo, tag, env.fetchOptions());
    const assets = pickAssets(release, tag, assetPattern);
    const staging = stagingDir(env.localRoot);
    fs.mkdirSync(staging, { recursive: true });

    // Stage 2: download each asset to the staging dir (gated, redirect-safe).
    for (const asset of assets) {
      const dest = path.join(staging, asset.name);
      await jobsDownloadBinary(asset.downloadUrl, dest, {
        allowedHosts: env.fetchOptions().allowedHosts,
      });
      downloaded.push({ name: asset.name, path: dest, digest: asset.digest });
    }

    // Stage 3: verify every asset's SHA-256 against the release digest.
    for (const asset of downloaded) {
      const actual = await env.sha256File(asset.path);
      if (!asset.digest.startsWith('sha256:')) {
        throw new Error(
          `Forge: release ${tag} has no digest for ${asset.name}; refusing to install`,
        );
      }
      if (actual !== asset.digest.slice('sha256:'.length)) {
        throw new Error(
          `Forge: digest mismatch for ${asset.name}: expected ${asset.digest}, got sha256:${actual}`,
        );
      }
    }

    // Stage 4: extract into llama.cpp-<tag>\; stop if the folder already exists.
    const buildDir = buildDirForTag(env.localRoot, tag);
    if (fs.existsSync(buildDir)) {
      throw new Error(`Forge: build folder ${buildDir} already exists; not overwriting`);
    }
    fs.mkdirSync(buildDir, { recursive: true });
    createdBuildDir = true;
    for (const asset of downloaded) {
      await env.extractZip(asset.path, buildDir);
    }
    const newBinary = newBinaryPath(env.localRoot, tag);
    if (!fs.existsSync(newBinary)) {
      throw new Error(`Forge: ${newBinary} not found after extraction`);
    }

    // Stage 5: smoke test the new binary.
    await smokeTest(newBinary, tag, env);

    // The zips have served their purpose (verified + extracted). Delete them so
    // a successful install does not leak ~550 MB per release (audit F3).
    for (const asset of downloaded) {
      fs.rmSync(asset.path, { force: true });
    }
    return { newBinary, assets: downloaded.map((a) => ({ name: a.name, digest: a.digest })) };
  } catch (err) {
    // Remove the partial build dir ONLY if this run created it — never a
    // pre-existing build — so a half-extracted tag does not permanently block
    // the next retry at the "already exists" guard (audit F3). Delete the
    // downloaded zips too; they are per-run and never reused across attempts.
    if (createdBuildDir) {
      fs.rmSync(buildDirForTag(env.localRoot, tag), { recursive: true, force: true });
    }
    for (const asset of downloaded) {
      fs.rmSync(asset.path, { force: true });
    }
    throw err;
  }
}

/** Stage 5: `--version` reports the tag, `--list-devices` runs, and (when
 *  embeddings are configured) one embedding round-trip succeeds. */
async function smokeTest(newBinary: string, tag: string, env: LlamacppInstallEnv): Promise<void> {
  const version = await env.runCommand(newBinary, ['--version'], 30_000);
  if (version.code !== 0 || !versionReportsTag(`${version.stdout}\n${version.stderr}`, tag)) {
    throw new Error(
      `Forge: smoke test failed: --version did not report ${tag} (code ${version.code}): ${(
        version.stdout + version.stderr
      ).slice(0, 200)}`,
    );
  }
  const devices = await env.runCommand(newBinary, ['--list-devices'], 30_000);
  if (devices.code !== 0) {
    throw new Error(`Forge: smoke test failed: --list-devices exited ${devices.code}`);
  }
  const embeddings = env.getConfig().embeddings;
  if (embeddings?.enabled && embeddings.model_path) {
    await embeddingsRoundTrip(newBinary, embeddings.model_path, env);
  }
}

/**
 * Whether `--version` output names the tag. Current builds print
 * `version: 0.4.1-dev (build 11077, commit …)` — to STDERR, and with `build
 * 11077` rather than the tag `b11077` — so a stdout-only `includes(tag)` failed
 * every real build (seen on b11077, 2026-09-21). Accept either spelling.
 */
export function versionReportsTag(output: string, tag: string): boolean {
  if (output.includes(tag)) return true;
  const n = /^b(\d+)$/u.exec(tag)?.[1];
  return n !== undefined && new RegExp(`\\bbuild ${n}\\b`, 'u').test(output);
}

/** One embedding round-trip on a free port, to prove the build serves. */
async function embeddingsRoundTrip(
  newBinary: string,
  modelPath: string,
  env: LlamacppInstallEnv,
): Promise<void> {
  const host = env.getConfig().llama_server?.host ?? '127.0.0.1';
  const port = await findFreePort(host);
  const proc = spawn(
    newBinary,
    ['-m', modelPath, '--host', host, '--port', String(port), '--embedding'],
    {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    const healthy = await waitHealthy(`http://${host}:${port}`, 30_000);
    if (!healthy)
      throw new Error('Forge: smoke test failed: embedding server did not become healthy');
    const res = await fetch(`http://${host}:${port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: path.basename(modelPath), input: 'forge smoke test' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok)
      throw new Error(`Forge: smoke test failed: embedding request returned ${res.status}`);
    await res.text();
  } finally {
    await kill(proc);
  }
}

/** A free TCP port on the host. */
async function findFreePort(host: string): Promise<number> {
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Poll a server's `/v1/models` until it answers 200 or the deadline passes. */
async function waitHealthy(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Kill a child process (best-effort, for the smoke-test embedding server). */
function kill(proc: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const timeout = setTimeout(() => resolve(), 5000);
    proc.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      clearTimeout(timeout);
      resolve();
    }
  });
}
