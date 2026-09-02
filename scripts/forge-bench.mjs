#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ALL_ARMS = ['qwen-minimal', 'qwen-forge', 'claude-code', 'codex'];

function value(args, flag) { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; }
function command(name, args = []) {
  try { return { ok: true, output: execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
function json(url) { return fetch(url, { signal: AbortSignal.timeout(3000) }).then(async r => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) })).catch(error => ({ ok: false, error: String(error) })); }

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const taskPath = resolve(value(args, '--task') ?? 'benchmarks/smoke-task.json');
  const outputRoot = resolve(value(args, '--out') ?? 'results');
  const selected = (value(args, '--arms') ?? ALL_ARMS.join(','))
    .split(',').map(v => v.trim()).filter(Boolean);
  const invalid = selected.filter(v => !ALL_ARMS.includes(v));
  if (invalid.length) throw new Error(`Unknown arm(s): ${invalid.join(', ')}`);
  if (!existsSync(taskPath)) throw new Error(`Task manifest not found: ${taskPath}. Copy benchmarks/smoke-task.example.json and pin a verified instance.`);
  const task = JSON.parse(readFileSync(taskPath, 'utf8'));
  for (const key of ['instance_id', 'dataset', 'split']) if (!task[key]) throw new Error(`Task manifest is missing ${key}`);
  const baseUrl = value(args, '--base-url') ?? process.env.FORGE_BENCH_BASE_URL ?? 'http://127.0.0.1:8080';
  const report = { version: 1, dry_run: dryRun, started_at: new Date().toISOString(), task, arms: selected, preflight: {} };
  report.preflight.git = command('git', ['--version']);
  report.preflight.docker = command('docker', ['--version']);
  if (selected.some(a => a.startsWith('qwen'))) {
    report.preflight.llama_server = await json(`${baseUrl}/v1/models`);
    report.preflight.llama_props = await json(`${baseUrl}/props`);
  }
  if (selected.includes('claude-code')) report.preflight.claude = command(process.platform === 'win32' ? 'where' : 'which', ['claude']);
  if (selected.includes('codex')) report.preflight.codex = command(process.platform === 'win32' ? 'where' : 'which', ['codex']);
  const failures = Object.entries(report.preflight).filter(([, v]) => !v.ok).map(([k]) => k);
  const runDir = resolve(outputRoot, `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(resolve(runDir, 'preflight.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) throw new Error(`Preflight failed: ${failures.join(', ')}. Report: ${resolve(runDir, 'preflight.json')}`);
  if (!dryRun) throw new Error('Execution arms are not wired yet; run with --dry-run while the executor implementation is in progress.');
  console.log(`Dry run passed. Report: ${resolve(runDir, 'preflight.json')}`);
}
main().catch(error => { console.error(`forge-bench: ${error.message}`); process.exitCode = 1; });
