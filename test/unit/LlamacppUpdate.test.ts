import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { jobsFetchReleaseByTag, jobsDownloadBinary } = vi.hoisted(() => ({
  jobsFetchReleaseByTag: vi.fn(),
  jobsDownloadBinary: vi.fn(),
}));
vi.mock('../../src/jobs/jobsFetch', () => ({
  jobsFetchReleaseByTag,
  jobsDownloadBinary,
}));

import {
  approveStaged,
  performSwitch,
  processPendingSwitches,
  stageLlamacppUpdate,
  type LlamacppUpdateEnv,
} from '../../src/jobs/actions/llamacppUpdate';
import { LlamacppAction } from '../../src/jobs/actions/llamacppAction';
import {
  STAGE_TTL_MS,
  buildDirForTag,
  newBinaryPath,
  readStaged,
  writeStaged,
  type StagedBuild,
} from '../../src/jobs/actions/stagedBuild';
import type { Action, JobFile } from '../../src/jobs/jobSchema';

const TAG = 'b10991';
const MAIN = `llama-${TAG}-bin-win-cuda-13.3-x64.zip`;
const CUDART = `cudart-llama-${TAG}-bin-win-cuda-13.3-x64.zip`;
const DIGEST_HEX = 'aaaa';
const MAIN_DIGEST = `sha256:${DIGEST_HEX}`;
const CUDART_DIGEST = `sha256:${DIGEST_HEX}`;

let localRoot: string;
let jobsRoot: string;
let nowMs: number;
let setBinaries: (string | undefined)[];
let delivered: string[];
let restartCalls: string[];
let restartFail: boolean;
let activeModel: string | undefined;
let currentBinary: string | undefined;
let versionOut: string;
let versionCode: number | null;
let devicesCode: number | null;
/** Jobs deleted while their check or stage was in flight. */
let deletedJobs: Set<string>;

const action: Extract<Action, { kind: 'llamacpp_update' }> = {
  kind: 'llamacpp_update',
  mode: 'prepare',
  asset_pattern: `*${TAG}*`,
};

function defaultRelease() {
  return {
    tag: TAG,
    assets: [
      { name: MAIN, digest: MAIN_DIGEST, downloadUrl: `https://github.com/x/${MAIN}` },
      { name: CUDART, digest: CUDART_DIGEST, downloadUrl: `https://github.com/x/${CUDART}` },
    ],
  };
}

