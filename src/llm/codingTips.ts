/**
 * Loading and budgeting for the coding-tips table.
 *
 * The table is the exact-syntax list that stops an agent re-making a mistake it
 * already paid for. Until now it reached the model only because this repository
 * pasted a copy into its own instruction file — so every other user's agent got
 * nothing, and this repo paid for the same text twice. Loading it here means no
 * model has to remember to open a file.
 *
 * Two sources, one block:
 *  - the SHIPPED table, read-only, inside the install folder (a user cannot edit
 *    it, and an agent must not: it is the vendor's list). In this repository the
 *    workspace's own `resources/tips/CODING_TIPS.md` replaces it, so an edit here
 *    is what the next turn reads; see `workspaceShippedTipsPath`;
 *  - the PROJECT table, `docs/CODING_TIPS.md`, which is where an agent records
 *    what it just learned. It is the write target, so it grows.
 *
 * Budgets are per source and deliberately NOT the instruction-chain budget: a
 * repository that fills its instruction file to the chain cap must not be able to
 * evict the tips, which is the failure the plan names. Each source is clamped on
 * its own and says so, so a long project table loses its own tail instead of
 * silently shrinking the shipped one.
 *
 * The shipped text is found relative to the running bundle, the same way
 * `src/documents/pdfRenderer.ts` finds its bundled `pdfjs` — `__dirname` is
 * `<extension>/dist` in a build and `<repo>/src/llm` under vitest, so both
 * candidates below resolve to a real `resources/tips/` without plumbing the
 * extension path through every prompt caller.
 */

import * as fs from 'fs';
import * as path from 'path';

import { clampUtf8 } from './forgeInstructionsChain';
import { PROJECT_TIPS_ALLOWANCE, SHIPPED_TIPS_ALLOWANCE } from './codingTipsBudget';
import { withoutReviewedMark } from './tipsReviewed';

// The budget lives in a leaf module so the pin schema can import it without
// reaching this file's instruction-chain dependency. Re-exported: the allowances
// are this module's documented surface, and its tests import them from here.
export { PROJECT_TIPS_ALLOWANCE, SHIPPED_TIPS_ALLOWANCE } from './codingTipsBudget';
export const PROJECT_TIPS_RELATIVE_PATH = 'docs/CODING_TIPS.md';

/**
 * The tag `config/templates/builtin/execute.njk` wraps this block in. Named here
 * because it is an interface between two files: the template renders it and
 * `test/unit/CodingTipsInjection.test.ts` asserts the template still does, so a
 * rename has to be done in both places or a test says so.
 */
export const CODING_TIPS_TAG = 'coding_tips';

/**
 * The shipped table's own intro names where a new tip belongs. Outside this
 * repository that answer is right, so the sentence stays. In this repository the
 * workspace file IS the shipped table, and the heading this module puts above it
 * already says "record a general tip here": the same paragraph then tells the
 * model the opposite, and the model obeyed the wrong one (2026-11-23 audit).
 * Only the injected copy drops the sentence, and only in that mode — the file on
 * disk keeps it for every other user. `test/unit/InstructionConflicts.test.ts`
 * pins both halves, so an edit to the intro fails CI instead of bringing the
 * contradiction back.
 */
export const SHIPPED_TIPS_RECORDING_SENTENCE =
  "Record in the project's `docs/CODING_TIPS.md`, never in the shipped table, which arrives read-only.";

const TRUNCATION_NOTICE = '\n[… truncated to fit the tips allowance for this file';

export interface CodingTipsSource {
  kind: 'shipped' | 'project';
  /** Path shown to the model: the install-relative name, not a machine path. */
  displayPath: string;
  text: string;
  truncated: boolean;
}

export interface CodingTipsBlock {
  text: string;
  sources: CodingTipsSource[];
  /** True when the project table is the shipped table, so only one was injected. */
  duplicateSkipped: boolean;
}

/** Where the shipped table lives, for both a packaged build and this repo's tests. */
export function shippedTipsCandidates(startDir = __dirname): string[] {
  return [
    // Packaged: dist/extension.js -> <extension>/resources/tips/.
    path.resolve(startDir, '..', 'resources', 'tips', 'CODING_TIPS.md'),
    // This repository under vitest: src/llm -> repo root.
    path.resolve(startDir, '..', '..', 'resources', 'tips', 'CODING_TIPS.md'),
  ];
}

export function resolveShippedTipsPath(startDir?: string): string | undefined {
  return shippedTipsCandidates(startDir).find((candidate) => fs.existsSync(candidate));
}

/**
 * The workspace's own shipped table, when the workspace IS Forge's source
 * (root package.json name "forge-llm"); undefined for every other workspace,
 * so a user repo that happens to have this path never replaces the vendor list.
 *
 * This is the live-read half of the split: an agent editing the shipped table in
 * this repository sees its own edit on the next turn instead of the installed
 * copy, which is the only version it can change.
 */
export function workspaceShippedTipsPath(workspaceRoot: string | undefined): string | undefined {
  if (!workspaceRoot) return undefined;
  const candidate = path.join(workspaceRoot, 'resources', 'tips', 'CODING_TIPS.md');
  if (!fs.existsSync(candidate)) return undefined;
  let name: unknown;
  try {
    name = (
      JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8')) as {
        name?: unknown;
      }
    ).name;
  } catch {
    // A missing or unparsable package.json classifies this workspace as "not
    // Forge's source", so the installed table stands: not an error swallowed.
    return undefined;
  }
  return name === 'forge-llm' ? candidate : undefined;
}

