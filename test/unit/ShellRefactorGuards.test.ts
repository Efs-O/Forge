/**
 * Guards for docs/plans/SHELL_TOOL_AND_CORE_GROUP_PLAN.md acceptance criteria.
 * Reads the tree from disk only — no Forge modules imported, so it stays green
 * (or red) independently of the refactor's internals.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

const REMOVED_TOOL_NAMES = [
  'exec_command',
  'query_powershell',
  'run_terminal',
  'run_workspace_task',
  'list_workspace_tasks',
];

const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.njk', '.yaml', '.json', '.md']);

const ALLOWED_EXCEPTIONS = [
  'src/agents/adapters/codexAdapter.ts',
  'src/sidebar/compactionLedger.ts',
  'src/sidebar/retiredTools.ts',
];

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

function posixRel(file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function isException(file: string): boolean {
  const rel = posixRel(file);
  return ALLOWED_EXCEPTIONS.some((exception) => rel.endsWith(exception));
}

function lineHits(file: string, pattern: RegExp): string[] {
  const rel = posixRel(file);
  const text = fs.readFileSync(file, 'utf8');
  // Most files never match; skip splitting them, since this walks the whole tree.
  if (!pattern.test(text)) return [];
  return text
    .split(/\r?\n/)
    .map((line, index) => (pattern.test(line) ? `${rel}:${index + 1}` : null))
    .filter((hit): hit is string => hit !== null);
}

describe('shell/core-group refactor guards', () => {
  it('removed tool names are absent from src/ and config/ except the allowed files', () => {
    const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'config'))].filter(
      (file) => !isException(file),
    );
    // One pass per file: reading the tree once per name timed out under full CI load.
    const removed = new RegExp(`\\b(?:${REMOVED_TOOL_NAMES.join('|')})\\b`);
    const hits = files.flatMap((file) => lineHits(file, removed));
    expect(hits, `removed tool names still referenced:\n${hits.join('\n')}`).toEqual([]);
  }, 20_000);

  // Raised from 3,500 in 0.17.4, and from 4,000 in 0.17.10: the owner raises the
  // cap when a rule earns its bytes rather than trimming rules to fit. It still
  // catches accidental bloat.
  //
  // Raised to 5,600 on 2026-10-27 (lane 5 phase 5.3, 5,000 → 5,600): the
  // delegation rules added 1,042 bytes of file, which is what the plan asked for
  // and no shorter wording reaches all seven points. Those bytes are inside
  // `{% if agentTools %}`, so a workspace without Claude Code or a local target
  // never pays them — the cap is a file-size proxy, and the thing it was
  // protecting is now gated directly: test/unit/DelegationPromptBlock.test.ts
  // measures the RENDERED delta and refuses it above 1,100 bytes. The file is
  // 5,557 bytes as of this change, so 5,600 still catches a stray paragraph.
  //
  // Raised to 5,800 on 2026-10-28 (Lane B item 7 of OWNER_GUARDS_PLAN): the
  // secret-decline line is 161 bytes, outside any `{% if %}` block, so every
  // chat pays it. It earns those bytes because an agent whose secret read was
  // declined went and got the same content through the shell instead of telling
  // the user — a refusal the user gave became a round the user never agreed to.
  // The file is 5,718 bytes as of that change, so 5,800 still catches a stray
  // paragraph. Lane F2 (2026-10-29) added the 23-byte `{% if skillsCatalog %}`
  // gate around the skills block: the catalog itself is rendered content, not
  // template bytes, so the template grew by the gate only. That cap still did
  // its job — catching a paragraph nobody meant to put in the prompt.
  // 2026-10-30, +2 bytes (5,825): the notify_on_exit lane reworded the
  // background-shell line to "(wakes you when it ends)", because the flag is on
  // by default now.
  // 2026-10-30, +410 bytes (6,235): the final answer's plain opening moved here
  // from FORGE.md, because user instructions outrank project instructions and a
  // lane brief asking for a hash beat it. The cap is 6,260, 25 bytes above the
  // file, so a stray paragraph is still caught.
  // 2026-10-31, +317 bytes (6,552): the reply now says to keep the part after the
  // plain opening in everyday words too — name a file, a number or a test only
  // when the user needs it to act — and to put a requesting agent's technical
  // detail (hashes, paths, counts) at the end under "Detail for the record", so
  // an agent still gets the exact numbers without the owner wading through them.
  // Cap 6,577 keeps the same 25 bytes above the file.
  // 2026-11-04, +78 bytes (6,630): the final-answer rule, one long bullet the
  // owner found only half-followed, is split into six short ones, and it takes
  // over the two parts only FORGE.md carried (what you measured versus only
  // read; match depth to the question), so the rule lives in one place.
  // Cap 6,655 keeps the same 25 bytes above the file.
  // 2026-11-05, -886 bytes (5,744): the six reply-rule bullets are replaced by
  // two, the owner's decision after the session scan (docs/reports/
  // FORGE_SESSION_TOOL_FAILURES_2026-11-05.md): the six stated the plain-English
  // rule once and loosened it four times, and the scan showed replies staying
  // technical past the opening anyway. Two of the things the six carried — the
  // direct answer goes first, and match the length to the question — came back
  // for 64 of those bytes. The cap stays 6,655, so the file now sits 911 bytes
  // under it rather than 25 above: the tripwire still catches a stray paragraph,
  // which is what it is for.
  // 2026-11-05, +245 bytes (5,989): three rules from the same scan, each tied to
  // measured failures — copy edit text from the newest read (23 failed edits),
  // a search with no matches is an answer (11), and tool and field names are
  // fixed (3 bad names, 12 wrong fields). 666 bytes under the cap.
  it('config/templates/builtin/execute.njk is at most 6,655 bytes', () => {
    const file = path.join(root, 'config', 'templates', 'builtin', 'execute.njk');
    const size = fs.statSync(file).size;
    expect(size, `execute.njk is ${size} bytes; the cap is 6655`).toBeLessThanOrEqual(6655);
  });

  it('the dead src/templates/builtin copy is deleted', () => {
    expect(fs.existsSync(path.join(root, 'src', 'templates', 'builtin'))).toBe(false);
  });

  it('no file under src/tools/ declares a filepath schema property', () => {
    const filepath = /\bfilepath\s*:|['"]filepath['"]\s*:/;
    const hits = walk(path.join(root, 'src', 'tools')).flatMap((file) => lineHits(file, filepath));
    expect(hits, `filepath schema properties remain:\n${hits.join('\n')}`).toEqual([]);
  });
});
