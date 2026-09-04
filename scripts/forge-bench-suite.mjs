#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function slug(value) {
  return value
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
}

function readSuite(filePath) {
  const suite = JSON.parse(readFileSync(filePath, 'utf8'));
  if (
    !suite ||
    typeof suite !== 'object' ||
    !Array.isArray(suite.tasks) ||
    suite.tasks.length < 2
  ) {
    throw new Error('Suite must be a JSON object with at least two tasks.');
  }
  if (suite.dataset !== 'princeton-nlp/SWE-bench_Verified' || suite.split !== 'test') {
    throw new Error('Only the official SWE-bench Verified test split is supported.');
  }
  const revision = typeof suite.revision === 'string' && suite.revision ? suite.revision : 'main';
  const timeout = suite.timeout_minutes;
  if (typeof timeout !== 'number' || timeout <= 0) {
    throw new Error('Suite timeout_minutes must be a positive number.');
  }
  const seen = new Set();
  const tasks = suite.tasks.map((task) => {
    if (!task || typeof task.instance_id !== 'string' || !task.instance_id) {
      throw new Error('Every suite task must provide an instance_id.');
    }
    if (seen.has(task.instance_id)) throw new Error(`Duplicate suite task: ${task.instance_id}`);
    seen.add(task.instance_id);
    return {
      instance_id: task.instance_id,
      dataset: suite.dataset,
      split: suite.split,
      revision,
      timeout_minutes: timeout,
      ...(typeof task.model === 'string' && task.model ? { model: task.model } : {}),
    };
  });
  return { name: typeof suite.name === 'string' ? suite.name : 'SWE-bench suite', tasks };
}

function latestReport(taskOutput) {
  if (!existsSync(taskOutput)) return undefined;
  const runs = readdirSync(taskOutput, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('smoke-'))
    .map((entry) => entry.name)
    .sort();
  const report = runs.at(-1);
  if (!report) return undefined;
  const reportPath = resolve(taskOutput, report, 'report.json');
  return existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined;
}

