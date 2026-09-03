#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

function renderReport(suite, runId, taskReports) {
  const rows = taskReports.flatMap((entry) =>
    (entry.report?.results ?? []).map((result) => ({
      task: entry.task.instance_id,
      arm: result.arm,
      status: result.status,
      runtime: result.runtime_ms ? `${(result.runtime_ms / 1000).toFixed(1)}s` : '—',
    })),
  );
  const counts = ['qwen-forge', 'qwen-minimal'].map((arm) => {
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
    '> This is a local calibration suite using five official SWE-bench Verified test instances. It is not a published SWE-bench score.',
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
    'The two Qwen arms use the same model, server facts, tool allowlist, and `reasoning_effort: low`; they differ in prompt and loop ownership.',
    '',
  ];
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: npm run bench:qwen-suite -- [--suite path] [--out path] [--model id] [--base-url url] [--evaluator swebench] [--forge-config path]',
    );
    return;
  }
  const suitePath = resolve(
    ROOT,
    value(args, '--suite') ?? 'benchmarks/swe-bench-verified-qwen-suite.json',
  );
  const outputRoot = resolve(ROOT, value(args, '--out') ?? 'results');
  const suite = readSuite(suitePath);
  const runId = `qwen-suite-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
  const runDir = resolve(outputRoot, runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    resolve(runDir, 'suite.json'),
    JSON.stringify({ ...suite, source: suitePath }, null, 2),
  );
  const taskReports = [];
  const forgeBench = resolve(ROOT, 'scripts', 'forge-bench.mjs');
  for (const [index, task] of suite.tasks.entries()) {
    const taskName = `${String(index + 1).padStart(2, '0')}-${slug(task.instance_id)}`;
    const taskDir = resolve(runDir, taskName);
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
      'qwen-minimal,qwen-forge',
      '--out',
      taskDir,
      ...(value(args, '--model') ? ['--model', value(args, '--model')] : []),
      ...(value(args, '--base-url') ? ['--base-url', value(args, '--base-url')] : []),
      ...(value(args, '--evaluator') ? ['--evaluator', value(args, '--evaluator')] : []),
      ...(value(args, '--forge-config') ? ['--forge-config', value(args, '--forge-config')] : []),
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
  const aggregate = { version: 1, run_id: runId, suite, tasks: taskReports };
  writeFileSync(resolve(runDir, 'report.json'), JSON.stringify(aggregate, null, 2));
  writeFileSync(resolve(runDir, 'report.md'), renderReport(suite, runId, taskReports));
  console.log(`forge-bench-suite: complete; report ${runDir}`);
}

try {
  main();
} catch (error) {
  console.error(`forge-bench-suite: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
