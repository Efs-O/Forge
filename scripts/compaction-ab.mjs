/**
 * Compaction A/B: current summarizer request shape vs the proposed one.
 *
 * Both arms run back to back against the SAME loaded llama-server, on the SAME
 * transcript window, through Forge's real `selectCompactionSplit` and
 * `buildSummaryPrompt`. Only the request shape differs — which is the whole of
 * docs/plans/COMPACTION_SUMMARIZER_REQUEST_PLAN.md, so the plan can be judged on evidence
 * before it is implemented.
 *
 *   node scripts/compaction-ab.mjs --base-url http://127.0.0.1:8080 --runs 3
 *
 * Requires a model already loaded and serving. It spawns nothing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadForgeCompaction } from './compaction-ab-bridge.mjs';
import { groundTruth, scoreSummary, summarizeRuns, WRITE_TOOLS } from './compaction-ab-score.mjs';

const SESSIONS_DIR = path.join(os.homedir(), '.forge', 'sessions');

const SUMMARY_SYSTEM_PROMPT =
  'You compress a software-engineering conversation into a factual summary. ' +
  'Report only what the transcript states. Do not offer help, ask questions, or call tools.';

const FLAGS = { 'dry-run': 'dryRun', densest: 'densest' };
const VALUES = {
  'base-url': 'baseUrl',
  model: 'model',
  tokens: 'tokens',
  runs: 'runs',
  session: 'session',
  seed: 'seed',
  out: 'out',
  end: 'end',
  arms: 'arms',
  'arm-a-max-tokens': 'armAMaxTokens',
  'arm-b-output-tokens': 'armBOutputTokens',
  'reasoning-budget': 'reasoningBudget',
};

/**
 * Walk one token at a time. A fixed `i += 2` stride silently mis-pairs every
 * argument after a valueless flag — `--dry-run --tokens 40000 --out X` parsed
 * as (--dry-run, --tokens), (40000, --out) and dropped --out entirely.
 */
function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1:8080',
    model: 'local',
    tokens: 40000,
    runs: 3,
    session: null,
    seed: 42,
    armAMaxTokens: 16384,
    armBOutputTokens: 2048,
    reasoningBudget: 3072,
    out: path.join(process.cwd(), 'compaction-ab-results'),
    dryRun: false,
    densest: false,
    end: null,
    arms: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (FLAGS[key]) {
      args[FLAGS[key]] = true;
      continue;
    }
    const field = VALUES[key];
    if (!field) throw new Error(`Unknown option: ${token}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${token}`);
    args[field] = typeof args[field] === 'number' ? Number(value) : value;
  }
  return args;
}

/** Rebuild ChatMessage[] from a session JSONL, dropping the metadata rows. */
function loadSession(file) {
  const messages = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row.role || row.type === 'session_start') continue;
    const msg = { role: row.role, content: row.content ?? null };
    if (row.tool_calls) {
      // The log stores {name, input}; the summarizer reads the OpenAI shape.
      msg.tool_calls = row.tool_calls.map((c, i) => ({
        id: c.id ?? `call-${i}`,
        type: 'function',
        function: {
          name: c.name ?? c.function?.name,
          arguments:
            typeof c.input === 'string'
              ? c.input
              : JSON.stringify(c.input ?? c.function?.arguments ?? {}),
        },
      }));
    }
    if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
    messages.push(msg);
  }
  return messages;
}

