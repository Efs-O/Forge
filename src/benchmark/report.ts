import type { BenchmarkRunResult, BenchmarkTask } from './contracts';

export interface SmokeReportInput {
  runId: string;
  task: BenchmarkTask;
  results: readonly BenchmarkRunResult[];
  generatedAt?: string;
}

export interface SmokeReportDocument {
  version: 1;
  run_id: string;
  generated_at: string;
  scope: {
    dataset: string;
    revision: string;
    instance_id: string;
    task_count: 1;
    not_a_swe_score: true;
  };
  results: readonly BenchmarkRunResult[];
  ranking: Array<{ arm: string; rank: number; status: BenchmarkRunResult['status'] }>;
  external_references: [];
}

const ORDER: Record<BenchmarkRunResult['status'], number> = {
  PASS: 1,
  FAIL: 2,
  TIMEOUT: 3,
  ERROR: 4,
};

export function rankSmokeResults(
  results: readonly BenchmarkRunResult[],
): SmokeReportDocument['ranking'] {
  let rank = 0;
  let previous: number | undefined;
  return [...results]
    .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.arm.localeCompare(b.arm))
    .map((result, index) => {
      const score = ORDER[result.status];
      if (score !== previous) rank = index + 1;
      previous = score;
      return { arm: result.arm, rank, status: result.status };
    });
}

export function buildSmokeReport(input: SmokeReportInput): SmokeReportDocument {
  return {
    version: 1,
    run_id: input.runId,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    scope: {
      dataset: input.task.dataset,
      revision: input.task.revision,
      instance_id: input.task.instance_id,
      task_count: 1,
      not_a_swe_score: true,
    },
    results: input.results,
    ranking: rankSmokeResults(input.results),
    external_references: [],
  };
}

export function renderSmokeReport(
  results: readonly BenchmarkRunResult[],
  task?: BenchmarkTask,
): string {
  const rows = results.length
    ? results
        .map(
          (result) =>
            `| ${result.arm} | ${result.status} | ${result.runtime_ms ?? '—'} ms | ${result.error ?? ''} |`,
        )
        .join('\n')
    : '| — | ERROR | — | No arms executed |';
  const taskLine = task
    ? `Task: \`${task.instance_id}\` from \`${task.dataset}@${task.revision}\`.`
    : '';
  return [
    '# Forge coding benchmark smoke report',
    '',
    taskLine,
    '| Arm | Result | Runtime | Detail |',
    '|---|---|---:|---|',
    rows,
    '',
    '## Interpretation',
    '',
    '> This is one SWE-bench Verified task, not a SWE-bench score. The local ranking is a smoke-test outcome only and must not be extrapolated to a percentage or leaderboard result.',
    '',
    '## External references',
    '',
    'No external SWE figures are included. Published SWE results require a separate table with their dataset, harness, date, and source.',
  ].join('\n');
}
