/**
 * Where past-session lookups live is written in three places: this workspace's
 * `FORGE.md` (local, gitignored), `docs/WORKSPACE_FORENSICS.md` (tracked), and
 * the starter `FORGE.md` Forge writes into every new workspace. They kept
 * disagreeing: the repo file said the raw logs carry no title while
 * `SessionLogger.ts` has been writing `session_start.title` for months, and the
 * doc's recipe read `forge.conversations.v1`, which `shrinkV1` has since
 * reduced to one stub record — so the recipe printed `Untitled chat` for a chat
 * with a real name (docs/plans/V1_FINISH_PLAN.md lane 4 phase 4, measured
 * 2026-10-27). These tests pin the agreed order — raw logs first, HalluScribe
 * second — and check every storage key the doc tells an agent to read is still
 * a key the code writes.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const doc = fs.readFileSync(path.join(root, 'docs', 'WORKSPACE_FORENSICS.md'), 'utf8');
const loader = fs.readFileSync(path.join(root, 'src', 'llm', 'ForgeInstructionsLoader.ts'), 'utf8');
const starterStart = loader.indexOf('const STARTER_CONTENT = `');
const starter = loader.slice(starterStart, loader.indexOf('`;', starterStart + 10));

/** Every `forge.*` string literal the source actually writes as a storage key. */
const quotedKeys = new Set<string>();
const walkSource = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSource(full);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    for (const match of fs.readFileSync(full, 'utf8').matchAll(/['"](forge\.[A-Za-z0-9.]+)['"]/g)) {
      quotedKeys.add(match[1]!);
    }
  }
};
walkSource(path.join(root, 'src'));

describe('past-session forensics: the three files must agree', () => {
  it('the forensics doc says the raw logs DO carry a title, and how late it is', () => {
    expect(doc).not.toContain('does not carry the conversation title');
    expect(doc).toContain('session_start');
    // The nuance the rewrite needs: the log title is the value at the start of
    // that run, so a rename shows up one run later. Without this line an agent
    // treats a stale log title as the current name.
    expect(doc).toMatch(/one run (late|later)/);
  });

  it('the recipe it gives reads the live key, and that key is one the code writes', () => {
    expect(doc).toMatch(/Active id:[\s\S]{0,300}v2\.activeConversationId/);
    const keys = ['forge.conversations.v2', 'forge.conversations.activeId'];
    for (const key of keys) {
      expect(doc).toContain(key);
      // A key the doc names and the code no longer writes is how this file
      // went stale in the first place.
      expect([...quotedKeys]).toContain(key);
    }
  });

  it('keeps the v1 recipe marked dead, so nobody reads the stub again', () => {
    expect(doc).toMatch(/v1[\s\S]{0,400}is dead|old recipe[\s\S]{0,300}is dead/);
    // The one-liner has to follow the same path the bullets describe.
    const code = doc.slice(doc.indexOf('python -c'), doc.lastIndexOf('```'));
    expect(code).toContain('forge.conversations.v2');
    expect(code).toContain("'open'");
    expect(code).toContain('mode=ro');
  });

  it('the starter FORGE.md sends a new workspace to the raw logs first', () => {
    expect(starter).toContain('.forge/sessions');
    expect(starter).toMatch(/raw logs first/);
    expect(starter).toMatch(/second stop/);
    // The starter is paid on every turn in every workspace, so it stays short:
    // one bullet, no per-machine detail.
    expect(starter.split('\n').filter((line) => line.includes('.forge/sessions'))).toHaveLength(1);
  });

  it('this workspace FORGE.md agrees — logs first, the false "no title" claim gone', () => {
    // Gitignored (.gitignore:90), so CI runners have no copy of it; the check
    // is for the machine that owns the file.
    const forgePath = path.join(root, 'FORGE.md');
    if (!fs.existsSync(forgePath)) return;
    const forge = fs.readFileSync(forgePath, 'utf8');
    expect(forge).toMatch(/raw logs first, HalluScribe second/);
    expect(forge).not.toContain('title is NOT in `.forge/sessions');
    expect(forge).not.toContain('do not go to `.claude`');
    // The memory folder must not read as fair game now that that sentence is
    // gone: its "not for code questions" clause still has to be there.
    expect(forge).toContain('NOT for code questions');
  });
});
