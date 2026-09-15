/**
 * Assembly and budgeting for a chain of project-instruction files.
 *
 * Split from `ForgeInstructionsLoader` on the dependency seam: everything here
 * is pure text and path arithmetic, so the precedence and budget rules can be
 * tested without a workspace, a watcher or a mocked `vscode`. The loader keeps
 * the filesystem, the caches and the warnings.
 *
 * One repository-wide `FORGE.md` had to carry rules for every package in a
 * monorepo, which is exactly the content a local 27B-class model can least
 * afford in its permanent prompt. A chain lets the repository-wide file stay
 * short while package-specific guidance appears only when work is in that part
 * of the tree.
 */

import * as path from 'path';

const AGENTS_MD = 'AGENTS.md';
export const FORGE_MD = 'FORGE.md';
export const INSTRUCTION_FILES = [FORGE_MD, AGENTS_MD] as const;

/**
 * Total rendered budget, delimiters and markers included.
 *
 * Previously this was a per-file cap, so a chain of four files could inject
 * four times as much as the guard advertised. Counting the rendered form is
 * what makes the number mean something — at the cost of the delimiters
 * themselves consuming a little of it.
 */
export const MAX_INSTRUCTION_BYTES = 25000;

/** Below this, a block is not worth a header; the file is marked omitted. */
const MIN_CONTENT_BYTES = 200;

/** Room held back so the omission notice can always be appended. */
const OMISSION_RESERVE = 300;

const TRUNCATION_MARKER = '\n[... truncated to fit the project-instruction budget ...]';

export interface ChainFile {
  /** Absolute path of the instruction file. */
  path: string;
  /** Path shown to the model, relative to the workspace root. */
  displayPath: string;
  /** Directory this file governs, relative to the chain root ('' for the root). */
  scope: string;
  /** Full file content, or undefined when the file could not be read. */
  content?: string;
  /** Set when reading failed for a reason other than absence. */
  readError?: string;
}

export interface RenderedChain {
  text: string;
  /** Display paths whose content was cut to fit. */
  truncated: string[];
  /** Display paths dropped entirely. */
  omitted: string[];
  /** Display paths that exist but could not be read. */
  unreadable: string[];
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Cut `value` to at most `maxBytes`, never splitting a UTF-8 sequence.
 *
 * Slicing by character count would be wrong for the same reason it always is:
 * the budget is in bytes because the guard exists to bound what reaches the
 * model, and a multibyte document would otherwise blow past it.
 */
export function clampUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let end = Math.max(0, maxBytes);
  // Walk back off any continuation byte so the tail is still valid UTF-8.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/**
 * Directories from `chainRoot` down to `targetDir`, inclusive.
 *
 * Returns just the root when the target is outside it — a nested repository
 * starts its own chain rather than inheriting an unrelated outer one, and that
 * boundary is decided by the caller when it picks `chainRoot`.
 */
export function collectChainDirectories(chainRoot: string, targetDir?: string): string[] {
  const root = path.resolve(chainRoot);
  if (!targetDir) return [root];
  const target = path.resolve(targetDir);
  const relative = path.relative(root, target);
  if (relative === '') return [root];
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [root];

  const directories = [root];
  let current = root;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    directories.push(current);
  }
  return directories;
}

function header(file: ChainFile): string {
  const scope = file.scope === '' ? 'repository root' : `${file.scope}/`;
  return `\n\n===== ${file.displayPath} — applies to ${scope} =====\n`;
}

const PRECEDENCE_NOTE =
  '<!-- Project instructions, outermost first. A file deeper in the tree is more ' +
  'specific: within the directory it applies to, prefer it where it conflicts with ' +
  'the guidance above. This is the intended precedence between these documents ' +
  'only; it does not override the system prompt, the user, or any permission rule. -->';

/**
 * Render a chain into the text injected at the prompt head.
 *
 * The budget is allocated **root-first**: repository-wide rules are the ones
 * every file depends on, so a large leaf truncates rather than pushing the root
 * out. The opposite policy — nearest-first — reads as more "specific", but it
 * silently drops the rules that hold for the whole repository, which is the
 * worse failure.
 */
export function renderInstructionChain(
  files: readonly ChainFile[],
  maxBytes: number = MAX_INSTRUCTION_BYTES,
): RenderedChain | undefined {
  const present = files.filter((file) => file.content !== undefined || file.readError);
  if (!present.length) return undefined;

  const truncated: string[] = [];
  const omitted: string[] = [];
  const unreadable: string[] = [];

  // A lone file keeps exactly its previous shape: raw content, one cap, no
  // delimiters spending budget that the content could have used.
  if (present.length === 1 && !present[0].readError) {
    const only = present[0];
    const clamped = clampUtf8(only.content ?? '', maxBytes);
    if (clamped.truncated) truncated.push(only.displayPath);
    return { text: clamped.text, truncated, omitted, unreadable };
  }

  const blocks: string[] = [PRECEDENCE_NOTE];
  let remaining = maxBytes - byteLength(PRECEDENCE_NOTE);

  for (const file of present) {
    const head = header(file);
    const headBytes = byteLength(head);

    if (file.readError) {
      const notice = `${head}[unreadable: ${file.readError}]`;
      if (byteLength(notice) <= remaining - OMISSION_RESERVE) {
        blocks.push(notice);
        remaining -= byteLength(notice);
      } else {
        omitted.push(file.displayPath);
      }
      unreadable.push(file.displayPath);
      continue;
    }

    const room = remaining - headBytes - OMISSION_RESERVE;
    if (room < MIN_CONTENT_BYTES) {
      omitted.push(file.displayPath);
      continue;
    }
    const clamped = clampUtf8(file.content ?? '', room - byteLength(TRUNCATION_MARKER));
    const body = clamped.truncated ? clamped.text + TRUNCATION_MARKER : clamped.text;
    if (clamped.truncated) truncated.push(file.displayPath);
    blocks.push(head + body);
    remaining -= headBytes + byteLength(body);
  }

  if (omitted.length) {
    const notice = `\n\n<!-- Omitted, project-instruction budget exhausted: ${omitted.join(', ')} -->`;
    blocks.push(clampUtf8(notice, Math.max(0, remaining)).text);
  }

  return { text: blocks.join(''), truncated, omitted, unreadable };
}
