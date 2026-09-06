#!/usr/bin/env node
// Read-only progress snapshot for a forge-bench-suite run directory.
// Reads per-arm runtime.json (written live per arm) — does not wait for the
// suite-level report.json which is only written at the very end.
// Usage: node scripts/bench-progress.mjs <run-dir>
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const runDir = resolve(process.argv[2] ?? 'results/suite-2026-09-04T00-39-35-430Z');
if (!existsSync(runDir)) {
  console.error(`run dir not found: ${runDir}`);
  process.exit(1);
}

const suite = JSON.parse(readFileSync(join(runDir, 'suite.json'), 'utf8'));
const tasks = suite.tasks;

function slug(value) {
  return value
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
}

function latestSmoke(taskDir) {
  if (!existsSync(taskDir)) return undefined;
  const runs = readdirSync(taskDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('smoke-'))
    .map((e) => e.name)
    .sort();
  return runs.at(-1);
}

function armStatuses(smokeDir) {
  if (!existsSync(smokeDir)) return [];
  return readdirSync(smokeDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const rf = join(smokeDir, e.name, 'runtime.json');
      let status = 'no-runtime';
      let resolved = undefined;
      if (existsSync(rf)) {
        try {
          const rt = JSON.parse(readFileSync(rf, 'utf8'));
          status = rt.status;
        } catch {
          status = 'bad-runtime';
        }
      }
      const evDir = join(smokeDir, e.name, 'evaluator');
      if (existsSync(evDir)) {
        for (const f of readdirSync(evDir)) {
          if (f.endsWith('.json') && f !== 'predictions.jsonl') {
            try {
              const j = JSON.parse(readFileSync(join(evDir, f), 'utf8'));
              if (typeof j.resolved === 'boolean') resolved = j.resolved;
            } catch {
              // partial diagnostics
            }
          }
        }
      }
      return { arm: e.name, status, resolved };
    });
}

const perArm = {};
const rows = [];
let completedTasks = 0;
let inFlight = undefined;

for (const [i, task] of tasks.entries()) {
  const name = `${String(i + 1).padStart(2, '0')}-${slug(task.instance_id)}`;
  const taskDir = join(runDir, name);
  const smoke = latestSmoke(taskDir);
  if (!smoke) {
    if (!inFlight) inFlight = name;
    continue;
  }
  const statuses = armStatuses(join(taskDir, smoke));
  if (statuses.length === 0) {
    if (!inFlight) inFlight = name;
    continue;
  }
  let taskComplete = true;
  for (const s of statuses) {
    perArm[s.arm] = perArm[s.arm] ?? { pass: 0, fail: 0, timeout: 0, error: 0, total: 0 };
    perArm[s.arm].total++;
    if (s.status === 'PASS') perArm[s.arm].pass++;
    else if (s.status === 'FAIL') perArm[s.arm].fail++;
    else if (s.status === 'TIMEOUT') perArm[s.arm].timeout++;
    else perArm[s.arm].error++;
    rows.push({ name, arm: s.arm, status: s.status });
    if (s.status !== 'PASS' && s.status !== 'FAIL' && s.status !== 'TIMEOUT') taskComplete = false;
  }
  if (taskComplete) completedTasks++;
  else if (!inFlight) inFlight = name;
}

console.log(`Run: ${basename(runDir)}`);
console.log(`Suite: ${suite.name}`);
console.log(`Tasks fully done (both arms scored): ${completedTasks}/${tasks.length}`);
console.log(`In flight: ${inFlight ?? 'none'}`);
console.log('');
console.log('Per-arm tallies (all arms run so far):');
for (const [arm, c] of Object.entries(perArm)) {
  console.log(
    `  ${arm}: ${c.pass} PASS / ${c.fail} FAIL / ${c.timeout} TIMEOUT / ${c.error} ERROR (of ${c.total})`,
  );
}
if (rows.length) {
  console.log('');
  console.log('Most recent results:');
  for (const r of rows.slice(-8)) console.log(`  ${r.name}  ${r.arm}  ${r.status}`);
}
