/**
 * The user-wide copy of the agent note (`src/vscode/agentUserNote.ts`): the
 * same marked section, in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, so a
 * Claude Code or Codex session started outside every Forge workspace still
 * learns it can message, steer and stop a Forge chat.
 *
 * These are the guarantees that make the write safe to offer at all: both files
 * are created (with their folders) when missing, the owner's own lines survive
 * beside the section, a second run changes nothing, and the automatic refresh on
 * a start is replace-only — a file that is missing or holds no section is left
 * byte-for-byte as it is, so running Forge never writes into a home folder.
 *
 * Every home directory here is a temporary folder passed to the functions; the
 * operator's real `~/.claude` and `~/.codex` are never opened.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AGENT_NOTE_END,
  AGENT_NOTE_START,
  buildAgentMeshNote,
  countAgentMeshSections,
} from '../../src/agentBus/agentMeshNote';
import {
  installUserNote,
  refreshUserNote,
  userNoteFiles,
  userNoteFacts,
} from '../../src/vscode/agentUserNote';

const busDir = 'C:/Users/tester/.forge/agent-bus';
const facts = userNoteFacts(busDir);
// The user scope: this copy reaches sessions outside every Forge workspace, so
// it is built without the "Who does what" delegation policy.
const note = buildAgentMeshNote(facts, 'user');
const stale = `${AGENT_NOTE_START}\nthe note an older build wrote\n${AGENT_NOTE_END}`;

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'user-note-'));
afterAll(() =>
  fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
);
/** One fresh home per test, so "created" means created by this call. */
const freshHome = (name: string): string => fs.mkdtempSync(path.join(runDir, `${name}-`));
const read = (filePath: string): string => fs.readFileSync(filePath, 'utf8');
const statuses = (
  results: { path: string; status: string }[],
): [string, string][] => results.map((result) => [path.basename(result.path), result.status]);

describe('the two user files', () => {
  it('are Claude Code\'s and Codex\'s, under the home folder it is given', () => {
    expect(userNoteFiles('C:/Users/tester')).toEqual([
      path.join('C:/Users/tester', '.claude', 'CLAUDE.md'),
      path.join('C:/Users/tester', '.codex', 'AGENTS.md'),
    ]);
  });

  it('both get the section, and their folders are created with them', () => {
    const home = freshHome('both');
    const results = installUserNote(home, facts);
    expect(statuses(results)).toEqual([
      ['CLAUDE.md', 'created'],
      ['AGENTS.md', 'created'],
    ]);
    for (const filePath of userNoteFiles(home)) {
      const content = read(filePath);
      expect(countAgentMeshSections(content)).toBe(1);
      expect(content).toContain(AGENT_NOTE_START);
      expect(content).toContain(AGENT_NOTE_END);
      expect(content).toContain(note.trimEnd());
    }
  });

  it('keep the text the owner wrote, and a second run changes nothing', () => {
    const home = freshHome('owner-text');
    const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
    const own = '# My Claude rules\nNever push without asking.\n';
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(claudeMd, own, 'utf8');

    expect(statuses(installUserNote(home, facts))).toEqual([
      ['CLAUDE.md', 'appended'],
      ['AGENTS.md', 'created'],
    ]);
    const content = read(claudeMd);
    expect(content.startsWith(own)).toBe(true);
    expect(content).toContain('Never push without asking.');
    expect(countAgentMeshSections(content)).toBe(1);

    expect(statuses(installUserNote(home, facts))).toEqual([
      ['CLAUDE.md', 'unchanged'],
      ['AGENTS.md', 'unchanged'],
    ]);
    expect(read(claudeMd)).toBe(content);
  });
});

describe('the note text is workspace-neutral', () => {
  it('substitutes every fact and names the real bus folder', () => {
    expect(note).not.toContain('__FORGE_');
    expect(note).toContain(busDir);
  });

  it('says it is the user-wide copy instead of a mesh state', () => {
    expect(note).toContain(
      "**State, as Forge recorded it when this section was written:** this is the user-wide copy; each workspace's own note records that workspace's settings.",
    );
    // Not this workspace's state line, which is the other half of the point.
    expect(note).not.toMatch(/control server (on|off)/iu);
  });

  it('names both places a config can be, instead of one workspace\'s file', () => {
    expect(note).toContain(
      'Config: `<workspace>/.forge/config.yaml`, else `~/.forge/config.yaml`.',
    );
  });

  it('carries no delegation policy into either user file', () => {
    // Both copies are read by every Claude Code / Codex session on the machine,
    // so neither may hold this owner's local-lane delegation rules.
    const home = freshHome('no-policy');
    installUserNote(home, facts);
    for (const filePath of userNoteFiles(home)) {
      const content = read(filePath);
      expect(countAgentMeshSections(content)).toBe(1);
      expect(content).toContain(AGENT_NOTE_START);
      expect(content).toContain(AGENT_NOTE_END);
      expect(content).toContain('does not exist, ignore this section.');
      expect(content).not.toContain('Who does what');
      expect(content).not.toContain('delegate the implementing');
      expect(content).not.toContain('fresh Forge chat per');
      expect(content).toContain('**State, as Forge recorded it when this section was written:**');
    }
  });
});

describe('the refresh on a start', () => {
  it('replaces a stale section and leaves the owner text beside it', () => {
    const home = freshHome('refresh-stale');
    const codexMd = path.join(home, '.codex', 'AGENTS.md');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const own = 'Codex rules of my own.\n';
    fs.writeFileSync(codexMd, `${own}\n${stale}\n`, 'utf8');

    const results = refreshUserNote(home, facts);
    expect(statuses(results)).toEqual([
      ['CLAUDE.md', 'skipped'],
      ['AGENTS.md', 'replaced'],
    ]);
    const content = read(codexMd);
    expect(content.startsWith(own)).toBe(true);
    expect(content).toContain(note.trimEnd());
    expect(content).not.toContain('the note an older build wrote');
    expect(countAgentMeshSections(content)).toBe(1);
  });

  it('leaves a marker-less file byte-identical and a missing file missing', () => {
    const home = freshHome('refresh-untouched');
    const codexMd = path.join(home, '.codex', 'AGENTS.md');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const own = '# Mine\nNo note here, and none wanted.\n';
    fs.writeFileSync(codexMd, own, 'utf8');

    const results = refreshUserNote(home, facts);
    expect(statuses(results)).toEqual([
      ['CLAUDE.md', 'skipped'],
      ['AGENTS.md', 'skipped'],
    ]);
    expect(read(codexMd)).toBe(own);
    // No folder was created for the file that was not there: a start does not
    // write into a home folder the owner never asked Forge to touch.
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('is idempotent: a section already up to date is not rewritten', () => {
    const home = freshHome('refresh-idempotent');
    installUserNote(home, facts);
    const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
    const written = read(claudeMd);
    expect(statuses(refreshUserNote(home, facts))).toEqual([
      ['CLAUDE.md', 'unchanged'],
      ['AGENTS.md', 'unchanged'],
    ]);
    expect(read(claudeMd)).toBe(written);
  });
});
