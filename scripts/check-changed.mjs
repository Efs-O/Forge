#!/usr/bin/env node
// Fast pre-commit gate for a small change: full type-check, ESLint on the
// changed files, and only the vitest files that import them. Anything the
// import graph cannot see (build config, prompt templates, test support,
// deletions, more than MAX_FILES code files) falls through to `npm run ci`.
//
//   npm run check:changed                      # files git reports as changed
//   npm run check:changed -- src/a.ts src/b.ts # only these (shared worktree)
//
// It does not replace `npm run ci` before a push, a tag, `npm run package`,
// or the end of a plan phase.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const MAX_FILES = 3;
const CODE = /\.(ts|tsx|mjs|js)$/;
const LINTED = /^(src|webview-ui)\/.*\.(ts|tsx)$/;
// Paths whose effect does not travel along imports.
const FULL_CI = [
  /^package(-lock)?\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /^\.eslintrc/,
  /^vitest\.config\./,
  /^esbuild\.config\./,
  /^config\//,
  /^scripts\//,
  /^test\/(support|fixtures)\//,
];

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
}

function run(label, command) {
  console.log(`\n== ${label}: ${command}`);
  const result = spawnSync(command, { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\ncheck:changed FAILED at ${label}`);
    process.exit(result.status ?? 1);
  }
}

const quote = (p) => `"${p}"`;
const explicit = process.argv.slice(2).map((p) => p.replace(/\\/g, '/'));
const files = explicit.length
  ? explicit
  : [...new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['ls-files', '--others', '--exclude-standard'])])];

fixStrayCrLf(files, explicit.length > 0);

if (!files.length) {
  console.log('check:changed: nothing changed.');
  process.exit(0);
}

const code = files.filter((f) => CODE.test(f));
const reasons = [];
for (const f of files) {
  if (!existsSync(f)) reasons.push(`${f} was deleted (imports cannot find its tests)`);
  else if (FULL_CI.some((re) => re.test(f))) reasons.push(`${f} does not reach its tests through imports`);
  else if (!CODE.test(f) && !f.endsWith('.md')) reasons.push(`${f} is not code or docs`);
}
if (code.length > MAX_FILES) reasons.push(`${code.length} code files changed (more than ${MAX_FILES})`);

console.log(`check:changed: ${files.length} file(s)\n  ${files.join('\n  ')}`);
if (reasons.length) {
  console.log(`\nFull CI required:\n  ${reasons.join('\n  ')}`);
  run('ci', 'npm run ci');
  process.exit(0);
}

run('type-check', 'npm run type-check');
const lint = code.filter((f) => LINTED.test(f));
if (lint.length) run('lint', `npx eslint ${lint.map(quote).join(' ')}`);
// Plan docs are read by a contract test that no import leads to.
const tests = [...code];
if (files.some((f) => f.startsWith('docs/plans/'))) tests.push('test/unit/PlanLedgerContract.test.ts');
if (tests.length) run('tests', `npx vitest related --run --passWithNoTests ${tests.map(quote).join(' ')}`);
console.log('\ncheck:changed passed. Run `npm run ci` before a push, tag or package.');

function fixStrayCrLf(files, namedOnCommandLine) {
  const existing = files.filter((file) => existsSync(file));
  if (!existing.length) return;

  const output = execFileSync('git', ['check-attr', '-z', 'eol', 'text', '--', ...existing], {
    encoding: 'buffer',
  });
  const fields = output.toString('utf8').split('\0');
  const attrs = new Map();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const file = fields[i];
    const name = fields[i + 1];
    const value = fields[i + 2];
    if (!attrs.has(file)) attrs.set(file, {});
    attrs.get(file)[name] = value;
  }

  for (const file of existing) {
    const values = attrs.get(file);
    if (values?.eol !== 'lf' || values.text === 'unset') continue;
    const bytes = readFileSync(file);
    let crlfCount = 0;
    for (let i = 0; i + 1 < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10) crlfCount++;
    }
    if (!crlfCount) continue;

    if (!namedOnCommandLine) {
      console.log(`check:changed: ${file} has CRLF; run \`npm run check:changed -- ${file}\` to fix it.`);
      continue;
    }

    const fixed = Buffer.allocUnsafe(bytes.length - crlfCount);
    let target = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
      fixed[target++] = bytes[i];
    }
    writeFileSync(file, fixed);
    console.log(`check:changed: fixed CRLF line endings in ${file}`);
  }
}
