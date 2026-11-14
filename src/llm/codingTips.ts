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
 *    it, and an agent must not: it is the vendor's list);
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

/** The shipped table is the vendor's: it gets room for the whole list. */
export const SHIPPED_TIPS_ALLOWANCE = 16_000;
/** The project table grows one line per recorded mistake, so it is capped on its own. */
export const PROJECT_TIPS_ALLOWANCE = 8_000;
export const PROJECT_TIPS_RELATIVE_PATH = 'docs/CODING_TIPS.md';

/**
 * The tag `config/templates/builtin/execute.njk` wraps this block in. Named here
 * because it is an interface between two files: the template renders it and
 * `test/unit/CodingTipsInjection.test.ts` asserts the template still does, so a
 * rename has to be done in both places or a test says so.
 */
export const CODING_TIPS_TAG = 'coding_tips';

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
): { text: string; truncated: boolean } | undefined {
  const raw = fs.readFileSync(file, 'utf8').trim();
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
  shippedPath = resolveShippedTipsPath(),
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

  const key = `${shippedPath ?? '-'}|${projectPath ?? '-'}`;
  const signature = signatureOf(watched);
  const seen = cache.get(key);
  if (seen && seen.signature === signature) return seen.block;

  const sources: CodingTipsSource[] = [];
  let duplicateSkipped = false;

  const shipped = shippedFile
    ? readBounded(shippedFile, SHIPPED_TIPS_ALLOWANCE, 'resources/tips/CODING_TIPS.md')
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
          ? `Shipped table (read-only, from the Forge install — record new mistakes in ${PROJECT_TIPS_RELATIVE_PATH} instead):`
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
