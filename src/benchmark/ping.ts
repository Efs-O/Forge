import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runQwenForge, runQwenMinimal, type AgentExecution, type ArmCallbacks } from './arms';
import type { BenchmarkArm } from './contracts';
import { createBenchmarkToolHost } from './toolHost';
import {
  ensureForgeQwen,
  startMinimalQwen,
  stopMinimalQwen,
  unloadForgeQwen,
  type QwenServerHandle,
} from './qwenServerLifecycle';

export interface PingOptions {
  outputRoot: string;
  arms: BenchmarkArm[];
  baseUrl: string;
  model?: string;
  forgeConfigPath: string;
}

interface PingResult {
  arm: BenchmarkArm;
  server_phase: 'forge' | 'minimal';
  endpoint: string;
  model: string;
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
  endpoint: string,
  model: string,
  phase: 'forge' | 'minimal',
  armDir: string,
  requestModel?: QwenServerHandle['requestModel'],
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
    const prompt = 'Reply with exactly PONG and do not call tools. Do not modify files.';
    execution =
      arm === 'qwen-minimal'
        ? await runQwenMinimal(
            endpoint,
            model,
            prompt,
            host,
            controller.signal,
            callbacks,
            requestModel,
          )
        : await runQwenForge(
            endpoint,
            model,
            prompt,
            host,
            controller.signal,
            callbacks,
            requestModel,
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
    server_phase: phase,
    endpoint,
    model,
    status,
    reply,
    pong: /^PONG[.!]?$/iu.test(reply),
    runtime_ms: Date.now() - started,
    ...(execution.error ? { error: execution.error } : {}),
  };
  fs.writeFileSync(path.join(armDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}

function serverLogs(dir: string): {
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
} {
  return {
    onStdout: (text) => append(path.join(dir, 'server.stdout.log'), text),
    onStderr: (text) => append(path.join(dir, 'server.stderr.log'), text),
  };
}

export async function runBenchmarkPing(options: PingOptions): Promise<void> {
  const allowed = ['qwen-minimal', 'qwen-forge'] as const;
  const invalid = options.arms.filter((arm) => !allowed.some((candidate) => candidate === arm));
  if (invalid.length) throw new Error(`bench:ping only permits Qwen arms: ${invalid.join(', ')}`);
  const arms = options.arms as Array<(typeof allowed)[number]>;
  const runId = `ping-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const runDir = path.resolve(options.outputRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const results: PingResult[] = [];
  const phases: Record<string, unknown> = {};
  let forge: QwenServerHandle | undefined;
  let minimal: QwenServerHandle | undefined;
  let forgeEndpoint: string | undefined;
  try {
    // Run Forge first so the second arm proves that its server parameters were
    // torn down before the minimal direct llama-server is started.
    if (arms.includes('qwen-forge')) {
      const forgeDir = path.join(runDir, 'qwen-forge');
      fs.mkdirSync(forgeDir, { recursive: true });
      forge = await ensureForgeQwen({
        forgeConfigPath: options.forgeConfigPath,
        model: options.model,
      });
      forgeEndpoint = forge.endpoint;
      phases.forge = { endpoint: forge.endpoint, model: forge.facts.model, facts: forge.facts };
      results.push(
        await runArm(
          'qwen-forge',
          forge.endpoint,
          forge.facts.model,
          'forge',
          forgeDir,
          forge.requestModel,
        ),
      );
      process.stdout.write(`forge-bench: qwen-forge ${results.at(-1)!.status}\n`);
      await unloadForgeQwen(forge, options.forgeConfigPath);
      forge = undefined;
    }
    if (arms.includes('qwen-minimal')) {
      const minimalDir = path.join(runDir, 'qwen-minimal');
      fs.mkdirSync(minimalDir, { recursive: true });
      const logs = serverLogs(minimalDir);
      minimal = await startMinimalQwen(
        {
          forgeConfigPath: options.forgeConfigPath,
          model: options.model,
          ...logs,
        },
        forgeEndpoint ?? options.baseUrl,
      );
      phases.minimal = {
        endpoint: minimal.endpoint,
        model: minimal.facts.model,
        facts: minimal.facts,
      };
      results.push(
        await runArm(
          'qwen-minimal',
          minimal.endpoint,
          minimal.facts.model,
          'minimal',
          minimalDir,
          minimal.requestModel,
        ),
      );
      process.stdout.write(`forge-bench: qwen-minimal ${results.at(-1)!.status}\n`);
    }
  } finally {
    if (minimal) await stopMinimalQwen(minimal);
    if (forge) await unloadForgeQwen(forge, options.forgeConfigPath);
  }
  fs.writeFileSync(
    path.join(runDir, 'ping.json'),
    JSON.stringify({ version: 2, run_id: runId, arms, phases, results }, null, 2),
    'utf8',
  );
  if (results.length !== arms.length || results.some((result) => result.status !== 'PASS'))
    throw new Error(`bench:ping failed. Details: ${path.join(runDir, 'ping.json')}`);
  process.stdout.write(`forge-bench: ping passed; details=${path.join(runDir, 'ping.json')}\n`);
}
