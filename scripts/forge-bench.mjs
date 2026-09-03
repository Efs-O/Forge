#!/usr/bin/env node
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(import.meta.dirname, '..');
const ALL_ARMS = ['qwen-minimal', 'qwen-forge', 'claude-code', 'codex'];

function exposeWindowsDockerCli() {
  if (process.platform !== 'win32') return;
  const candidates = [
    process.env.LOCALAPPDATA
      ? resolve(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin')
      : undefined,
    process.env.ProgramFiles
      ? resolve(process.env.ProgramFiles, 'Docker', 'Docker', 'resources', 'bin')
      : undefined,
    process.env.ProgramW6432
      ? resolve(process.env.ProgramW6432, 'Docker', 'Docker', 'resources', 'bin')
      : undefined,
  ].filter((candidate) => candidate && existsSync(resolve(candidate, 'docker.exe')));
  if (!candidates.length) return;
  const currentPath = process.env.PATH ?? process.env.Path ?? '';
  process.env.PATH = [candidates[0], currentPath].filter(Boolean).join(delimiter);
}

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

// The benchmark endpoint, resolved from the Forge config's `benchmark.base_url`.
// This is the last-resort default: it only matters when neither --base-url nor
// FORGE_BENCH_BASE_URL is set, and it must point at a dedicated llama-server
// port — never the live Forge chat node (llama_server.port).
function readBenchmarkBaseUrl(forgeConfigPath) {
  try {
    if (!existsSync(forgeConfigPath)) return undefined;
    const config = parseYaml(readFileSync(forgeConfigPath, 'utf8'));
    const base = config?.benchmark?.base_url;
    return typeof base === 'string' && base.trim() ? base.trim() : undefined;
  } catch {
    return undefined;
  }
}

function optionsFromArgs(args) {
  const ping = args.includes('--ping');
  const selected = (
    value(args, '--arms') ?? (ping ? 'qwen-minimal,qwen-forge' : ALL_ARMS.join(','))
  )
    .split(',')
    .map((arm) => arm.trim())
    .filter(Boolean);
  const invalid = selected.filter((arm) => !ALL_ARMS.includes(arm));
  if (invalid.length) throw new Error(`Unknown arm(s): ${invalid.join(', ')}`);
  if (!selected.length) throw new Error('At least one benchmark arm is required.');
  if (ping && args.includes('--dry-run'))
    throw new Error('--ping cannot be combined with --dry-run.');
  if (ping && selected.some((arm) => !arm.startsWith('qwen-')))
    throw new Error('--ping only supports qwen-minimal and qwen-forge.');
  const forgeConfigPath = resolve(ROOT, value(args, '--forge-config') ?? '.forge/config.yaml');
  const baseUrl =
    value(args, '--base-url') ??
    process.env.FORGE_BENCH_BASE_URL ??
    readBenchmarkBaseUrl(forgeConfigPath);
  if (!baseUrl)
    throw new Error(
      'No benchmark endpoint configured. Pass --base-url, set FORGE_BENCH_BASE_URL, ' +
        `or add benchmark.base_url to ${forgeConfigPath}. ` +
        'Refusing to default to the Forge chat port (llama_server.port) — a benchmark ' +
        'must never target the live chat node.',
    );
  return {
    ping,
    dryRun: args.includes('--dry-run'),
    taskPath: resolve(ROOT, value(args, '--task') ?? 'benchmarks/smoke-task.json'),
    outputRoot: resolve(ROOT, value(args, '--out') ?? 'results'),
    arms: selected,
    baseUrl,
    model: value(args, '--model') ?? process.env.FORGE_BENCH_MODEL,
    evaluatorExecutable:
      value(args, '--evaluator') ?? process.env.FORGE_BENCH_EVALUATOR ?? 'swebench',
    forgeConfigPath,
    unloadChatNode: args.includes('--unload-chat-node'),
  };
}

async function loadBenchmarkModule() {
  const temp = mkdtempSync(resolve(tmpdir(), 'forge-bench-'));
  const outfile = resolve(temp, 'entry.cjs');
  await build({
    entryPoints: [resolve(ROOT, 'src/benchmark/cli.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    plugins: [
      {
        name: 'benchmark-vscode-stub',
        setup(buildApi) {
          buildApi.onResolve({ filter: /^vscode$/ }, () => ({
            path: 'vscode-stub',
            namespace: 'benchmark',
          }));
          buildApi.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({
            contents: `export const window = { createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }) }; export const workspace = { getConfiguration: () => ({ get: () => undefined }) };`,
            loader: 'js',
          }));
        },
      },
    ],
    logLevel: 'warning',
  });
  const module = await import(pathToFileURL(outfile).href);
  return { module, temp };
}

async function main() {
  exposeWindowsDockerCli();
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: npm run bench:smoke -- [--dry-run] [--arms arm,...] [--task path] [--model id] [--base-url url] [--evaluator swebench]\n       npm run bench:ping -- [--arms qwen-minimal,qwen-forge] [--model id] [--base-url url]',
    );
    return;
  }
  const options = optionsFromArgs(args);
  const { module, temp } = await loadBenchmarkModule();
  try {
    if (options.ping) {
      await module.runPing(options);
    } else {
      await module.runBenchmark(options);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`forge-bench: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
