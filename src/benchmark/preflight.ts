import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BenchmarkArm, BenchmarkTask } from './contracts';
import { commandSucceeded, runProcess, type ProcessResult } from './process';
import {
  bootstrapWorkspace,
  fetchSweTask,
  publicTaskRecord,
  type SweTaskRecord,
  readManifest,
} from './task';
import { inferCliAgentName } from '../agents/types';
import { resolveCliExecutable } from '../agents/resolveCliExecutable';
import { BENCHMARK_TOOL_NAMES } from './toolHost';

export interface BenchmarkOptions {
  dryRun: boolean;
  taskPath: string;
  outputRoot: string;
  arms: BenchmarkArm[];
  baseUrl: string;
  model?: string;
  evaluatorExecutable: string;
  forgeConfigPath: string;
}

export interface PreflightContext {
  options: BenchmarkOptions;
  task: BenchmarkTask;
  record: SweTaskRecord;
  runId: string;
  runDir: string;
  model: string;
  llamaModels: unknown;
  llamaProps: unknown;
  cliExecutables: Partial<Record<'claude' | 'codex', string>>;
  evaluatorExecutable: string;
  workspaces: Record<BenchmarkArm, string>;
  checks: Record<string, unknown>;
}

function cliFromConfig(configPath: string, wanted: 'claude' | 'codex'): string | undefined {
  if (!fs.existsSync(configPath)) return undefined;
  try {
    const config = parseYaml(fs.readFileSync(configPath, 'utf8')) as {
      models?: Array<{ provider?: string; cli?: string }>;
    };
    const found = config.models?.find(
      (model) =>
        model.provider === 'cli' &&
        typeof model.cli === 'string' &&
        inferCliAgentName(model.cli) === wanted,
    );
    return found?.cli;
  } catch {
    return undefined;
  }
}

async function probeJson(
  url: string,
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json().catch(() => undefined);
    return {
      ok: response.ok,
      status: response.status,
      body,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    return { ok: false, status: 0, body: undefined, error: String(error) };
  }
}

function modelId(models: unknown, requested: string | undefined, manifestModel?: string): string {
  const entries =
    models && typeof models === 'object' && Array.isArray((models as { data?: unknown }).data)
      ? (models as { data: Array<{ id?: unknown }> }).data
      : [];
  const available = entries
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string');
  const chosen = requested ?? manifestModel ?? (available.length === 1 ? available[0] : undefined);
  if (!chosen)
    throw new Error(
      `Multiple or no llama-server models are available; pass --model (available: ${available.join(', ') || 'none'}).`,
    );
  if (available.length > 0 && !available.includes(chosen))
    throw new Error(
      `Model ${chosen} is not served by llama-server (available: ${available.join(', ')}).`,
    );
  return chosen;
}

export interface QwenEndpointFacts {
  baseUrl: string;
  model: string;
  models: unknown;
  props: unknown;
  modelsCheck: { ok: boolean; status: number; body: unknown; error?: string };
  propsCheck: { ok: boolean; status: number; body: unknown; error?: string };
}

export function normalizeLlamaBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/gu, '');
  return trimmed.replace(/\/v1$/iu, '');
}

export async function inspectQwenEndpoint(
  baseUrl: string,
  requestedModel?: string,
): Promise<QwenEndpointFacts> {
  const root = normalizeLlamaBaseUrl(baseUrl);
  const models = await probeJson(`${root}/v1/models`);
  const props = await probeJson(`${root}/props`);
  if (!models.ok || !props.ok) throw new Error(`llama-server preflight failed at ${baseUrl}.`);
  return {
    baseUrl: root,
    model: modelId(models.body, requestedModel),
    models: models.body,
    props: props.body,
    modelsCheck: models,
    propsCheck: props,
  };
}

async function inspectQwenControlServer(configPath: string): Promise<{
  health: Awaited<ReturnType<typeof probeJson>>;
  models: Awaited<ReturnType<typeof probeJson>>;
}> {
  if (!fs.existsSync(configPath))
    throw new Error(`Forge config not found for Qwen lifecycle control: ${configPath}`);
  const config = parseYaml(fs.readFileSync(configPath, 'utf8')) as {
    control_server?: { port?: number };
  };
  const port = config.control_server?.port;
  if (!port) throw new Error('Forge control_server.port is required for Qwen lifecycle control.');
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    health: await probeJson(`${baseUrl}/healthz`),
    models: await probeJson(`${baseUrl}/models`),
  };
}

async function executableCheck(
  executable: string,
  cli: 'claude' | 'codex',
): Promise<{ ok: boolean; executable: string; version: string; auth: string; error?: string }> {
  const version = await runCliCommand(executable, ['--version']);
  const authArgs = cli === 'claude' ? ['auth', 'status'] : ['login', 'status'];
  const auth = await runCliCommand(executable, authArgs);
  return {
    ok: commandSucceeded(version) && commandSucceeded(auth),
    executable,
    version: version.stdout.trim() || version.stderr.trim(),
    auth: auth.stdout.trim() || auth.stderr.trim(),
    ...(commandSucceeded(version) && commandSucceeded(auth)
      ? {}
      : {
          error:
            `${version.stderr || auth.stderr || 'CLI is not installed or authenticated.'}`.trim(),
        }),
  };
}

function quoteCmd(value: string): string {
  return `"${value.replace(/"/gu, '\\"')}"`;
}

