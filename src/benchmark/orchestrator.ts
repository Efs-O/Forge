import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderSmokeReport, buildSmokeReport } from './report';
import type { BenchmarkArm, BenchmarkRunResult } from './contracts';
import { runOfficialSweEvaluator, evaluatorSucceeded } from './evaluator';
import {
  runCliArm,
  runQwenForge,
  runQwenMinimal,
  type AgentExecution,
  type ArmCallbacks,
} from './arms';
import { BENCHMARK_TOOL_NAMES, createBenchmarkToolHost } from './toolHost';
import { captureCliUsage, qwenUsage } from './usageCapture';
import { commandSucceeded, runProcess } from './process';
import type { PreflightContext } from './preflight';
import {
  ensureForgeQwen,
  startMinimalQwen,
  stopMinimalQwen,
  unloadForgeQwen,
  type QwenServerHandle,
} from './qwenServerLifecycle';

function append(file: string, text: string): void {
  fs.appendFileSync(file, text, 'utf8');
}

async function collectPatch(workspace: string, file: string): Promise<string> {
  const staged = await runProcess('git', ['add', '--all'], { cwd: workspace, timeoutMs: 120_000 });
  if (!commandSucceeded(staged))
    throw new Error(`Could not stage the agent patch: ${staged.stderr || staged.stdout}`.trim());
  const diff = await runProcess('git', ['diff', '--binary', 'HEAD'], {
    cwd: workspace,
    timeoutMs: 120_000,
  });
  if (!commandSucceeded(diff))
    throw new Error(`Could not collect the agent patch: ${diff.stderr || diff.stdout}`.trim());
  fs.writeFileSync(file, diff.stdout, 'utf8');
  return diff.stdout;
}

async function runAgent(
  context: PreflightContext,
  arm: BenchmarkArm,
  callbacks: ArmCallbacks,
  signal: AbortSignal,
  server?: QwenServerHandle,
): Promise<AgentExecution> {
  const problem = context.record.problem_statement;
  const endpoint = server?.endpoint ?? context.options.baseUrl;
  const model = server?.facts.model ?? context.model;
  if (arm === 'qwen-minimal')
    return runQwenMinimal(
      endpoint,
      model,
      problem,
      createBenchmarkToolHost(context.workspaces[arm]),
      signal,
      callbacks,
    );
  if (arm === 'qwen-forge')
    return runQwenForge(
      endpoint,
      model,
      problem,
      createBenchmarkToolHost(context.workspaces[arm]),
      signal,
      callbacks,
    );
  const cliName = arm === 'claude-code' ? 'claude' : 'codex';
  const executable = context.cliExecutables[cliName];
  if (!executable) throw new Error(`No preflight executable was recorded for ${cliName}.`);
  return runCliArm(
    cliName,
    executable,
    problem,
    context.workspaces[arm],
    context.task.timeout_minutes * 60_000,
    signal,
    callbacks,
  );
}

