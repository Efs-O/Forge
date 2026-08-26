/**
 * Local llama-server A/B for loss-aware tool-result prompt reduction.
 * It starts no process: the selected server must already be loaded.
 */
import * as fs from 'fs';
import * as path from 'path';
import { build } from 'esbuild';
import { pathToFileURL } from 'url';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'tool-result-context-ab-results', '.build');
const entry = path.join(outDir, 'entry.mjs');
const bundle = path.join(outDir, 'tool-result-context.mjs');

async function loadCandidate() {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    entry,
    [
      `export { prepareToolResultContext } from '${path.join(root, 'src/agent/toolResultContext.ts').replaceAll('\\', '/')}';`,
    ].join('\n'),
  );
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'error' });
  return import(pathToFileURL(bundle).href);
}

async function request(baseUrl, messages) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local', messages, stream: false, max_tokens: 1,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text.slice(0, 500) };
  const json = JSON.parse(text);
  return { status: res.status, promptTokens: json.usage?.prompt_tokens, completionTokens: json.usage?.completion_tokens };
}

async function main() {
  const baseUrl = process.argv[2] ?? 'http://127.0.0.1:8080';
  const { prepareToolResultContext } = await loadCandidate();
  // Deliberately token-dense rather than repeated characters: a tokenizer
  // compresses `x`. This looks like a large compiler/test log and reliably
  // crosses this server's 62,208-token slot in the baseline arm.
  const filler = Array.from(
    { length: 5_000 },
    (_, i) =>
      `src/generated/module-${i.toString(36)}.ts:${(i % 700) + 1}: error TS${2000 + (i % 100)}: ` +
      `output fragment ${i.toString(36)}_${(i * 7919).toString(36)} does not satisfy the expected contract`,
  ).join('\n');
  const raw = [
    'START_FACT: API migration is complete; preserve the rollback command.',
    filler,
    'END_FACT: the final failing test is ContextBudgetToolFilter.test.ts.',
  ].join('\n');
  const messages = [
    { role: 'system', content: 'You are Forge. Use the evidence in this conversation.' },
    { role: 'user', content: 'Investigate the test failure without losing the earlier findings.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'large-result', type: 'function', function: { name: 'run_tests', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'large-result', name: 'run_tests', content: raw },
    { role: 'user', content: 'What should we do next?' },
  ];
  const model = { name: 'local', num_ctx: 62_208 };
  const candidate = prepareToolResultContext({ messages, toolTokens: 0, model });
  const baseline = await request(baseUrl, messages);
  const reduced = await request(baseUrl, candidate.messages);
  const report = {
    rawChars: raw.length,
    baseline,
    candidate: {
      ...reduced,
      estimatedInputTokens: candidate.used,
      inputBudget: candidate.inputBudget,
      fits: candidate.fits,
      excerptedToolCallIds: candidate.excerptedToolCallIds,
      preservesRawTranscript: messages[3].content === raw,
      preservesStartFact: String(candidate.messages[3].content).includes('START_FACT'),
      preservesEndFact: String(candidate.messages[3].content).includes('END_FACT'),
    },
  };
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(outDir), 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (baseline.status !== 400 || reduced.status !== 200 || !candidate.fits || !report.candidate.preservesRawTranscript || !report.candidate.preservesStartFact || !report.candidate.preservesEndFact) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
