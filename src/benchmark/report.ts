import type { BenchmarkRunResult } from './contracts';

export function renderSmokeReport(results: readonly BenchmarkRunResult[]): string {
  const rows = results.map((r) => `| ${r.arm} | ${r.status} | ${r.error ?? ''} |`).join('\n');
  return [
    '# Forge coding benchmark smoke report',
    '',
    '| Arm | Result | Detail |',
    '|---|---|---|',
    rows || '| — | ERROR | No arms executed |',
    '',
    '> This is one SWE-bench-style smoke task, not a SWE-bench score or ranking estimate.',
  ].join('\n');
}
