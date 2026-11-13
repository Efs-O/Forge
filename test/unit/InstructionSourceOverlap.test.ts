/**
 * Guard: one operational rule, one injected home.
 *
 * The instruction audit this repo ran on 2026-11-13 found the same rule written in
 * up to four places (the shipped prompt, the starter project file, the tips table,
 * the repository's own FORGE.md). Every copy after the first costs tokens on every
 * turn and gives the model a second, slightly different wording to reconcile — which
 * is how two of them ended up contradicting each other. Cleanup without a guard
 * decays, so this test is the guard.
 *
 * What it compares: only sources that can land in the same prompt. `STARTER_CONTENT`
 * is what auto-create writes when a repository has no FORGE.md, so a repo that HAS
 * one never injects both — comparing them would flag drift, not cost, and it is
 * skipped on purpose. FORGE.md's marked inline tips copy is excluded from the claim
 * scan for the same reason (it IS the tips table), and checked separately for
 * byte-exact equality instead, because a hand-mangled copy is what silently deleted
 * the tips preamble on 2026-11-13.
 *
 * Thresholds are measured, not chosen: with the tree as it stands the worst
 * co-injected pair scores 0.250 and the worst pair inside the tips table 0.273, so
 * the gates sit above both while still catching a rule copied with light rewording
 * (a paraphrase of one sentence scores 0.6+).
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const PROMPT = 'config/templates/builtin/execute.njk';
const STARTER = 'src/llm/ForgeInstructionsLoader.ts';
const TIPS = 'docs/CODING_TIPS.md';
const PROJECT = 'FORGE.md';

/** Above this, two claims are the same rule said twice. Worst real pair today: 0.250. */
const CROSS_SOURCE_GATE = 0.45;
/** Inside the tips table the bar is tighter: entries are short, so similarity is cheap. Worst today: 0.273. */
const TIPS_INTERNAL_GATE = 0.35;

const MARK = '## Coding tips — inline copy';