interface CacheEntry {
  signature: string;
  block: CodingTipsBlock | undefined;
}

const cache = new Map<string, CacheEntry>();

function signatureOf(entries: { path: string; label: string }[]): string {
  return entries
    .map((entry) => {
      try {
        const stat = fs.statSync(entry.path);
        return `${entry.path}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${entry.path}:absent`;
      }
    })
    .join('|');
}

/** The comparison that matters for "the same table twice": the table, not the prose above it. */
function tableOf(text: string): string {
  const at = text.indexOf('\n## ');
  return (at === -1 ? text : text.slice(at)).trim();
}

/** The notice is part of the budget: reserve its bytes before clamping the body. */
function readBounded(
  file: string,
  allowance: number,
  displayPath: string,
  drop?: string,
): { text: string; truncated: boolean } | undefined {
  const read = withoutReviewedMark(fs.readFileSync(file, 'utf8'));
  // A drop the file does not contain is left alone: the injection goes ahead, and
  // InstructionConflicts.test.ts is what notices the sentence moved.
  const raw = (drop ? read.replace(drop, '') : read).trim();
  if (!raw) return undefined;
  const clamped = clampUtf8(raw, allowance);
  if (!clamped.truncated) return { text: clamped.text, truncated: false };
  const notice = `${TRUNCATION_NOTICE}: ${displayPath}]`;
  const body = clampUtf8(raw, allowance - Buffer.byteLength(notice, 'utf8'));
  return { text: body.text + notice, truncated: true };
}

/**
 * Render the tips block, or undefined when there is no table to show.
 *
 * Memoised on (path, size, mtime) of both files: the block sits at the prompt
 * head, and a re-read that returned different bytes between rounds of one
 * conversation would cost a cold prefill for no reason.
 */
export function loadCodingTips(
  workspaceRoot?: string,
  shippedPath = workspaceShippedTipsPath(workspaceRoot) ?? resolveShippedTipsPath(),
): CodingTipsBlock | undefined {
  const projectPath = workspaceRoot
    ? path.join(workspaceRoot, PROJECT_TIPS_RELATIVE_PATH)
    : undefined;
  const watched = [
    ...(shippedPath ? [{ path: shippedPath, label: 'shipped' }] : []),
    ...(projectPath ? [{ path: projectPath, label: 'project' }] : []),
  ];
  if (!watched.length) return undefined;
  // A caller-named shipped file that does not exist is "no shipped table", not an
  // error: the project table alone still reaches the model.
  const shippedFile = shippedPath && fs.existsSync(shippedPath) ? shippedPath : undefined;

  // Which shipped file this is decides only the heading the model sees; a caller
  // that names the workspace file itself gets the same heading, correctly.
  const fromWorkspace = !!shippedFile && shippedFile === workspaceShippedTipsPath(workspaceRoot);

  const key = `${shippedPath ?? '-'}|${projectPath ?? '-'}`;
  const signature = signatureOf(watched);
  const seen = cache.get(key);
  if (seen && seen.signature === signature) return seen.block;

  const sources: CodingTipsSource[] = [];
  let duplicateSkipped = false;

  const shipped = shippedFile
    ? readBounded(
        shippedFile,
        SHIPPED_TIPS_ALLOWANCE,
        'resources/tips/CODING_TIPS.md',
        // Only the repository's own copy contradicts the heading above it, so only
        // that one loses the sentence.
        fromWorkspace ? ` ${SHIPPED_TIPS_RECORDING_SENTENCE}` : undefined,
      )
    : undefined;
  if (shipped) {
    sources.push({ kind: 'shipped', displayPath: 'resources/tips/CODING_TIPS.md', ...shipped });
  }

  if (projectPath && fs.existsSync(projectPath)) {
    let isDuplicate = false;
    if (shippedFile) {
      try {
        isDuplicate =
          !!shipped &&
          tableOf(fs.readFileSync(projectPath, 'utf8')) ===
            tableOf(fs.readFileSync(shippedFile, 'utf8'));
      } catch {
        isDuplicate = false;
      }
    }
    if (isDuplicate) {
      duplicateSkipped = true;
    } else {
      const project = readBounded(projectPath, PROJECT_TIPS_ALLOWANCE, PROJECT_TIPS_RELATIVE_PATH);
      if (project)
        sources.push({ kind: 'project', displayPath: PROJECT_TIPS_RELATIVE_PATH, ...project });
    }
  }

  let block: CodingTipsBlock | undefined;
  if (sources.length) {
    const parts = sources.map((source) => {
      const heading =
        source.kind === 'shipped'
          ? fromWorkspace
            ? `Shipped table (this repository's resources/tips/CODING_TIPS.md — record a general tip here, a repo or PC tip in ${PROJECT_TIPS_RELATIVE_PATH}):`
            : `Shipped table (read-only, from the Forge install — record new mistakes in ${PROJECT_TIPS_RELATIVE_PATH} instead):`
          : `Project table (${PROJECT_TIPS_RELATIVE_PATH}, this repository's own):`;
      return `${heading}\n${source.text}`;
    });
    if (duplicateSkipped) {
      parts.push(
        `(${PROJECT_TIPS_RELATIVE_PATH} holds the shipped table unchanged, so it was injected once.)`,
      );
    }
    block = { text: parts.join('\n\n'), sources, duplicateSkipped };
  }

  cache.set(key, { signature, block });
  return block;
}

/** Test hook: a fresh cache, so a temp-directory test cannot inherit a real one. */
export function clearCodingTipsCache(): void {
  cache.clear();
}
