import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchmarkTask } from './contracts';
import { commandSucceeded, runProcess } from './process';

export interface SweTaskRecord {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  test_patch: string;
  gold_patch: string;
  metadata: Record<string, unknown>;
}

interface DatasetRow {
  row?: Record<string, unknown>;
}

interface DatasetResponse {
  rows?: DatasetRow[];
  num_rows_total?: number;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`SWE task record is missing ${key}.`);
  }
  return value;
}

export function readManifest(filePath: string): BenchmarkTask {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read benchmark manifest ${filePath}: ${String(error)}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('Benchmark manifest must be a JSON object.');
  const input = raw as Record<string, unknown>;
  const instanceId = stringField(input, 'instance_id');
  const dataset = stringField(input, 'dataset');
  const split = stringField(input, 'split');
  const revision = typeof input.revision === 'string' && input.revision ? input.revision : 'main';
  const timeout = input.timeout_minutes;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Benchmark manifest timeout_minutes must be a positive number.');
  }
  if (!dataset.toLowerCase().includes('swe-bench_verified')) {
    throw new Error(`Only the official SWE-bench Verified dataset is supported, got ${dataset}.`);
  }
  if (split !== 'test') throw new Error('SWE-bench Verified smoke runs must use split "test".');
  const result: BenchmarkTask = {
    instance_id: instanceId,
    dataset,
    split,
    revision,
    timeout_minutes: timeout,
  };
  if (typeof input.model === 'string' && input.model) result.model = input.model;
  return result;
}

async function fetchRows(task: BenchmarkTask): Promise<SweTaskRecord> {
  const base = new URL('https://datasets-server.huggingface.co/rows');
  base.searchParams.set('dataset', task.dataset);
  base.searchParams.set('config', 'default');
  base.searchParams.set('split', task.split);
  base.searchParams.set('revision', task.revision);
  for (let offset = 0; ; offset += 100) {
    base.searchParams.set('offset', String(offset));
    base.searchParams.set('length', '100');
    const response = await fetch(base, { signal: AbortSignal.timeout(30_000) });
    const body = (await response.json().catch(() => undefined)) as DatasetResponse | undefined;
    if (!response.ok) throw new Error(`SWE dataset fetch failed with HTTP ${response.status}.`);
    const rows = body?.rows ?? [];
    const match = rows.find((entry) => entry.row?.instance_id === task.instance_id)?.row;
    if (match) {
      return {
        instance_id: stringField(match, 'instance_id'),
        repo: stringField(match, 'repo'),
        base_commit: stringField(match, 'base_commit'),
        problem_statement: stringField(match, 'problem_statement'),
        test_patch: stringField(match, 'test_patch'),
        gold_patch: stringField(match, 'patch'),
        metadata: { ...match, patch: undefined, test_patch: undefined },
      };
    }
    if (
      rows.length === 0 ||
      offset + rows.length >= (body?.num_rows_total ?? Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(
        `SWE task ${task.instance_id} was not found in ${task.dataset}@${task.revision}.`,
      );
    }
  }
}

export async function fetchSweTask(task: BenchmarkTask): Promise<SweTaskRecord> {
  return fetchRows(task);
}

export function publicTaskRecord(task: SweTaskRecord): Record<string, unknown> {
  return {
    instance_id: task.instance_id,
    repo: task.repo,
    base_commit: task.base_commit,
    problem_statement: task.problem_statement,
    metadata: task.metadata,
  };
}

export async function bootstrapWorkspace(
  task: SweTaskRecord,
  workspacePath: string,
): Promise<{ head: string; status: string }> {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(task.repo))
    throw new Error(`Invalid public repository name: ${task.repo}`);
  if (fs.existsSync(workspacePath)) throw new Error(`Workspace already exists: ${workspacePath}`);
  fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
  const init = await runProcess('git', ['init', workspacePath], { timeoutMs: 30_000 });
  if (!commandSucceeded(init))
    throw new Error(`git init failed: ${init.stderr || init.stdout}`.trim());
  const remote = await runProcess(
    'git',
    ['remote', 'add', 'origin', `https://github.com/${task.repo}.git`],
    { cwd: workspacePath, timeoutMs: 30_000 },
  );
  if (!commandSucceeded(remote))
    throw new Error(`git remote setup failed: ${remote.stderr || remote.stdout}`.trim());
  // Fetch only the pinned tree. A full clone exposes later commits, which can
  // contain the official fix and would invalidate the smoke comparison.
  const fetch = await runProcess('git', ['fetch', '--depth', '1', 'origin', task.base_commit], {
    cwd: workspacePath,
    timeoutMs: 15 * 60_000,
  });
  if (!commandSucceeded(fetch))
    throw new Error(`git fetch failed: ${fetch.stderr || fetch.stdout}`.trim());
  const checkout = await runProcess('git', ['checkout', '--detach', 'FETCH_HEAD'], {
    cwd: workspacePath,
    timeoutMs: 5 * 60_000,
  });
  if (!commandSucceeded(checkout))
    throw new Error(`git checkout failed: ${checkout.stderr || checkout.stdout}`.trim());
  const removeRemote = await runProcess('git', ['remote', 'remove', 'origin'], {
    cwd: workspacePath,
    timeoutMs: 30_000,
  });
  if (!commandSucceeded(removeRemote))
    throw new Error(
      `git remote cleanup failed: ${removeRemote.stderr || removeRemote.stdout}`.trim(),
    );
  const head = await runProcess('git', ['rev-parse', 'HEAD'], {
    cwd: workspacePath,
    timeoutMs: 30_000,
  });
  const status = await runProcess('git', ['status', '--porcelain'], {
    cwd: workspacePath,
    timeoutMs: 30_000,
  });
  if (!commandSucceeded(head) || !commandSucceeded(status))
    throw new Error('Could not verify the prepared SWE workspace.');
  const actualHead = head.stdout.trim();
  if (actualHead !== task.base_commit) {
    throw new Error(`Prepared workspace HEAD ${actualHead} does not equal ${task.base_commit}.`);
  }
  if (status.stdout.trim()) throw new Error('Prepared SWE workspace is not clean.');
  return { head: actualHead, status: status.stdout };
}