async function runArm(
  context: PreflightContext,
  arm: BenchmarkArm,
  server?: QwenServerHandle,
): Promise<BenchmarkRunResult> {
  const armDir = path.join(context.runDir, arm);
  const events = path.join(armDir, 'agent-events.jsonl');
  const stdout = path.join(armDir, 'stdout.log');
  const stderr = path.join(armDir, 'stderr.log');
  const patchFile = path.join(armDir, 'patch.diff');
  const started = new Date();
  let execution: AgentExecution = { status: 'failed', finalText: '' };
  let patch = '';
  const usageFile = path.join(armDir, 'usage.json');
  const runtimeFile = path.join(armDir, 'runtime.json');
  const event = (kind: string, text: string): void =>
    append(events, `${JSON.stringify({ at: new Date().toISOString(), kind, text })}\n`);
  const callbacks: ArmCallbacks = {
    event: (kind, text) => event(kind, text),
    stdout: (text) => append(stdout, text),
    stderr: (text) => append(stderr, text),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), context.task.timeout_minutes * 60_000);
  try {
    event('status', `Starting ${arm} at ${context.record.base_commit}`);
    execution = await runAgent(context, arm, callbacks, controller.signal, server);
    if (execution.finalText) append(stdout, `\n\nFINAL:\n${execution.finalText}\n`);
  } catch (error) {
    execution = {
      status: controller.signal.aborted ? 'timed_out' : 'failed',
      finalText: '',
      error: error instanceof Error ? error.message : String(error),
    };
    event('error', execution.error ?? 'agent failed');
  } finally {
    clearTimeout(timer);
  }
  try {
    patch = await collectPatch(context.workspaces[arm], patchFile);
  } catch (error) {
    execution = {
      ...execution,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    fs.writeFileSync(patchFile, patch, 'utf8');
  }
  const evaluatorDir = path.join(armDir, 'evaluator');
  let evaluator: Awaited<ReturnType<typeof runOfficialSweEvaluator>> | undefined;
  try {
    evaluator = await runOfficialSweEvaluator(
      context.task,
      context.record,
      patch,
      evaluatorDir,
      context.evaluatorExecutable,
    );
  } catch (error) {
    event('error', `Official evaluator failed: ${String(error)}`);
  }
  const usage = arm.startsWith('qwen')
    ? qwenUsage(execution.qwenUsage?.last)
    : captureCliUsage(
        arm === 'claude-code' ? 'claude' : 'codex',
        execution.sessionId,
        started.getTime(),
      );
  const completed = new Date();
  const status =
    execution.status === 'timed_out'
      ? 'TIMEOUT'
      : execution.status !== 'completed'
        ? 'ERROR'
        : evaluator && evaluatorSucceeded(evaluator)
          ? evaluator.resolved
            ? 'PASS'
            : 'FAIL'
          : 'ERROR';
  const runtime = {
    version: 1,
    arm,
    status,
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    runtime_ms: completed.getTime() - started.getTime(),
    forge_commit: await runProcess('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
    })
      .then((r) => r.stdout.trim())
      .catch(() => undefined),
    forge_version: JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'))
      .version,
    os: { platform: process.platform, release: process.release, arch: process.arch },
    task: {
      instance_id: context.task.instance_id,
      base_commit: context.record.base_commit,
      timeout_minutes: context.task.timeout_minutes,
    },
    model: arm.startsWith('qwen')
      ? {
          endpoint: server?.endpoint ?? context.options.baseUrl,
          id: server?.facts.model ?? context.model,
          sampling: { temperature: 0, max_tokens: 4096, enable_thinking: false },
          tool_allowlist: BENCHMARK_TOOL_NAMES,
          models: server?.facts.models ?? context.llamaModels,
          props: server?.facts.props ?? context.llamaProps,
          server_phase: server?.phase,
        }
      : undefined,
    cli:
      arm === 'claude-code' || arm === 'codex'
        ? {
            session_id: execution.sessionId,
            status: execution.cliStatus,
            preflight: context.checks[arm === 'claude-code' ? 'claude' : 'codex'],
          }
        : undefined,
    agent: { status: execution.status, error: execution.error },
  };
  fs.writeFileSync(runtimeFile, JSON.stringify(runtime, null, 2), 'utf8');
  fs.writeFileSync(
    usageFile,
    JSON.stringify({ ...usage, qwen_round_usage: execution.qwenUsage }, null, 2),
    'utf8',
  );
  const output: BenchmarkRunResult = {
    arm,
    status,
    started_at: started.toISOString(),
    completed_at: completed.toISOString(),
    workspace: context.workspaces[arm],
    runtime_file: runtimeFile,
    patch_file: patchFile,
    usage_file: usageFile,
    runtime_ms: completed.getTime() - started.getTime(),
  };
  if (evaluator) {
    output.evaluator_file = path.join(evaluatorDir, 'stdout.log');
    output.evaluator = { resolved: evaluator.resolved === true, exit_code: evaluator.exitCode };
  }
  const error =
    execution.error ??
    (evaluator && !evaluatorSucceeded(evaluator)
      ? 'Official evaluator did not produce a resolved result.'
      : undefined);
  if (error) output.error = error;
  return output;
}

export async function executeBenchmark(context: PreflightContext): Promise<BenchmarkRunResult[]> {
  if (context.options.dryRun) return [];
  const results: BenchmarkRunResult[] = [];
  let forge: QwenServerHandle | undefined;
  let minimal: QwenServerHandle | undefined;
  let forgeEndpoint: string | undefined;
  const qwenModel = context.options.model;
  try {
    if (context.options.arms.includes('qwen-forge')) {
      process.stdout.write('forge-bench: loading Forge Qwen parameters\n');
      forge = await ensureForgeQwen({
        forgeConfigPath: context.options.forgeConfigPath,
        model: qwenModel,
      });
      forgeEndpoint = forge.endpoint;
      process.stdout.write(`forge-bench: running qwen-forge\n`);
      results.push(await runArm(context, 'qwen-forge', forge));
      process.stdout.write(`forge-bench: qwen-forge ${results.at(-1)!.status}\n`);
      await unloadForgeQwen(forge, context.options.forgeConfigPath);
      forge = undefined;
    }
    if (context.options.arms.includes('qwen-minimal')) {
      process.stdout.write('forge-bench: unloading Forge Qwen parameters\n');
      const armDir = path.join(context.runDir, 'qwen-minimal');
      fs.mkdirSync(armDir, { recursive: true });
      minimal = await startMinimalQwen(
        {
          forgeConfigPath: context.options.forgeConfigPath,
          model: qwenModel,
          onStdout: (text) => append(path.join(armDir, 'server.stdout.log'), text),
          onStderr: (text) => append(path.join(armDir, 'server.stderr.log'), text),
        },
        forgeEndpoint ?? context.options.baseUrl,
      );
      process.stdout.write('forge-bench: running qwen-minimal\n');
      results.push(await runArm(context, 'qwen-minimal', minimal));
      process.stdout.write(`forge-bench: qwen-minimal ${results.at(-1)!.status}\n`);
    }
  } finally {
    if (minimal) await stopMinimalQwen(minimal);
    if (forge) await unloadForgeQwen(forge, context.options.forgeConfigPath);
  }
  const nonQwenArms = context.options.arms.filter(
    (arm) => arm !== 'qwen-forge' && arm !== 'qwen-minimal',
  );
  for (const arm of nonQwenArms) {
    process.stdout.write(`forge-bench: running ${arm}\n`);
    results.push(await runArm(context, arm));
    process.stdout.write(`forge-bench: ${arm} ${results.at(-1)!.status}\n`);
  }
  return results;
}

export function writeReports(
  context: PreflightContext,
  results: readonly BenchmarkRunResult[],
): void {
  const report = buildSmokeReport({ runId: context.runId, task: context.task, results });
  fs.writeFileSync(
    path.join(context.runDir, 'report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.join(context.runDir, 'report.md'),
    renderSmokeReport(results, context.task),
    'utf8',
  );
}
