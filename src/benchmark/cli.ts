import { preparePreflight, type BenchmarkOptions } from './preflight';
import { executeBenchmark, writeReports } from './orchestrator';
import { runBenchmarkPing, type PingOptions } from './ping';

export async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  process.stdout.write(`forge-bench: preparing ${options.arms.join(', ')}\n`);
  const context = await preparePreflight(options);
  process.stdout.write(`forge-bench: preflight passed; run=${context.runId}\n`);
  const results = await executeBenchmark(context);
  writeReports(context, results);
  process.stdout.write(`forge-bench: ${options.dryRun ? 'dry run passed' : 'complete'}\n`);
  process.stdout.write(`forge-bench: report ${context.runDir}\n`);
}

export async function runPing(options: PingOptions): Promise<void> {
  process.stdout.write(`forge-bench: pinging ${options.arms.join(', ')}\n`);
  await runBenchmarkPing(options);
}
