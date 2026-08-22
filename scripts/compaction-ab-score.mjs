/**
 * Objective scoring for a compaction A/B.
 *
 * Reading two summaries side by side settles nothing. The transcript carries
 * its own ground truth: every file the agent actually touched is sitting in the
 * `tool_calls` arguments. So recall and hallucination are measurable, not a
 * matter of taste.
 */

/**
 * Argument keys across Forge's tools that carry a path.
 *
 * Derived from the tool schemas in `src/tools/`, not guessed: `edit_file` uses
 * `filepath` (one word, no underscore) while every other tool uses `path`, and
 * missing that spelling silently zeroed the write-recall metric on a session
 * with 106 edits in it.
 */
const PATH_KEYS = ['path', 'filepath', 'paths', 'allowed_paths', 'source', 'destination'];

/** Tools that MODIFY a file. Their targets are what a summary must not lose. */
export const WRITE_TOOLS = [
  'edit_file',
  'write_file',
  'apply_line_edits',
  'create_file',
  'delete_file',
];

const PATH_SHAPED = /[A-Za-z0-9_./\\-]*[A-Za-z0-9_-]\.[A-Za-z]{1,5}\b/g;

function collectStrings(value, out) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) collectStrings(v, out);
}

/** Normalize so `src\a.ts`, `./src/a.ts` and `src/a.ts` compare equal. */
export function normalizePath(raw) {
  return raw.replace(/\\/g, '/').replace(/^\.\//, '').trim().toLowerCase();
}

/** Just the basename, which is how a summary usually refers to a file. */
export function baseName(p) {
  const parts = normalizePath(p).split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Ground truth from the messages that were fed to the summarizer.
 *
 * `written` is the small, high-value set — losing one of these is a real
 * failure. `mentioned` is every path the transcript refers to at all, and is
 * used only to judge hallucination.
 */
export function groundTruth(messages) {
  const written = new Set();
  const mentioned = new Set();
  const frequency = new Map();

  for (const msg of messages) {
    for (const call of msg.tool_calls ?? []) {
      let args;
      try {
        args = JSON.parse(call.function?.arguments ?? call.arguments ?? '{}');
      } catch {
        continue;
      }
      const strings = [];
      for (const key of PATH_KEYS) if (args[key] !== undefined) collectStrings(args[key], strings);
      const name = call.function?.name ?? call.name;
      for (const raw of strings) {
        const p = normalizePath(raw);
        if (!p || !p.includes('.')) continue;
        mentioned.add(p);
        frequency.set(p, (frequency.get(p) ?? 0) + 1);
        if (WRITE_TOOLS.includes(name)) written.add(p);
      }
    }
    if (typeof msg.content === 'string') {
      for (const hit of msg.content.matchAll(PATH_SHAPED)) mentioned.add(normalizePath(hit[0]));
    }
  }

  const topReferenced = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p]) => p);

  return { written: [...written], mentioned, topReferenced };
}

/** Paths the summary claims, as basenames — summaries rarely repeat full paths. */
export function pathsIn(text) {
  const found = new Set();
  for (const hit of text.matchAll(PATH_SHAPED)) found.add(normalizePath(hit[0]));
  return [...found];
}

function recall(expected, claimedBases) {
  if (expected.length === 0) return null;
  const hit = expected.filter((p) => claimedBases.has(baseName(p)));
  return {
    hit: hit.length,
    total: expected.length,
    ratio: hit.length / expected.length,
    missed: expected.filter((p) => !claimedBases.has(baseName(p))),
  };
}

const LABELS = ['Goal', 'State', 'Next', 'Files', 'Constraints', 'Errors'];

export function scoreSummary(summary, truth) {
  const claimed = pathsIn(summary);
  const claimedBases = new Set(claimed.map(baseName));
  const truthBases = new Set([...truth.mentioned].map(baseName));
  // A path-shaped token the transcript never contained. The strongest signal
  // available for confabulation, and it needs no judgement call.
  const invented = claimed.filter((p) => !truthBases.has(baseName(p)));

  return {
    chars: summary.length,
    labelsPresent: LABELS.filter((l) =>
      new RegExp(`(^|\\n)\\s*\\*{0,2}${l}\\b`, 'i').test(summary),
    ),
    labelsMissing: LABELS.filter(
      (l) => !new RegExp(`(^|\\n)\\s*\\*{0,2}${l}\\b`, 'i').test(summary),
    ),
    writtenFileRecall: recall(truth.written, claimedBases),
    topReferencedRecall: recall(truth.topReferenced, claimedBases),
    inventedPaths: invented,
    leakedThinking: /<\/?think|<\|think\|>|<\|channel\|>/i.test(summary),
    refusalOrChat: /^(sure|certainly|of course|i'?ll |here'?s |how can i)/i.test(summary.trim()),
  };
}

export function summarizeRuns(runs) {
  const ok = runs.filter((r) => !r.error && r.summary);
  const mean = (pick) => (ok.length ? ok.reduce((s, r) => s + pick(r), 0) / ok.length : null);
  return {
    runs: runs.length,
    empty: runs.filter((r) => !r.error && !r.summary?.trim()).length,
    errors: runs.filter((r) => r.error).length,
    meanMs: mean((r) => r.ms),
    meanCompletionTokens: mean((r) => r.completionTokens ?? 0),
    meanChars: mean((r) => r.score.chars),
    meanWrittenRecall:
      ok.length && ok[0].score.writtenFileRecall
        ? mean((r) => r.score.writtenFileRecall?.ratio ?? 0)
        : null,
    meanTopRecall:
      ok.length && ok[0].score.topReferencedRecall
        ? mean((r) => r.score.topReferencedRecall?.ratio ?? 0)
        : null,
    meanInvented: mean((r) => r.score.inventedPaths.length),
    anyLeakedThinking: ok.some((r) => r.score.leakedThinking),
  };
}