function runCliCommand(executable: string, args: readonly string[]): Promise<ProcessResult> {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/iu.test(executable))
    return runProcess(executable, args, { timeoutMs: 30_000 });
  return runProcess(
    'cmd.exe',
    ['/d', '/s', '/c', [quoteCmd(executable), ...args.map(quoteCmd)].join(' ')],
    { timeoutMs: 30_000 },
  );
}

export async function preparePreflight(options: BenchmarkOptions): Promise<PreflightContext> {
  const task = readManifest(options.taskPath);
  const record = await fetchSweTask(task);
  const runId = `smoke-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const runDir = path.resolve(options.outputRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const checks: Record<string, unknown> = {};
  const git = await runProcess('git', ['--version'], { timeoutMs: 30_000 });
  checks.git = { ok: commandSucceeded(git), output: git.stdout.trim() || git.stderr.trim() };
  const docker = await runProcess('docker', ['--version'], { timeoutMs: 30_000 });
  checks.docker = {
    ok: commandSucceeded(docker),
    output: docker.stdout.trim() || docker.stderr.trim(),
  };
  if (!commandSucceeded(git)) throw new Error('Git is required for isolated SWE workspaces.');
  if (!commandSucceeded(docker))
    throw new Error('Docker is required for the official SWE evaluator.');
  let evaluatorExecutable: string;
  try {
    evaluatorExecutable = await resolveCliExecutable(options.evaluatorExecutable, 'claude');
  } catch {
    throw new Error(
      `Official SWE-bench evaluator was not found at ${options.evaluatorExecutable}; install the official swebench package or pass --evaluator.`,
    );
  }
  // The current official SWE-bench CLI exposes commands/help but not a
  // --version option. Use its stable top-level help probe for availability.
  const evaluator = await runCliCommand(evaluatorExecutable, ['--help']);
  checks.evaluator = {
    executable: evaluatorExecutable,
    ok: commandSucceeded(evaluator),
    output: evaluator.stdout.trim() || evaluator.stderr.trim(),
  };
  if (!commandSucceeded(evaluator))
    throw new Error(
      `Official SWE-bench evaluator was not found at ${evaluatorExecutable}; install the official swebench package or pass --evaluator.`,
    );

  let llamaModels: unknown = undefined;
  let llamaProps: unknown = undefined;
  let model = options.model ?? task.model ?? '';
  let effectiveBaseUrl = options.baseUrl;
  if (options.arms.some((arm) => arm.startsWith('qwen'))) {
    try {
      const facts = await inspectQwenEndpoint(options.baseUrl, model || undefined);
      checks.llama_models = facts.modelsCheck;
      checks.llama_props = facts.propsCheck;
      llamaModels = facts.models;
      llamaProps = facts.props;
      model = facts.model;
      effectiveBaseUrl = facts.baseUrl;
    } catch (error) {
      const control = await inspectQwenControlServer(options.forgeConfigPath);
      checks.llama_control = control;
      if (!control.health.ok || !control.models.ok)
        throw new Error(
          `llama-server is unavailable at ${options.baseUrl}, and Forge control server preflight failed: ${String(error)}`,
        );
      checks.llama_server_deferred = { reason: 'runner will load Forge and minimal phases' };
    }
  }

  const cliExecutables: Partial<Record<'claude' | 'codex', string>> = {};
  for (const cli of ['claude', 'codex'] as const) {
    if (!options.arms.includes(cli === 'claude' ? 'claude-code' : 'codex')) continue;
    const configured = cliFromConfig(options.forgeConfigPath, cli) ?? cli;
    const executable = await resolveCliExecutable(configured, cli);
    const check = await executableCheck(executable, cli);
    checks[cli] = check;
    if (!check.ok)
      throw new Error(`${cli} preflight failed: ${check.error ?? 'not authenticated'}`);
    cliExecutables[cli] = executable;
  }

  const workspaces = {} as Record<BenchmarkArm, string>;
  for (const arm of options.arms) {
    const armDir = path.join(runDir, arm);
    const workspace = path.join(armDir, 'workspace');
    fs.mkdirSync(armDir, { recursive: true });
    const prepared = await bootstrapWorkspace(record, workspace);
    workspaces[arm] = workspace;
    fs.writeFileSync(
      path.join(armDir, 'manifest.json'),
      JSON.stringify(
        {
          version: 1,
          arm,
          task: publicTaskRecord(record),
          dataset: task.dataset,
          split: task.split,
          revision: task.revision,
          timeout_minutes: task.timeout_minutes,
          base_url: options.baseUrl,
          model: model || undefined,
          tool_allowlist: BENCHMARK_TOOL_NAMES,
          prepared_head: prepared.head,
        },
        null,
        2,
      ),
      'utf8',
    );
  }
  const preflight = {
    version: 1,
    dry_run: options.dryRun,
    task: publicTaskRecord(record),
    dataset: task.dataset,
    split: task.split,
    revision: task.revision,
    checks,
    arms: options.arms,
    run_id: runId,
    run_dir: runDir,
  };
  fs.writeFileSync(path.join(runDir, 'preflight.json'), JSON.stringify(preflight, null, 2), 'utf8');
  return {
    options:
      effectiveBaseUrl === options.baseUrl ? options : { ...options, baseUrl: effectiveBaseUrl },
    task,
    record,
    runId,
    runDir,
    model,
    llamaModels,
    llamaProps,
    cliExecutables,
    evaluatorExecutable,
    workspaces,
    checks,
  };
}
