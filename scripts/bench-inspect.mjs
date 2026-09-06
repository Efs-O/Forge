#!/usr/bin/env node
// Inspect the latest smoke dir of each given task dir: list arm subdirs and
// whether runtime.json / patch.diff / evaluator exist, plus stderr tail.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const runDir = resolve(process.argv[2] ?? 'results/suite-2026-09-04T00-39-35-430Z');
const names = process.argv.slice(3);

function latestSmoke(taskDir) {
  if (!existsSync(taskDir)) return undefined;
  const runs = readdirSync(taskDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('smoke-'))
    .map((e) => e.name)
    .sort();
  return runs.at(-1);
}

function tail(file, n = 400) {
  try {
    const s = readFileSync(file, 'utf8');
    return s.slice(-n);
  } catch {
    return '(no file)';
  }
}

for (const name of names) {
  const taskDir = join(runDir, name);
  const smoke = latestSmoke(taskDir);
  console.log(`\n=== ${name} ===`);
  if (!smoke) {
    console.log('  (no smoke dir)');
    continue;
  }
  console.log(`  smoke: ${smoke}`);
  const sd = join(taskDir, smoke);
  const entries = readdirSync(sd, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      const armDir = join(sd, e.name);
      const has = (f) => existsSync(join(armDir, f));
      const rt = has('runtime.json')
        ? JSON.parse(readFileSync(join(armDir, 'runtime.json'), 'utf8')).status
        : 'no-runtime';
      console.log(
        `  [${e.name}] runtime=${rt} patch=${has('patch.diff')} evaluator=${has('evaluator')} events=${has('agent-events.jsonl')}`,
      );
      if (e.name === 'qwen-minimal') {
        if (has('server.stderr.log')) console.log(`    server.stderr: ${tail(join(armDir, 'server.stderr.log'), 300).trim()}`);
        if (has('stderr.log')) console.log(`    stderr: ${tail(join(armDir, 'stderr.log'), 300).trim()}`);
      }
    }
  }
}
