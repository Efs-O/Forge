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
const STARTER = 'resources/instructions/FORGE.starter.md';
const TIPS = 'docs/CODING_TIPS.md';
const SHIPPED = 'resources/tips/CODING_TIPS.md';
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

/** The starter project file copied into new workspaces. */
function starterContent(): string {
  return read(STARTER);
}

/** FORGE.md as the prompt sees it; the split on MARK is harmless now that the copy is gone. */
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
const shipped = claims(read(SHIPPED));
const project = projectProse();
const projectClaims = project ? claims(project) : [];

// Every pairing that can reach one prompt at the same time.
const coInjected: [string, string[], string, string[]][] = [
  [PROMPT, prompt, STARTER, starter],
  [PROMPT, prompt, TIPS, tips],
  [STARTER, starter, TIPS, tips],
  [PROMPT, prompt, SHIPPED, shipped],
  [STARTER, starter, SHIPPED, shipped],
  [SHIPPED, shipped, TIPS, tips],
];
if (project !== undefined) {
  coInjected.push([PROMPT, prompt, PROJECT, projectClaims]);
  coInjected.push([TIPS, tips, PROJECT, projectClaims]);
  coInjected.push([SHIPPED, shipped, PROJECT, projectClaims]);
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
    for (const [name, rows] of [
      [TIPS, tips],
      [SHIPPED, shipped],
    ] as const) {
      for (let i = 0; i < rows.length; i++) {
        for (const { score, a, b } of worstPairs([rows[i]], rows.slice(i + 1), TIPS_INTERNAL_GATE)) {
          offenders.push(
            `${score.toFixed(2)} ${name}\n  A: ${a.slice(0, 110)}\n  B: ${b.slice(0, 110)}`,
          );
        }
      }
    }
    expect(
      offenders,
      `two tips rows over ${TIPS_INTERNAL_GATE} mean one line should be sharpened, not added`,
    ).toEqual([]);
  });
});

describe('FORGE.md carries no second copy of the tips table', () => {
  // The table used to be hand-copied into FORGE.md so an agent that forgot to read the
  // file still saw the rules. `codingTips.ts` now injects it — own allowance, pinned per
  // conversation — so the copy became a second home for the same text: a student chat
  // counted two identical RUN-3 lines in one prompt, about 12 KB a turn. This guard now
  // keeps it out rather than keeping the copy honest.
  it('holds neither the markers nor the table itself', () => {
    const forge = path.join(root, PROJECT);
    if (!fs.existsSync(forge)) return; // gitignored, skipped on a fresh clone.
    const forgeText = read(PROJECT);
    expect(forgeText, 'the marked copy is back; the code already injects the table').not.toContain(
      MARK,
    );
    expect(forgeText, 'an orphan TIPS-INJECT-END was left behind').not.toContain(
      'TIPS-INJECT-END',
    );
    const header = read(TIPS).split(/\r?\n/)[0];
    expect(forgeText, 'the tips table was pasted in without markers').not.toContain(header);
  });
});