function largestSession() {
  const files = fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(SESSIONS_DIR, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  if (!files.length) throw new Error(`No sessions found in ${SESSIONS_DIR}`);
  return files[0];
}

/**
 * Per-message token prefix sums. `estimateTokens` sums independently per
 * message, so a prefix sum over it is exact rather than an approximation.
 */
function prefixSums(messages, estimateTokens) {
  const tokens = [0];
  const writes = [0];
  for (let i = 0; i < messages.length; i++) {
    tokens.push(tokens[i] + estimateTokens([messages[i]]));
    const n = (messages[i].tool_calls ?? []).filter((c) =>
      WRITE_TOOLS.includes(c.function?.name),
    ).length;
    writes.push(writes[i] + n);
  }
  return { tokens, writes };
}

/** Largest window ending at `end` that fits the token target. */
function startFor(prefix, end, targetTokens) {
  let start = end;
  while (start > 0 && prefix.tokens[end] - prefix.tokens[start - 1] <= targetTokens) start -= 1;
  return start;
}

/**
 * Choose the window to summarize.
 *
 * The default tail is what compaction actually does, but a tail can happen to
 * contain almost no file writes — and then written-file recall has nothing to
 * measure. `--densest` instead picks the window carrying the most write calls,
 * which is where a lost fact is a real failure.
 */
function windowOf(messages, targetTokens, estimateTokens, { end, densest }) {
  const prefix = prefixSums(messages, estimateTokens);
  if (densest) {
    let best = { end: messages.length, start: 0, writes: -1 };
    for (let e = 1; e <= messages.length; e++) {
      const s = startFor(prefix, e, targetTokens);
      const writes = prefix.writes[e] - prefix.writes[s];
      if (writes > best.writes) best = { end: e, start: s, writes };
    }
    return messages.slice(best.start, best.end);
  }
  const e = end ?? messages.length;
  return messages.slice(startFor(prefix, e, targetTokens), e);
}

async function callServer({ baseUrl, model, messages, maxTokens, seed, disableThinking }) {
  const body = {
    model,
    messages,
    stream: false,
    max_tokens: maxTokens,
    seed,
    ...(disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };
  const started = Date.now();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - started;
  if (!res.ok) return { ms, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 400)}` };
  const json = await res.json();
  return {
    ms,
    summary: json.choices?.[0]?.message?.content ?? '',
    reasoning: json.choices?.[0]?.message?.reasoning_content ?? '',
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
    finishReason: json.choices?.[0]?.finish_reason,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const scratch = path.join(args.out, '.build');
  const forge = await loadForgeCompaction(scratch);

  const file = args.session
    ? fs.existsSync(args.session)
      ? args.session
      : path.join(SESSIONS_DIR, `${args.session}.jsonl`)
    : largestSession();
  const all = loadSession(file);
  const window = windowOf(all, args.tokens, forge.estimateTokens, {
    end: args.end === null ? null : Number(args.end),
    densest: args.densest,
  });
  const split = forge.selectCompactionSplit(window);
  if (!split) throw new Error('selectCompactionSplit returned null — window too small.');

  const prompt = forge.buildSummaryPrompt(undefined, split.summarize);
  const truth = groundTruth(split.summarize);

  // Arm A reproduces today's path: injectSystemPrompt with no TemplateEngine,
  // which yields the hardcoded agent persona. The live extension renders the
  // `execute` template plus FORGE.md, which is LARGER — so this is a
  // conservative approximation that favours arm A.
  const armAMessages = forge.injectSystemPrompt([{ role: 'user', content: prompt }]);
  const armBMessages = [
    { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  // 2x2 factorial. The first run compared A against B, which differ in BOTH
  // the system prompt and thinking — and B lost 20 points of write-recall. With
  // two variables moving at once that result attributes to nothing, so the two
  // mixed cells exist to separate persona from thinking.
  const cells = [
    { id: 'A-persona+think', system: armAMessages[0].content, think: true },
    { id: 'B-minimal-think', system: SUMMARY_SYSTEM_PROMPT, think: false },
    { id: 'C-minimal+think', system: SUMMARY_SYSTEM_PROMPT, think: true },
    { id: 'D-persona-think', system: armAMessages[0].content, think: false },
  ];
  const wanted = args.arms ? args.arms.split(',').map((a) => a.trim().toUpperCase()) : null;
  const arms = cells
    .filter((c) => !wanted || wanted.includes(c.id[0]))
    .map((c) => ({
      id: c.id,
      messages: [
        { role: 'system', content: c.system },
        { role: 'user', content: prompt },
      ],
      // Thinking arms need arm A's ceiling; the measured worst case was 3938
      // output tokens, so the proposed reserve+2048 would have truncated them.
      maxTokens: c.think ? args.armAMaxTokens : args.reasoningBudget + args.armBOutputTokens,
      disableThinking: !c.think,
    }));

  console.log(`session          ${path.basename(file)}`);
  console.log(`messages         ${all.length} total -> ${window.length} in window`);
  console.log(`window tokens    ~${forge.estimateTokens(window)} (target ${args.tokens})`);
  console.log(
    `split            summarize=${split.summarize.length} retainedVerbatim=${window.length - split.tailStart}`,
  );
  console.log(`prompt chars     ${prompt.length}`);
  console.log(
    `ground truth     written=${truth.written.length} topReferenced=${truth.topReferenced.length}`,
  );
  console.log(`  written        ${truth.written.slice(0, 8).join(', ') || '(none)'}`);
  console.log(`  topReferenced  ${truth.topReferenced.slice(0, 8).join(', ') || '(none)'}`);
  console.log(`arm A system     ${armAMessages[0].content.length} chars`);
  console.log(`arm B system     ${SUMMARY_SYSTEM_PROMPT.length} chars`);
  console.log('');
  // Everything above needs no model. Stop here to inspect the inputs before
  // spending a loaded slot on six generations.
  if (args.dryRun) {
    console.log('--dry-run: inputs only, no requests sent.');
    return;
  }

  fs.mkdirSync(args.out, { recursive: true });
  const results = {};

  for (const arm of arms) {
    const runs = [];
    for (let i = 0; i < args.runs; i++) {
      process.stdout.write(`${arm.id} run ${i + 1}/${args.runs} … `);
      const res = await callServer({
        baseUrl: args.baseUrl,
        model: args.model,
        messages: arm.messages,
        maxTokens: arm.maxTokens,
        // Same seed per run index across arms: the only difference is the shape.
        seed: args.seed + i,
        disableThinking: arm.disableThinking,
      });
      const score = res.summary ? scoreSummary(res.summary, truth) : null;
      runs.push({ ...res, score });
      console.log(
        res.error
          ? `ERROR ${res.error}`
          : `${res.ms}ms · ${res.completionTokens ?? '?'} out · ${res.summary.length} chars${res.summary.trim() ? '' : ' · EMPTY'}`,
      );
      if (res.summary) {
        fs.writeFileSync(path.join(args.out, `${arm.id}-run${i + 1}.md`), res.summary, 'utf8');
      }
    }
    results[arm.id] = {
      request: {
        maxTokens: arm.maxTokens,
        disableThinking: arm.disableThinking,
        systemPromptChars: arm.messages[0].content.length,
      },
      runs: runs.map(({ summary, reasoning, ...rest }) => rest),
      aggregate: summarizeRuns(runs.filter((r) => r.score)),
    };
  }

  const report = {
    session: path.basename(file),
    windowTokens: forge.estimateTokens(window),
    split: { summarize: split.summarize.length, retainedVerbatim: window.length - split.tailStart },
    groundTruth: { written: truth.written, topReferenced: truth.topReferenced },
    arms: results,
  };
  fs.writeFileSync(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('\n=== aggregate ===');
  for (const [id, data] of Object.entries(results)) {
    const a = data.aggregate;
    console.log(
      `${id.padEnd(12)} empty=${a.empty} err=${a.errors} ms=${Math.round(a.meanMs ?? 0)} out=${Math.round(a.meanCompletionTokens ?? 0)} ` +
        `writtenRecall=${a.meanWrittenRecall === null ? 'n/a' : a.meanWrittenRecall.toFixed(2)} ` +
        `topRecall=${a.meanTopRecall === null ? 'n/a' : a.meanTopRecall.toFixed(2)} ` +
        `invented=${(a.meanInvented ?? 0).toFixed(1)} leakedThink=${a.anyLeakedThinking}`,
    );
  }
  console.log(`\nsummaries + report.json -> ${args.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
