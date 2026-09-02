import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BenchmarkTask } from './contracts';
import type { SweTaskRecord } from './task';
import { runProcess } from './process';

export interface EvaluatorResult {
  resolved: boolean | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function jsonValues(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [value, ...Object.values(record).flatMap(jsonValues)];
}

function findResolved(dir: string, stdout: string): boolean | undefined {
  const candidates: unknown[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        entry.name !== 'predictions.jsonl'
      ) {
        try {
          candidates.push(JSON.parse(fs.readFileSync(full, 'utf8')));
        } catch {
          // The harness may leave partial diagnostics beside its report.
        }
      }
    }
  };
  visit(dir);
  for (const value of candidates.flatMap(jsonValues)) {
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as Record<string, unknown>).resolved === 'boolean'
    ) {
      return (value as Record<string, unknown>).resolved as boolean;
    }
  }
  const resolved = /["']resolved["']\s*:\s*(true|false)/iu.exec(stdout);
  return resolved ? resolved[1]!.toLowerCase() === 'true' : undefined;
}

function evaluatorProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<Awaited<ReturnType<typeof runProcess>>> {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/iu.test(executable)) {
    return runProcess(executable, args, { cwd, timeoutMs: 60 * 60 * 1000 });
  }
  const quote = (value: string): string => `"${value.replace(/"/gu, '\\"')}"`;
  return runProcess(
    'cmd.exe',
    ['/d', '/s', '/c', [quote(executable), ...args.map(quote)].join(' ')],
    { cwd, timeoutMs: 60 * 60 * 1000 },
  );
}

export async function runOfficialSweEvaluator(
  task: BenchmarkTask,
  record: SweTaskRecord,
  patch: string,
  evaluatorDir: string,
  evaluatorExecutable: string,
): Promise<EvaluatorResult> {
  fs.mkdirSync(evaluatorDir, { recursive: true });
  const prediction = {
    instance_id: record.instance_id,
    model_name_or_path: 'forge-benchmark-smoke',
    model_patch: patch,
  };
  const predictionsPath = path.join(evaluatorDir, 'predictions.jsonl');
  fs.writeFileSync(predictionsPath, `${JSON.stringify(prediction)}\n`, 'utf8');
  const dataset = task.dataset === 'princeton-nlp/SWE-bench_Verified' ? 'verified' : task.dataset;
  const args = [
    'eval',
    dataset,
    '-p',
    predictionsPath,
    '-i',
    record.instance_id,
    '-j',
    '1',
    '--run-id',
    `forge-${record.instance_id}-${Date.now()}`,
  ];
  const result = await evaluatorProcess(evaluatorExecutable, args, evaluatorDir);
  fs.writeFileSync(path.join(evaluatorDir, 'stdout.log'), result.stdout, 'utf8');
  fs.writeFileSync(path.join(evaluatorDir, 'stderr.log'), result.stderr, 'utf8');
  return {
    resolved: findResolved(evaluatorDir, `${result.stdout}\n${result.stderr}`),
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function evaluatorSucceeded(result: EvaluatorResult): boolean {
  // The harness reports unresolved tests as a normal completed evaluation; its
  // resolved field, not the agent prose or process wording, is authoritative.
  return result.resolved !== undefined;
}