function renderReport(suite, runId, taskReports, arms) {
  const rows = taskReports.flatMap((entry) =>
    (entry.report?.results ?? []).map((result) => ({
      task: entry.task.instance_id,
      arm: result.arm,
      status: result.status,
      runtime: result.runtime_ms ? `${(result.runtime_ms / 1000).toFixed(1)}s` : '—',
    })),
  );
  const counts = arms.map((arm) => {
    const armRows = rows.filter((row) => row.arm === arm);
    return {
      arm,
      pass: armRows.filter((row) => row.status === 'PASS').length,
      total: armRows.length,
    };
  });
  const lines = [
    `# ${suite.name}`,
    '',
    `Run: \`${runId}\``,
    '',
    `> Local comparison across ${suite.tasks.length} official SWE-bench Verified test instances, arms: ${arms.join(', ')}. Not a published SWE-bench score.`,
    '',
    '| Task | Arm | Result | Runtime |',
    '| --- | --- | --- | ---: |',
    ...rows.map((row) => `| ${row.task} | ${row.arm} | ${row.status} | ${row.runtime} |`),
    '',
    '## Local summary',
    '',
    ...counts.map(
      (count) => `- ${count.arm}: ${count.pass}/${count.total} official evaluator PASS`,
    ),
    '',
    'Qwen arms use the same model, server facts, tool allowlist, and `reasoning_effort: low`; `qwen-forge` differs from `qwen-minimal` in prompt and loop ownership. `claude-code` and `codex` run the CLI agents unattended in their own workspaces.',
    '',
  ];
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: npm run bench:qwen-suite -- [--suite path] [--out path] [--arms a1,a2,...] [--limit N] [--model id] [--base-url url] [--evaluator swebench] [--forge-config path] [--unload-chat-node] [--resume run-dir] [--start-at N]',
    );
    return;
  }
  const suitePath = resolve(
    ROOT,
    value(args, '--suite') ?? 'benchmarks/swe-bench-verified-qwen-suite.json',
  );
  const outputRoot = resolve(ROOT, value(args, '--out') ?? 'results');
  const arms = (value(args, '--arms') ?? 'qwen-minimal,qwen-forge')
    .split(',')
    .map((arm) => arm.trim())
    .filter(Boolean);
  const limit = value(args, '--limit') ? Number(value(args, '--limit')) : undefined;
  const suite = readSuite(suitePath);
  if (Number.isInteger(limit) && limit > 0 && limit < suite.tasks.length) {
    suite.tasks = suite.tasks.slice(0, limit);
  }
  const resumeDir = value(args, '--resume');
  const startAtRaw = value(args, '--start-at');
  const startAt = startAtRaw === undefined ? undefined : Number(startAtRaw);
  if (startAt !== undefined && (!Number.isInteger(startAt) || startAt < 1)) {
    throw new Error('--start-at must be a positive 1-based task index.');
  }
  let runId;
  let runDir;
  if (resumeDir) {
    runDir = resolve(ROOT, resumeDir);
    if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
      throw new Error(`--resume dir not found: ${runDir}`);
    }
    runId = basename(runDir);
  } else {
    runId = `suite-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    runDir = resolve(outputRoot, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      resolve(runDir, 'suite.json'),
      JSON.stringify({ ...suite, source: suitePath }, null, 2),
    );
  }
  const taskReports = [];
  const forgeBench = resolve(ROOT, 'scripts', 'forge-bench.mjs');
  let skipped = 0;
  for (const [index, task] of suite.tasks.entries()) {
    const taskName = `${String(index + 1).padStart(2, '0')}-${slug(task.instance_id)}`;
    const taskDir = resolve(runDir, taskName);
    const existing = latestReport(taskDir);
    if (startAt !== undefined && index + 1 < startAt) {
      taskReports.push({ task, exit_code: undefined, report: existing, skipped: true });
      skipped++;
      continue;
    }
    if (resumeDir && existing) {
      taskReports.push({ task, exit_code: 0, report: existing, resumed: true });
      skipped++;
      console.log(`forge-bench-suite: skipping ${taskName} (report.json present)`);
      continue;
    }
    const taskManifest = resolve(runDir, `${taskName}.task.json`);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(taskManifest, JSON.stringify(task, null, 2));
    console.log(
      `forge-bench-suite: starting ${index + 1}/${suite.tasks.length} ${task.instance_id}`,
    );
    const childArgs = [
      forgeBench,
      '--task',
      taskManifest,
      '--arms',
      arms.join(','),
      '--out',
      taskDir,
      ...(value(args, '--model') ? ['--model', value(args, '--model')] : []),
      ...(value(args, '--base-url') ? ['--base-url', value(args, '--base-url')] : []),
      ...(value(args, '--evaluator') ? ['--evaluator', value(args, '--evaluator')] : []),
      ...(value(args, '--forge-config') ? ['--forge-config', value(args, '--forge-config')] : []),
      ...(args.includes('--unload-chat-node') ? ['--unload-chat-node'] : []),
    ];
    const result = spawnSync(process.execPath, childArgs, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    const report = latestReport(taskDir);
    taskReports.push({ task, exit_code: result.status, report });
    if (result.error)
      console.error(`forge-bench-suite: ${task.instance_id}: ${result.error.message}`);
  }
  const aggregate = { version: 1, run_id: runId, arms, suite, tasks: taskReports };
  writeFileSync(resolve(runDir, 'report.json'), JSON.stringify(aggregate, null, 2));
  writeFileSync(resolve(runDir, 'report.md'), renderReport(suite, runId, taskReports, arms));
  console.log(
    `forge-bench-suite: complete; ${skipped} skipped, ${taskReports.length - skipped} run; report ${runDir}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`forge-bench-suite: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