function makeEnv() {
  const env: LlamacppUpdateEnv = {
    jobsRoot,
    localRoot,
    jobExists: async (jobId) => !deletedJobs.has(jobId),
    fetchOptions: () => ({ allowedHosts: ['api.github.com'], etagCache: new Map() }),
    getConfig: () => ({
      currentBinary,
      embeddings: undefined,
      llama_server: undefined,
    }),
    runCommand: async (binary, args) => {
      if (args[0] === '--version') return { code: versionCode, stdout: versionOut, stderr: '' };
      if (args[0] === '--list-devices') return { code: devicesCode, stdout: 'CUDA0', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
    sha256File: async () => DIGEST_HEX,
    extractZip: async (_zip, dest) => {
      fs.writeFileSync(path.join(dest, 'llama-server.exe'), 'binary');
    },
    setBinary: (b) => {
      setBinaries.push(b);
    },
    restartModel: async (model) => {
      restartCalls.push(model);
      // Fail the first restart (the switch's post-check); the restore restart
      // (the second call) succeeds so the failure path can clear the stage.
      if (restartFail && restartCalls.length === 1)
        throw new Error('server did not become healthy');
    },
    activeModel: () => activeModel,
    deliver: async (_job, text) => {
      delivered.push(text);
    },
    now: () => nowMs,
  };
  return env;
}

function writeStagedFor(jobId: string, overrides: Partial<StagedBuild> = {}): StagedBuild {
  const staged: StagedBuild = {
    job_id: jobId,
    tag: TAG,
    new_binary: newBinaryPath(localRoot, TAG),
    old_binary: currentBinary,
    assets: [
      { name: MAIN, digest: MAIN_DIGEST },
      { name: CUDART, digest: CUDART_DIGEST },
    ],
    staged_at: nowMs - 1000,
    switch_pending: false,
    mode: 'prepare',
    ...overrides,
  };
  writeStaged(jobsRoot, staged);
  return staged;
}

beforeEach(() => {
  deletedJobs = new Set();
  localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-llama-local-'));
  jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-llama-jobs-'));
  nowMs = 1_700_000_000_000;
  setBinaries = [];
  delivered = [];
  restartCalls = [];
  restartFail = false;
  activeModel = 'test-model';
  currentBinary = 'llama.cpp-b10894';
  versionOut = `llama.cpp version ${TAG}`;
  versionCode = 0;
  devicesCode = 0;
  jobsFetchReleaseByTag.mockReset().mockResolvedValue(defaultRelease());
  jobsDownloadBinary.mockReset().mockResolvedValue(1024);
});

afterEach(() => {
  for (const dir of [localRoot, jobsRoot]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('stageLlamacppUpdate (stages 2-6)', () => {
  it('a job deleted during its check is never staged, and nothing is downloaded', async () => {
    deletedJobs.add('llama');
    const result = await stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, makeEnv());
    expect(result.summary).toMatch(/deleted during its check/);
    expect(jobsDownloadBinary).not.toHaveBeenCalled();
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('digest mismatch stops before extract and leaves no staged file', async () => {
    const env = makeEnv();
    env.sha256File = async () => 'deadbeef'; // differs from MAIN_DIGEST
    await expect(
      stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env),
    ).rejects.toThrow(/digest mismatch/);
    expect(jobsDownloadBinary).toHaveBeenCalledTimes(2);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
    expect(setBinaries).toEqual([]);
  });

  it('a missing digest is refused, never installed unverified', async () => {
    jobsFetchReleaseByTag.mockResolvedValue({
      tag: TAG,
      assets: [
        { name: MAIN, digest: '', downloadUrl: `https://github.com/x/${MAIN}` },
        { name: CUDART, digest: CUDART_DIGEST, downloadUrl: `https://github.com/x/${CUDART}` },
      ],
    });
    const env = makeEnv();
    await expect(
      stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env),
    ).rejects.toThrow(/no digest/);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('a release missing the cudart zip is refused as a partial build', async () => {
    jobsFetchReleaseByTag.mockResolvedValue({
      tag: TAG,
      assets: [{ name: MAIN, digest: MAIN_DIGEST, downloadUrl: `https://github.com/x/${MAIN}` }],
    });
    const env = makeEnv();
    await expect(
      stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env),
    ).rejects.toThrow(/missing the cudart/);
  });

  it('an asset_pattern matching neither picked asset fails loudly', async () => {
    const bad: Extract<Action, { kind: 'llamacpp_update' }> = {
      kind: 'llamacpp_update',
      mode: 'prepare',
      asset_pattern: 'macos-rosetta.zip',
    };
    const env = makeEnv();
    await expect(stageLlamacppUpdate(bad, 'llama', 'ggml-org/llama.cpp', TAG, env)).rejects.toThrow(
      /asset_pattern/,
    );
  });

  it('an existing build folder stops the run without overwriting', async () => {
    const env = makeEnv();
    fs.mkdirSync(buildDirForTag(localRoot, TAG), { recursive: true });
    await expect(
      stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env),
    ).rejects.toThrow(/already exists/);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('a smoke-test failure leaves the config untouched and no staged file', async () => {
    versionCode = 1;
    versionOut = 'boom';
    const env = makeEnv();
    await expect(
      stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env),
    ).rejects.toThrow(/--version did not report/);
    expect(setBinaries).toEqual([]);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('prepare mode stages with switch_pending false and asks for approval', async () => {
    const env = makeEnv();
    await stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env);
    const staged = readStaged(jobsRoot, 'llama');
    expect(staged?.switch_pending).toBe(false);
    expect(staged?.old_binary).toBe('llama.cpp-b10894');
    expect(delivered[0]).toMatch(/approve/);
  });

  it('a staging failure clears a pre-existing staged build', async () => {
    // A previous build is staged and waiting to switch; a new release fails
    // its digest check. The old stage must not survive to be switched.
    writeStagedFor('llama', { switch_pending: true });
    const env = makeEnv();
    env.sha256File = async () => 'deadbeef';
    await expect(
      stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env),
    ).rejects.toThrow(/digest mismatch/);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('apply mode stages with switch_pending true (no approval gate)', async () => {
    const apply: Extract<Action, { kind: 'llamacpp_update' }> = {
      kind: 'llamacpp_update',
      mode: 'apply',
      asset_pattern: `*${TAG}*`,
    };
    const env = makeEnv();
    await stageLlamacppUpdate(apply, 'llama', 'ggml-org/llama.cpp', TAG, env);
    expect(readStaged(jobsRoot, 'llama')?.switch_pending).toBe(true);
    expect(delivered[0]).not.toMatch(/approve/);
  });

  it('a throwing extractZip leaves no build dir, and a retry of the same tag succeeds (F3)', async () => {
    let fail = true;
    const env = makeEnv();
    env.extractZip = async (_zip, dest) => {
      if (fail) {
        // A partial extract: the dir exists and is half-filled when it throws.
        fs.writeFileSync(path.join(dest, 'partial-file.txt'), 'half');
        throw new Error('disk full');
      }
      fs.writeFileSync(path.join(dest, 'llama-server.exe'), 'binary');
    };
    await expect(
      stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env),
    ).rejects.toThrow(/disk full/);
    // The partial build dir must be gone, so the retry is not blocked at the
    // "already exists" guard. The staged zips are deleted too.
    expect(fs.existsSync(buildDirForTag(localRoot, TAG))).toBe(false);
    expect(fs.existsSync(path.join(localRoot, 'staging', MAIN))).toBe(false);
    expect(fs.existsSync(path.join(localRoot, 'staging', CUDART))).toBe(false);
    // The retry now succeeds: the dir is recreated and the binary is present.
    fail = false;
    const result = await stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env);
    expect(result.summary).toMatch(/staged/);
    expect(fs.existsSync(newBinaryPath(localRoot, TAG))).toBe(true);
    expect(readStaged(jobsRoot, 'llama')).toBeDefined();
  });

  it('the staging zips are deleted after a successful stage (F3)', async () => {
    const env = makeEnv();
    await stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env);
    expect(fs.existsSync(path.join(localRoot, 'staging', MAIN))).toBe(false);
    expect(fs.existsSync(path.join(localRoot, 'staging', CUDART))).toBe(false);
    // The build dir itself stays (old builds are never deleted).
    expect(fs.existsSync(newBinaryPath(localRoot, TAG))).toBe(true);
  });

  it('the staging zips are deleted after a failed stage (F3)', async () => {
    const env = makeEnv();
    env.sha256File = async () => 'deadbeef'; // digest mismatch, after download
    await expect(
      stageLlamacppUpdate(action, 'llama', 'ggml-org/llama.cpp', TAG, env),
    ).rejects.toThrow(/digest mismatch/);
    expect(fs.existsSync(path.join(localRoot, 'staging', MAIN))).toBe(false);
    expect(fs.existsSync(path.join(localRoot, 'staging', CUDART))).toBe(false);
  });
});

describe('performSwitch (stages 7-8)', () => {
  it('switches without a restart when no model is loaded', async () => {
    activeModel = undefined;
    const staged = writeStagedFor('llama', { switch_pending: true });
    const env = makeEnv();
    const result = await performSwitch(jobsRoot, staged, env);
    expect(result.ok).toBe(true);
    expect(setBinaries).toEqual([staged.new_binary]);
    expect(restartCalls).toEqual([]);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('a post-check failure restores the previous binary and restarts again', async () => {
    restartFail = true;
    const staged = writeStagedFor('llama', { switch_pending: true });
    const env = makeEnv();
    const result = await performSwitch(jobsRoot, staged, env);
    expect(result.ok).toBe(false);
    // new binary written, then the old one restored
    expect(setBinaries).toEqual([staged.new_binary, 'llama.cpp-b10894']);
    // two restarts: the failed switch + the restore
    expect(restartCalls).toEqual(['test-model', 'test-model']);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
    expect(delivered[0]).toMatch(/post-check failed/);
  });

  it('a post-check failure with no prior binary restores to nothing', async () => {
    currentBinary = undefined;
    activeModel = 'test-model';
    restartFail = true;
    const staged = writeStagedFor('llama', { switch_pending: true, old_binary: undefined });
    const env = makeEnv();
    const result = await performSwitch(jobsRoot, staged, env);
    expect(result.ok).toBe(false);
    // the new binary was written, then restored to nothing (no prior binary)
    expect(setBinaries).toEqual([staged.new_binary, undefined]);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('a passing post-check clears the staged file and reports the switch', async () => {
    const staged = writeStagedFor('llama', { switch_pending: true });
    const env = makeEnv();
    const result = await performSwitch(jobsRoot, staged, env);
    expect(result.ok).toBe(true);
    expect(setBinaries).toEqual([staged.new_binary]);
    expect(restartCalls).toEqual(['test-model']);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
    expect(delivered[0]).toMatch(/switched/);
  });

  it('an expired staged build is not switched', async () => {
    const staged = writeStagedFor('llama', {
      switch_pending: true,
      staged_at: nowMs - STAGE_TTL_MS - 1000,
    });
    const env = makeEnv();
    const result = await performSwitch(jobsRoot, staged, env);
    expect(result.ok).toBe(false);
    expect(setBinaries).toEqual([]);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('rolls back to the binary present AT SWITCH TIME, not the staged one (F5)', async () => {
    // Staged when the config pointed at 'staged-old-binary'. Between staging
    // and the switch the user changed it to 'user-changed-binary'. The
    // post-check fails and the rollback must restore the value that was in the
    // config a moment before the switch, not the stale staged snapshot.
    const staged = writeStagedFor('llama', {
      switch_pending: true,
      old_binary: 'staged-old-binary',
    });
    currentBinary = 'user-changed-binary';
    restartFail = true;
    const env = makeEnv();
    const result = await performSwitch(jobsRoot, staged, env);
    expect(result.ok).toBe(false);
    expect(setBinaries).toEqual([staged.new_binary, 'user-changed-binary']);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('does not write back a restore target that no longer exists (F5)', async () => {
    // The config binary at switch time points at a build that has been deleted.
    // Writing it back would leave the config on a path that does not resolve.
    const staged = writeStagedFor('llama', {
      switch_pending: true,
      old_binary: 'staged-old-binary',
    });
    // A non-existent absolute path (the production shape of currentBinary).
    currentBinary = path.join(localRoot, 'deleted-build', 'llama-server.exe');
    restartFail = true;
    const env = makeEnv();
    const result = await performSwitch(jobsRoot, staged, env);
    expect(result.ok).toBe(false);
    // Only the new binary was written; the missing restore target was not.
    expect(setBinaries).toEqual([staged.new_binary]);
    expect(delivered[0]).toMatch(/no longer exists/);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });
});

describe('approveStaged (/job <n> approve)', () => {
  it('reports when there is no staged build to approve', () => {
    expect(approveStaged(jobsRoot, 'none', nowMs)).toMatch(/no staged build/);
  });

  it('discards an expired staged build instead of switching it', () => {
    writeStagedFor('llama', { staged_at: nowMs - STAGE_TTL_MS - 1000 });
    const msg = approveStaged(jobsRoot, 'llama', nowMs);
    expect(msg).toMatch(/expired/);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });

  it('does not re-flag an already-pending build', () => {
    writeStagedFor('llama', { switch_pending: true });
    expect(approveStaged(jobsRoot, 'llama', nowMs)).toMatch(/already switching/);
  });

  it('flags a valid prepare build so the next idle tick switches it', () => {
    writeStagedFor('llama', { switch_pending: false });
    const msg = approveStaged(jobsRoot, 'llama', nowMs);
    expect(msg).toMatch(/approved/);
    expect(readStaged(jobsRoot, 'llama')?.switch_pending).toBe(true);
  });
});

describe('LlamacppAction (scheduler-facing wrapper)', () => {
  it('defers the switch while busy and performs it on the next idle tick (AC10)', async () => {
    writeStagedFor('llama', { switch_pending: true });
    let busy: string | undefined = 'a turn is streaming';
    const deps = {
      localRoot,
      getLlamacppConfig: () => ({
        currentBinary,
        embeddings: undefined,
        llama_server: undefined,
      }),
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      sha256File: async () => DIGEST_HEX,
      extractZip: async () => undefined,
      setBinary: (b: string | undefined) => setBinaries.push(b),
      restartModel: async (model: string) => {
        restartCalls.push(model);
      },
      activeModel: () => activeModel,
    };
    const action = new LlamacppAction(deps, {
      store: { root: jobsRoot, load: async () => ({}) as JobFile },
      allowedHosts: () => ['api.github.com'],
      busy: () => busy,
      now: () => nowMs,
      deliver: async (_job, text) => {
        delivered.push(text);
      },
      notifyLocal: () => undefined,
    });
    // Busy: the switch is deferred, nothing is written, the stage stays.
    await action.processPendingSwitches();
    expect(setBinaries).toEqual([]);
    expect(readStaged(jobsRoot, 'llama')?.switch_pending).toBe(true);
    // Idle: the next tick performs the switch.
    busy = undefined;
    await action.processPendingSwitches();
    expect(setBinaries).toEqual([newBinaryPath(localRoot, TAG)]);
    expect(restartCalls).toEqual(['test-model']);
    expect(readStaged(jobsRoot, 'llama')).toBeUndefined();
  });
});

describe('processPendingSwitches (idle-tick pass)', () => {
  it('never switches a staged build whose job was deleted, and drops it', async () => {
    writeStagedFor('gone', { switch_pending: true });
    deletedJobs.add('gone');
    const summaries = await processPendingSwitches(jobsRoot, makeEnv());
    expect(summaries).toEqual([]);
    expect(setBinaries).toEqual([]);
    expect(restartCalls).toEqual([]);
    expect(readStaged(jobsRoot, 'gone')).toBeUndefined();
  });

  it('switches only the builds that are pending, leaving the rest staged', async () => {
    writeStagedFor('pending', { switch_pending: true });
    writeStagedFor('waiting', { switch_pending: false });
    const env = makeEnv();
    const summaries = await processPendingSwitches(jobsRoot, env);
    expect(summaries).toHaveLength(1);
    expect(readStaged(jobsRoot, 'pending')).toBeUndefined();
    expect(readStaged(jobsRoot, 'waiting')?.switch_pending).toBe(false);
  });

  it('returns empty when the staged dir does not exist yet', async () => {
    const env = makeEnv();
    await expect(processPendingSwitches(jobsRoot, env)).resolves.toEqual([]);
  });
});
