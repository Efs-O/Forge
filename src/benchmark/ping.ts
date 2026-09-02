import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectQwenEndpoint } from './preflight';
import { runQwenForge, runQwenMinimal, type AgentExecution, type ArmCallbacks } from './arms';
import type { BenchmarkArm } from './contracts';
import { createBenchmarkToolHost } from './toolHost';

export interface PingOptions {
  outputRoot: string;
  arms: BenchmarkArm[];
  baseUrl: string;
  model?: string;
}

interface PingResult {
  arm: BenchmarkArm;
  status: 'PASS' | 'FAIL' | 'TIMEOUT';
  reply: string;
  pong: boolean;
  runtime_ms: number;
  error?: string;
}

function append(file: string, text: string): void {
  fs.appendFileSync(file, text, 'utf8');
}

async function runArm(
  arm: 'qwen-minimal' | 'qwen-forge',
  options: PingOptions,
  model: string,
  armDir: string,
): Promise<PingResult> {
  const started = Date.now();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bench-ping-'));
  const events = path.join(armDir, 'events.jsonl');
  const stdout = path.join(armDir, 'stdout.log');
  const stderr = path.join(armDir, 'stderr.log');
  const callbacks: ArmCallbacks = {
    event: (kind, text) =>
      append(events, `${JSON.stringify({ at: new Date().toISOString(), kind, text })}\n`),
    stdout: (text) => append(stdout, text),
    stderr: (text) => append(stderr, text),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  let execution: AgentExecution;
  try {
    const host = createBenchmarkToolHost(workspace);
    execution =
      arm === 'qwen-minimal'
        ? await runQwenMinimal(
            options.baseUrl,
            model,
            'Reply with exactly PONG and do not call tools. Do not modify files.',
            host,
            controller.signal,
            callbacks,
          )
        : await runQwenForge(
            options.baseUrl,
            model,
            'Reply with exactly PONG and do not call tools. Do not modify files.',
            host,
            controller.signal,
            callbacks,
          );
  } catch (error) {
    execution = {
      status: controller.signal.aborted ? 'timed_out' : 'failed',
      finalText: '',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  const reply = execution.finalText.trim();
  const status =
    execution.status === 'timed_out'
      ? 'TIMEOUT'
      : execution.status === 'completed' && reply
        ? 'PASS'
        : 'FAIL';
  const result: PingResult = {
    arm,
    status,
    reply,
    pong: /^PONG[.!]?$/iu.test(reply),
    runtime_ms: Date.now() - started,
    ...(execution.error ? { error: execution.error } : {}),
  };
  fs.writeFileSync(path.join(armDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}

export async function runBenchmarkPing(options: PingOptions): Promise<void> {
  const allowed = ['qwen-minimal', 'qwen-forge'] as const;
  const invalid = options.arms.filter((arm) => !allowed.some((candidate) => candidate === arm));
  if (invalid.length) throw new Error(`bench:ping only permits Qwen arms: ${invalid.join(', ')}`);
  const arms = options.arms as Array<(typeof allowed)[number]>;
  const runId = `ping-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const runDir = path.resolve(options.outputRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const facts = await inspectQwenEndpoint(options.baseUrl, options.model);
  const results: PingResult[] = [];
  for (const arm of arms) {
    const armDir = path.join(runDir, arm);
    fs.mkdirSync(armDir, { recursive: true });
    results.push(await runArm(arm, options, facts.model, armDir));
    process.stdout.write(`forge-bench: ${arm} ${results.at(-1)!.status}\n`);
  }
  fs.writeFileSync(
    path.join(runDir, 'ping.json'),
    JSON.stringify(
      {
        version: 1,
        run_id: runId,
        endpoint: options.baseUrl,
        model: facts.model,
        llama_models: facts.models,
        llama_props: facts.props,
        arms,
        results,
      },
      null,
      2,
    ),
    'utf8',
  );
  if (results.some((result) => result.status !== 'PASS'))
    throw new Error(`bench:ping failed. Details: ${path.join(runDir, 'ping.json')}`);
  process.stdout.write(`forge-bench: ping passed; details=${path.join(runDir, 'ping.json')}\n`);
}