/** Lowercase, drop markup and punctuation: what survives is the claim. */
function normalize(text: string): string {
  return text
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/[-–—“”"'(){}[\]|,;:.!?/\\]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(' ')
      .filter((w) => w.length > 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** One claim per bullet or numbered tips entry; short enough lines carry no rule. */
function claims(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    const isBullet = line.startsWith('- ');
    const entry = /^\d+\.\s/.test(line);
    if (!isBullet && !entry) continue;
    const claim = entry ? line.replace(/^\d+\.\s+/, '') : line.slice(2);
    if (tokens(claim).size < 8) continue;
    out.push(claim);
  }
  return out;
}

/** The starter project file, which ships inside the loader as a template literal. */
function starterContent(): string {
  const source = read(STARTER);
  const open = source.indexOf('const STARTER_CONTENT = `');
  expect(open, 'the starter project text must stay a template literal this test can read').not.toBe(
    -1,
  );
  const from = open + 'const STARTER_CONTENT = `'.length;
  const close = source.indexOf('\n`;', from);
  expect(close, 'unterminated STARTER_CONTENT literal').toBeGreaterThan(from);
  return source.slice(from, close);
}

/** FORGE.md minus its inline tips copy: that copy is the tips table, not a second home. */
function projectProse(): string | undefined {
  const forge = path.join(root, PROJECT);
  if (!fs.existsSync(forge)) return undefined; // gitignored: absent on a fresh clone.
  return read(PROJECT).split(MARK)[0];
}

interface Pair {
  score: number;
  a: string;
  b: string;
}

function worstPairs(left: string[], right: string[], gate: number): Pair[] {
  const found: Pair[] = [];
  for (const a of left) {
    const ta = tokens(a);
    for (const b of right) {
      const score = jaccard(ta, tokens(b));
      if (score >= gate) found.push({ score, a, b });
    }
  }
  return found.sort((x, y) => y.score - x.score);
}

const prompt = claims(read(PROMPT));
const starter = claims(starterContent());
const tips = claims(read(TIPS));
const project = projectProse();
const projectClaims = project ? claims(project) : [];

// Every pairing that can reach one prompt at the same time.
const coInjected: [string, string[], string, string[]][] = [
  [PROMPT, prompt, STARTER, starter],
  [PROMPT, prompt, TIPS, tips],
  [STARTER, starter, TIPS, tips],
];
if (project !== undefined) {
  coInjected.push([PROMPT, prompt, PROJECT, projectClaims]);
  coInjected.push([TIPS, tips, PROJECT, projectClaims]);
  // STARTER_CONTENT is never injected: the loader writes it to FORGE.md when that file
  // is missing (`writeFileSync(..., flag: 'wx')`), so it IS the project file rather than
  // a second source. Comparing the two scores a file against its own seed.
}

describe('injected instruction sources do not say the same rule twice', () => {
  it('shares no word-for-word claim between sources that appear in one prompt', () => {
    const offenders: string[] = [];
    for (const [n1, c1, n2, c2] of coInjected) {
      const shared = new Set(c1.map((c) => normalize(c)));
      for (const c of c2) {
        const key = normalize(c);
        if (shared.has(key) && key.split(' ').length >= 6) {
          offenders.push(`${n1} == ${n2}: ${c.slice(0, 90)}`);
        }
      }
    }
    expect(offenders, 'a rule copied into a second injected home costs tokens every turn').toEqual(
      [],
    );
  });

  it('keeps every co-injected pair below the duplicate threshold', () => {
    const offenders: string[] = [];
    for (const [n1, c1, n2, c2] of coInjected) {
      for (const { score, a, b } of worstPairs(c1, c2, CROSS_SOURCE_GATE)) {
        offenders.push(
          `${score.toFixed(2)} ${n1} vs ${n2}\n  A: ${a.slice(0, 110)}\n  B: ${b.slice(0, 110)}`,
        );
      }
    }
    expect(
      offenders,
      `one rule, one home: over ${CROSS_SOURCE_GATE} is the same claim twice`,
    ).toEqual([]);
  });

  it('has no near-duplicate rows inside the tips table', () => {
    const offenders: string[] = [];
    for (let i = 0; i < tips.length; i++) {
      for (const { score, a, b } of worstPairs([tips[i]], tips.slice(i + 1), TIPS_INTERNAL_GATE)) {
        offenders.push(`${score.toFixed(2)}\n  A: ${a.slice(0, 110)}\n  B: ${b.slice(0, 110)}`);
      }
    }
    expect(
      offenders,
      `two tips rows over ${TIPS_INTERNAL_GATE} mean one line should be sharpened, not added`,
    ).toEqual([]);
  });
});

describe('the inline tips copy in FORGE.md stays the tips file', () => {
  it('holds the tips table byte for byte, or is absent', () => {
    const forge = path.join(root, PROJECT);
    if (!fs.existsSync(forge)) return; // gitignored, skipped on a fresh clone.
    const forgeText = read(PROJECT);
    const start = forgeText.indexOf(MARK);
    expect(start, 'FORGE.md must carry the marked tips copy').toBeGreaterThan(-1);
    const end = forgeText.indexOf('\nTIPS-INJECT-END', start);
    expect(end, 'the marked tips copy is not closed').toBeGreaterThan(start);
    const copied = forgeText.slice(forgeText.indexOf('\n\n', start) + 2, end);
    const tableOf = (text: string): string => {
      const at = text.indexOf('\n## ');
      expect(at, 'no section heading to compare').toBeGreaterThan(-1);
      return text.slice(at).trim();
    };
    expect(
      tableOf(copied),
      'the inline copy drifted from docs/CODING_TIPS.md: run scripts/lab-sync/sync_tips.py',
    ).toEqual(tableOf(read(TIPS)));
  });
});
