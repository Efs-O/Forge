#!/usr/bin/env node
/**
 * Endpoint-only Nemotron tool/coding smoke benchmark. It never owns a
 * llama-server lifecycle: start the configured profile separately, then pass
 * its URL and model id here. Tool schemas are loaded from Forge's benchmark
 * ToolRegistry, so this cannot silently drift to an ad-hoc schema.
 */
import { build } from 'esbuild';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_OUTPUT = resolve(ROOT, 'docs', 'benchmarks');
const GREEK_TOOL_SCENARIOS = resolve(ROOT, 'benchmarks', 'nemotron-greek-tool-calls.json');
const HARDWARE = '2x RTX 5060 Ti 16 GB (PCIe Gen3 x8) + RTX 3060 12 GB (x4); i7-8700K DDR4';

function value(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function usage() {
  return [
    'Usage: node scripts/nemotron-bench.mjs --base-url URL --model ID --greek-eval PATH --quant NAME [--gguf PATH] [--greek-no-system] [--greek-max-tokens N] [--determinism N] [--rows-out PATH] [--force-rows-out] [--out DIR]',
    '',
    'The server must already be running. This command never starts, stops, unloads, or downloads a model.',
  ].join('\n');
}

function options(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  const baseUrl = value(args, '--base-url')?.replace(/\/$/u, '');
  const model = value(args, '--model');
  if (!baseUrl || !/^https?:\/\//u.test(baseUrl)) throw new Error('--base-url must be an HTTP(S) URL.');
  if (!model) throw new Error('--model is required; refuse to guess a served model.');
  const quant = value(args, '--quant');
  if (!quant) throw new Error('--quant NAME is required.');
  const greekMaxTokens = Number(value(args, '--greek-max-tokens') ?? 512);
  if (!Number.isInteger(greekMaxTokens) || greekMaxTokens <= 0) throw new Error('--greek-max-tokens must be a positive integer.');
  const determinism = Number(value(args, '--determinism') ?? 0);
  if (!Number.isInteger(determinism) || determinism < 0) throw new Error('--determinism must be an integer greater than or equal to 0.');
  const output = resolve(ROOT, value(args, '--out') ?? DEFAULT_OUTPUT);
  const greekEvalValue = value(args, '--greek-eval');
  if (!greekEvalValue) throw new Error('--greek-eval PATH is required.\n' + usage());
  const greekEval = resolve(greekEvalValue);
  if (!existsSync(greekEval)) throw new Error(`Greek evaluation file not found: ${greekEval}`);
  const rowsOutValue = value(args, '--rows-out');
  const rowsOut = rowsOutValue ? resolve(rowsOutValue) : undefined;
  if (rowsOut) {
    const rel = relative(ROOT, rowsOut);
    if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) throw new Error('--rows-out must be outside the Forge repository root.');
    if (existsSync(rowsOut) && !args.includes('--force-rows-out')) throw new Error('--rows-out already exists; pass --force-rows-out to overwrite it.');
  }
  const gguf = value(args, '--gguf');
  if (gguf && !existsSync(resolve(gguf))) throw new Error(`GGUF file not found: ${resolve(gguf)}`);
  return { baseUrl, model, quant, output, greekEval, greekMaxTokens, determinism, rowsOut, forceRowsOut: args.includes('--force-rows-out'), greekNoSystem: args.includes('--greek-no-system'), gguf: gguf ? resolve(gguf) : undefined };
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function greekSystemInfo(rows, disabled) {
  const systems = [...new Set(rows.map((row) => row.system).filter((item) => typeof item === 'string' && item.length > 0))];
  if (systems.length > 1) throw new Error('Greek evaluation rows contain more than one distinct system prompt.');
  return { mode: disabled || systems.length === 0 ? 'none' : 'row', prompt: disabled ? undefined : systems[0], sha256: disabled || !systems[0] ? null : createHash('sha256').update(systems[0], 'utf8').digest('hex') };
}

function insideRoot(path) {
  const rel = relative(ROOT, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function loadForgeToolDefinitions() {
  const temp = mkdtempSync(resolve(tmpdir(), 'nemotron-bench-schema-'));
  const outfile = resolve(temp, 'tool-host.cjs');
  await build({
    entryPoints: [resolve(ROOT, 'src', 'benchmark', 'toolHost.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning',
  });
  const module = await import(pathToFileURL(outfile).href);
  const workspace = mkdtempSync(resolve(tmpdir(), 'nemotron-bench-workspace-'));
  const host = module.createBenchmarkToolHost(workspace);
  return { definitions: host.definitions(), workspace, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}

async function jsonRequest(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${url}; got ${text.slice(0, 500)}`);
  }
}

function requires(definition, args) {
  const parameters = definition.function.parameters;
  if (parameters.type !== 'object' || !Array.isArray(parameters.required)) return false;
  return parameters.required.every((key) => Object.hasOwn(args, key));
}

function callFor(response) {
  const call = response?.choices?.[0]?.message?.tool_calls?.[0];
  if (!call || call.type !== 'function' || typeof call.function?.name !== 'string') return undefined;
  try {
    return { name: call.function.name, args: JSON.parse(call.function.arguments ?? '{}') };
  } catch {
    return { name: call.function.name, args: undefined };
  }
}

function rate(tokens, milliseconds) {
  return typeof tokens === 'number' && typeof milliseconds === 'number' && milliseconds > 0
    ? Number((tokens / (milliseconds / 1000)).toFixed(2))
    : null;
}

function timing(response) {
  const timings = response?.timings ?? {};
  return {
    prompt_tokens: timings.prompt_n ?? response?.usage?.prompt_tokens ?? null,
    prompt_ms: timings.prompt_ms ?? null,
    prompt_tokens_per_s: rate(timings.prompt_n, timings.prompt_ms),
    generated_tokens: timings.predicted_n ?? response?.usage?.completion_tokens ?? null,
    generated_ms: timings.predicted_ms ?? null,
    generated_tokens_per_s: rate(timings.predicted_n, timings.predicted_ms),
  };
}

function scenario(id, expectedTool, prompt, codingCheck) {
  return { id, expectedTool, prompt, codingCheck };
}

function greekToolScenarios() {
  const entries = JSON.parse(readFileSync(GREEK_TOOL_SCENARIOS, 'utf8'));
  if (!Array.isArray(entries) || entries.length < 6 || entries.length > 10) {
    throw new Error('Greek tool-call fixture must contain 6–10 scenarios.');
  }
  return entries.map((entry) => scenario(
    entry.id,
    entry.expected_tool,
    entry.prompt,
    (args) => JSON.stringify(args) === JSON.stringify(entry.expected_args),
  ));
}

function greekRatio(text) {
  const letters = [...text].filter((char) => /\p{L}/u.test(char));
  return letters.length === 0 ? 0 : letters.filter((char) => /[\u0370-\u03ff\u1f00-\u1fff]/u.test(char)).length / letters.length;
}

function tokenF1(reference, answer) {
  const tokens = (text) => text.toLocaleLowerCase('el-GR').match(/[\p{L}\p{N}]+/gu) ?? [];
  const left = tokens(reference); const right = tokens(answer);
  const counts = new Map(left.map((token) => [token, (left.filter((item) => item === token).length)]));
  let overlap = 0;
  for (const token of right) {
    const remaining = counts.get(token) ?? 0;
    if (remaining > 0) { overlap += 1; counts.set(token, remaining - 1); }
  }
  return left.length + right.length === 0 ? 0 : (2 * overlap) / (left.length + right.length);
}

function charF1(reference, answer) {
  const grams = (text) => {
    const chars = [...text.toLocaleLowerCase('el-GR')].filter((char) => /[\p{L}\p{N}]/u.test(char));
    return chars.slice(0, -2).map((_, index) => chars.slice(index, index + 3).join(''));
  };
  const left = grams(reference); const right = grams(answer);
  const counts = new Map(left.map((gram) => [gram, (left.filter((item) => item === gram).length)]));
  let overlap = 0;
  for (const gram of right) { const remaining = counts.get(gram) ?? 0; if (remaining > 0) { overlap += 1; counts.set(gram, remaining - 1); } }
  return left.length + right.length === 0 ? 0 : (2 * overlap) / (left.length + right.length);
}

function greekEvaluation(file) {
  if (!existsSync(file)) throw new Error(`Greek evaluation set not found: ${file}`);
  const rows = readFileSync(file, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  if (rows.length === 0 || !rows.every((row) => typeof row.q === 'string' && typeof row.a === 'string')) {
    throw new Error('Greek evaluation rows must be non-empty JSONL objects with q and a strings.');
  }
  return rows;
}

function scenarios() {
  const strict = (tool, args) =>
    `Call only ${tool} with valid JSON. Use these exact arguments: ${JSON.stringify(args)}. Do not explain.`;
  return [
    scenario('tool-read-file', 'read_file', strict('read_file', { path: 'seed.txt' })),
    scenario('tool-find-files', 'find_files', strict('find_files', { pattern: '**/*.ts', max_results: 5 })),
    scenario('tool-search-code', 'search_code', strict('search_code', { query: 'needle', include: '**/*.ts' })),
    scenario('tool-write-file', 'write_file', strict('write_file', { path: 'out.txt', content: 'written\n' })),
    scenario('tool-append-file', 'append_file', strict('append_file', { path: 'seed.txt', content: 'append\n' })),
    scenario('tool-edit-file', 'edit_file', strict('edit_file', { path: 'seed.txt', old_text: 'seed', new_text: 'edited' })),
    scenario('tool-run-terminal', 'run_terminal', strict('run_terminal', { command: 'echo forge', timeout_seconds: 5 })),
    scenario('tool-run-tests', 'run_tests', strict('run_tests', { command: 'node --version', timeout_seconds: 5 })),
    scenario(
      'coding-write-module',
      'write_file',
      strict('write_file', { path: 'src/add.ts', content: 'export const add = (a: number, b: number) => a + b;\n' }),
      (args) => args.path === 'src/add.ts' && args.content === 'export const add = (a: number, b: number) => a + b;\n',
    ),
    scenario(
      'coding-append-readme',
      'append_file',
      strict('append_file', { path: 'README.md', content: 'Nemotron benchmark\n' }),
      (args) => args.path === 'README.md' && args.content === 'Nemotron benchmark\n',
    ),
    scenario(
      'coding-edit-constant',
      'edit_file',
      strict('edit_file', { path: 'seed.txt', old_text: 'seed', new_text: 'ready' }),
      (args) => args.path === 'seed.txt' && args.old_text === 'seed' && args.new_text === 'ready',
    ),
    scenario(
      'coding-run-test',
      'run_tests',
      strict('run_tests', { command: 'node -e "process.exit(0)"', timeout_seconds: 5 }),
      (args) => args.command === 'node -e "process.exit(0)"' && args.timeout_seconds === 5,
    ),
  ];
}

function atomicWrite(file, content) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, file);
}

function markdown(result) {
  const rows = result.scenarios
    .map((entry) => `| ${entry.id} | ${entry.expected_tool} | ${entry.actual_tool ?? 'none'} | ${entry.pass ? 'PASS' : 'FAIL'} | ${entry.timing.prompt_tokens_per_s ?? 'n/a'} | ${entry.timing.generated_tokens_per_s ?? 'n/a'} |`)
    .join('\n');
  return [
    '# Nemotron benchmark',
    '',
    `Date: ${result.date}`,
    `Hardware: ${HARDWARE}`,
    `Endpoint: ${result.base_url}`,
    `Model: ${result.model}`,
    `llama.cpp: ${result.llama_cpp_build ?? 'not reported by endpoint'}`,
    `Quant: ${result.quant} (GGUF SHA-256 ${result.gguf_sha256 ?? 'not supplied'})`,
    `Greek settings: max_tokens=${result.settings.greek_max_tokens}, temperature=${result.settings.greek_temperature}, top_k=${result.settings.greek_top_k}, seed=${result.settings.greek_seed}, cache_prompt=${result.settings.cache_prompt}; tool temperature=${result.settings.tool_temperature}, top_p=${result.settings.tool_top_p}`,
    `Greek system prompt: mode=${result.greek.system_prompt_mode}, SHA-256=${result.greek.system_prompt_sha256 ?? 'none'}`,
    `Determinism check: n=${result.determinism.n}, matched=${result.determinism.matched}`,
    `Context: ${result.context ?? 'not reported by endpoint'}`,
    '',
    `Tool-call success: ${result.tool_successes}/${result.scenarios.length} (${result.tool_success_rate}%). Coding checks: ${result.coding_successes}/4.`,
    '',
    '| Scenario | Expected tool | Actual tool | Result | Prompt tok/s | Generation tok/s |',
    '| --- | --- | --- | --- | ---: | ---: |',
    rows,
    '',
    '## Greek-language evaluation',
    '',
    `Held-out set: ${result.greek.evaluation_file} (${result.greek.examples} rows; SHA-256 ${result.greek.sha256}).`,
    'Quality is character 3-gram F1 and whitespace/token F1 against each held-out reference; language fidelity is the mean Greek-Unicode-letter share. Greek QA rows and model answers are deliberately not written into Forge artifacts.',
    '',
    '| Thinking | QA char-F1 | QA token-F1 | Greek-script share | Greek tools |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...result.greek.modes.map((mode) => `| ${mode.thinking ? 'on' : 'off'} | ${(mode.char_f1 * 100).toFixed(1)}% | ${(mode.token_f1 * 100).toFixed(1)}% | ${(mode.greek_script_share * 100).toFixed(1)}% | ${mode.tool_successes}/${mode.tool_total} |`),
    '',
    'Gemma 4 E4B reference: base 3/4 (75.0%), fine-tuned 3/4 (75.0%) from Gemma4GR `tests/benchmark_results`. Those were a four-question `must_contain` smoke run, not this validation-only F1 evaluation, so they are not directly comparable.',
    '',
    `Raw result: ${result.raw_file}`,
    '',
    'The benchmark validates tool name plus required JSON fields. It does not execute model-proposed terminal commands.',
    '',
  ].join('\n');
}

async function main() {
  const input = options(process.argv.slice(2));
  if (input.help) return console.log(usage());
  const greekRows = greekEvaluation(input.greekEval);
  if (input.determinism > greekRows.length) throw new Error(`--determinism (${input.determinism}) exceeds Greek evaluation row count (${greekRows.length}).`);
  const system = greekSystemInfo(greekRows, input.greekNoSystem);
  const greekHash = createHash('sha256').update(readFileSync(input.greekEval)).digest('hex');
  const ggufHash = input.gguf ? await sha256File(input.gguf) : null;
  const settings = { cache_prompt: false, greek_temperature: 0, greek_top_k: 1, greek_seed: 3407, greek_max_tokens: input.greekMaxTokens, tool_temperature: 0.6, tool_top_p: 0.95, tool_max_tokens: 512 };
  if (input.rowsOut && insideRoot(input.rowsOut)) throw new Error('--rows-out must be outside the Forge repository root.');
  if (input.rowsOut && existsSync(input.rowsOut) && !input.forceRowsOut) throw new Error('--rows-out already exists; pass --force-rows-out to overwrite it.');
  const { definitions, workspace, cleanup } = await loadForgeToolDefinitions();
  try {
    writeFileSync(resolve(workspace, 'seed.txt'), 'seed\n', 'utf8');
    writeFileSync(resolve(workspace, 'source.ts'), 'const needle = true;\n', 'utf8');
    writeFileSync(resolve(workspace, 'README.md'), '# Fixture\n', 'utf8');
    const props = await jsonRequest(`${input.baseUrl}/props`, {});
    const models = await jsonRequest(`${input.baseUrl}/v1/models`, {});
    const definitionsByName = new Map(definitions.map((definition) => [definition.function.name, definition]));
    let determinismMatched = 0;
    for (const row of greekRows.slice(0, input.determinism)) {
      const request = { model: input.model, messages: [...(system.prompt ? [{ role: 'system', content: system.prompt }] : []), { role: 'user', content: row.q }], temperature: 0, top_k: 1, seed: 3407, max_tokens: input.greekMaxTokens, cache_prompt: false, stream: false, chat_template_kwargs: { enable_thinking: false } };
      const a = await jsonRequest(`${input.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      const b = await jsonRequest(`${input.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      if ((a?.choices?.[0]?.message?.content ?? '') !== (b?.choices?.[0]?.message?.content ?? '')) throw new Error(`Determinism check failed for Greek row ${row.id ?? '(no id)'}; main benchmark was not started.`);
      determinismMatched += 1;
    }
    const results = [];
    const greekModes = [];
    const rowResults = [];
    for (const thinking of [false, true]) {
      const greekTools = [];
      for (const test of greekToolScenarios()) {
      const response = await jsonRequest(`${input.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          messages: [{ role: 'user', content: test.prompt }],
          cache_prompt: false,
          tools: definitions,
          tool_choice: 'required',
          temperature: 0.6,
          top_p: 0.95,
          max_tokens: 512,
          stream: false,
          chat_template_kwargs: { enable_thinking: thinking },
        }),
      });
      const call = callFor(response);
      const definition = call ? definitionsByName.get(call.name) : undefined;
      const valid = Boolean(call && definition && requires(definition, call.args));
      const correct = valid && call.name === test.expectedTool;
      const pass = Boolean(correct && (!test.codingCheck || test.codingCheck(call.args)));
      greekTools.push({
        id: test.id,
        expected_tool: test.expectedTool,
        actual_tool: call?.name,
        valid_required_args: valid,
        pass,
        timing: timing(response),
        response,
      });
      }
      const qa = [];
      const finishReasons = {};
      let emptyAnswers = 0;
      for (const row of greekRows) {
        const response = await jsonRequest(`${input.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: input.model, messages: [...(system.prompt ? [{ role: 'system', content: system.prompt }] : []), { role: 'user', content: row.q }], temperature: 0, top_k: 1, seed: 3407, max_tokens: input.greekMaxTokens, cache_prompt: false, stream: false, chat_template_kwargs: { enable_thinking: thinking } }) });
        const message = response?.choices?.[0]?.message ?? {};
        const answer = typeof message.content === 'string' ? message.content : '';
        const finishReason = response?.choices?.[0]?.finish_reason ?? null;
        if (answer.length === 0) emptyAnswers += 1;
        if (finishReason !== null) finishReasons[finishReason] = (finishReasons[finishReason] ?? 0) + 1;
        rowResults.push({ type: 'row', id: row.id, thinking, answer, reasoning_content: typeof message.reasoning_content === 'string' ? message.reasoning_content : '', finish_reason: finishReason, char_f1: charF1(row.a, answer), token_f1: tokenF1(row.a, answer), greek_share: greekRatio(answer), timing: timing(response) });
        qa.push({ char: charF1(row.a, answer), token: tokenF1(row.a, answer), greek: greekRatio(answer) });
      }
      greekModes.push({ thinking, char_f1: qa.reduce((sum, item) => sum + item.char, 0) / qa.length, token_f1: qa.reduce((sum, item) => sum + item.token, 0) / qa.length, greek_script_share: qa.reduce((sum, item) => sum + item.greek, 0) / qa.length, finish_reasons: finishReasons, empty_answers: emptyAnswers, tool_successes: greekTools.filter((entry) => entry.pass).length, tool_total: greekTools.length, tool_scenarios: greekTools });
    }
    for (const test of scenarios()) {
      const response = await jsonRequest(`${input.baseUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: input.model, messages: [{ role: 'user', content: test.prompt }], tools: definitions, tool_choice: 'required', temperature: 0.6, top_p: 0.95, max_tokens: 512, cache_prompt: false, stream: false, chat_template_kwargs: { enable_thinking: false } }) });
      const call = callFor(response); const definition = call ? definitionsByName.get(call.name) : undefined; const valid = Boolean(call && definition && requires(definition, call.args)); const correct = valid && call.name === test.expectedTool; results.push({ id: test.id, expected_tool: test.expectedTool, actual_tool: call?.name, valid_required_args: valid, pass: Boolean(correct && (!test.codingCheck || test.codingCheck(call.args))), timing: timing(response), response });
    }
    const toolSuccesses = results.filter((entry) => entry.pass).length;
    const coding = results.filter((entry) => entry.id.startsWith('coding-'));
    const date = new Date().toISOString();
    const rawName = `nemotron-raw-${date.replace(/[:.]/gu, '-')}.json`;
    const rawFile = resolve(input.output, rawName);
    const result = {
      date,
      base_url: input.baseUrl,
      model: input.model,
      hardware: HARDWARE,
      quant: input.quant,
      gguf_sha256: ggufHash,
      context: props?.default_generation_settings?.n_ctx ?? props?.n_ctx ?? null,
      llama_cpp_build: props?.build_info?.build ?? props?.build ?? null,
      server_props: props,
      served_models: models,
      tool_successes: toolSuccesses,
      tool_success_rate: Number(((toolSuccesses / results.length) * 100).toFixed(1)),
      coding_successes: coding.filter((entry) => entry.pass).length,
      scenarios: results,
      settings,
      determinism: { n: input.determinism, matched: determinismMatched },
      greek: { evaluation_file: input.greekEval, sha256: greekHash, examples: greekRows.length, system_prompt_mode: system.mode, system_prompt_sha256: system.sha256, modes: greekModes },
      raw_file: rawName,
    };
    if (!existsSync(input.output)) mkdirSync(input.output, { recursive: true });
    atomicWrite(rawFile, `${JSON.stringify(result, null, 2)}\n`);
    atomicWrite(resolve(input.output, 'nemotron.md'), markdown(result));
    if (input.rowsOut) {
      const header = { type: 'header', model: input.model, quant: input.quant, gguf_sha256: ggufHash, llama_cpp_build: result.llama_cpp_build, greek_eval_sha256: greekHash, settings, system_prompt_mode: system.mode, system_prompt_sha256: system.sha256, date };
      if (input.forceRowsOut && existsSync(input.rowsOut)) rmSync(input.rowsOut);
      atomicWrite(input.rowsOut, `${[header, ...rowResults].map((item) => JSON.stringify(item)).join('\n')}\n`);
    }
    console.log(`nemotron-bench: ${toolSuccesses}/${results.length} tool/coding scenarios passed; report=${resolve(input.output, 'nemotron.md')}`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    cleanup();
  }
}

main().catch((error) => {
  console.error(`nemotron-bench: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
