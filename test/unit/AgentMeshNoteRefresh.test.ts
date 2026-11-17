/**
 * Phase B, criterion 8 of `docs/plans/AGENT_DOCS_GAP_AUDIT_PLAN.md`: the agent
 * note is refreshed when its text changes, and a refresh never re-adds a
 * section the owner deleted.
 *
 * Phase A row C9 found the note is written once per workspace
 * (`src/vscode/workspaceBootstrap.ts:98,106` gate the install on
 * `NOTE_INSTALLED_MARKER`), so a change to `AGENT_NOTE_TEMPLATE` reached only
 * workspaces that had never had the note. Proof from this repo: `CLAUDE.md` and
 * `AGENTS.md` still carried the pre-`23703708` note, missing the "Who does
 * what" block the template has at `src/agentBus/agentMeshNote.ts:107-124`.
 *
 * These four cases are the criterion, and they are the ledger's cells for the
 * hash record (crash mid-write, owner-process death): the hash is stored only
 * after the writes, so a crash leaves the old hash and the refresh repeats with
 * the same text.
 *
 * Everything exercised here is pure (temp folders and `fs`), no VS Code: the
 * decision is `planNoteInstall`, the writes are `installAgentMeshNote` /
 * `refreshAgentMeshNote`, and the bootstrap in `workspaceBootstrap.ts` is the
 * only thing that calls them.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AGENT_NOTE_END,
  AGENT_NOTE_START,
  buildAgentMeshNote,
  type AgentMeshNoteFacts,
} from '../../src/agentBus/agentMeshNote';
import {
  hashAgentMeshNote,
  installAgentMeshNote,
  planNoteInstall,
  refreshAgentMeshNote,
  renderAgentMeshNote,
} from '../../src/vscode/agentMeshNoteSetup';

const facts: AgentMeshNoteFacts = {
  busDir: 'C:/Users/tester/.forge/agent-bus',
  configPath: 'C:/Users/tester/.forge/config.yaml',
  meshState: 'control server on, port 8799 (loopback only); agent bus on',
};
const note = renderAgentMeshNote(facts);
/** A note whose text changed, so a hash difference is real and not a fixture
 *  artefact: the same shape, one fact different. */
const changedFacts: AgentMeshNoteFacts = {
  ...facts,
  meshState: 'control server on, port 8799 (loopback only); agent bus on; delegation on',
};
const changedNote = renderAgentMeshNote(changedFacts);

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-refresh-'));
afterAll(() => fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

const makeRoot = (name: string, files: Record<string, string>): string => {
  const root = path.join(runDir, name);
  fs.mkdirSync(path.join(root, '.forge'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, file), content, 'utf8');
  }
  return root;
};
const readNoteFile = (root: string, file: string): string =>
  fs.readFileSync(path.join(root, file), 'utf8');

describe('what a start should do about the note (criterion 8c, 8d)', () => {
  it('installs once, then refreshes only when the rendered note changed', () => {
    const hash = hashAgentMeshNote(note);
    expect(planNoteInstall(false, undefined, hash)).toBe('install');
    expect(planNoteInstall(true, hash, hash)).toBe('none');
    expect(planNoteInstall(true, hashAgentMeshNote(changedNote), hash)).toBe('refresh');
    // A workspace installed before the hash existed is treated as stale, so the
    // first start on a build that carries the hash refreshes it once.
    expect(planNoteInstall(true, undefined, hash)).toBe('refresh');
  });

  it('hashes the note byte for byte, so the hash and the write cannot disagree', () => {
    expect(hashAgentMeshNote(note)).not.toBe(hashAgentMeshNote(changedNote));
    expect(hashAgentMeshNote(buildAgentMeshNote(facts))).toBe(hashAgentMeshNote(note));
    expect(hashAgentMeshNote(note)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the refresh replaces a section that is already there (criterion 8a)', () => {
  const ownerRule = 'Keep your own rules here: deploy with `npm run ship`.';
  const root = makeRoot('replace-existing', {
    'AGENTS.md': `${ownerRule}\n\n${AGENT_NOTE_START}\nthe old note body\n${AGENT_NOTE_END}\n`,
    'CLAUDE.md': `# Project\n\n${AGENT_NOTE_START}\nthe old note body\n${AGENT_NOTE_END}\n`,
  });

  it('writes the new note into both files and leaves the owner text alone', () => {
    const results = refreshAgentMeshNote([root], changedFacts);
    expect(results.map((result) => result.status)).toEqual(['replaced', 'replaced']);
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      const content = readNoteFile(root, file);
      expect(content).toContain(changedNote.trimEnd());
      expect(content).not.toContain('the old note body');
    }
    expect(readNoteFile(root, 'AGENTS.md')).toContain(ownerRule);
    expect(readNoteFile(root, 'CLAUDE.md')).toContain('# Project');
  });

  it('is idempotent: a second refresh with the same note writes nothing', () => {
    const results = refreshAgentMeshNote([root], changedFacts);
    expect(results.map((result) => result.status)).toEqual(['unchanged', 'unchanged']);
  });
});

describe('a refresh never creates or appends (criterion 8b)', () => {
  it('leaves a file whose section the owner deleted exactly as it was', () => {
    const deleted = 'Keep your own rules here.\n\nDeploy with `npm run ship`.\n';
    const root = makeRoot('owner-deleted', { 'AGENTS.md': deleted });
    const results = refreshAgentMeshNote([root], changedFacts);
    const agents = results.find((result) => result.path.endsWith('AGENTS.md'));
    const claude = results.find((result) => result.path.endsWith('CLAUDE.md'));
    expect(agents?.status).toBe('skipped');
    expect(agents?.reason).toContain('the owner removed it');
    expect(claude?.status).toBe('skipped');
    expect(claude?.reason).toContain('no file');
    expect(readNoteFile(root, 'AGENTS.md')).toBe(deleted);
  });

  it('leaves a workspace with no instruction files at all untouched', () => {
    const root = makeRoot('no-files', {});
    const results = refreshAgentMeshNote([root], changedFacts);
    expect(results.every((result) => result.status === 'skipped')).toBe(true);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
  });
});

describe('a first install behaves as it always did (criterion 8d)', () => {
  const statuses = (
    results: { path: string; status: string }[],
  ): [string, string][] => results.map((result) => [path.basename(result.path), result.status]);

  it('creates AGENTS.md with the section and CLAUDE.md as the @AGENTS.md import', () => {
    const root = makeRoot('first-install', {});
    const results = installAgentMeshNote([root], facts);
    expect(statuses(results)).toEqual([
      ['AGENTS.md', 'created'],
      ['CLAUDE.md', 'created'],
    ]);
    const content = readNoteFile(root, 'AGENTS.md');
    expect(content).toContain(AGENT_NOTE_START);
    expect(content).toContain(AGENT_NOTE_END);
    expect(content).toContain(note.trimEnd());
    // The created `CLAUDE.md` is the import and nothing else: an import plus a
    // copy of the section would put the same text into Claude's context twice.
    expect(readNoteFile(root, 'CLAUDE.md')).toBe('@AGENTS.md\n');
  });

  it('adds the section beside existing text, and creates the file that is missing', () => {
    const root = makeRoot('first-install-claude', { 'CLAUDE.md': '# Mine\n\nMy rules.\n' });
    const results = installAgentMeshNote([root], facts);
    // Both files, because that is what each agent reads: a Claude Code session
    // reads `CLAUDE.md` and ignores `AGENTS.md` when it exists, and Codex reads
    // only `AGENTS.md`, so the section has to be in whichever one is opened.
    expect(statuses(results)).toEqual([
      ['AGENTS.md', 'created'],
      ['CLAUDE.md', 'appended'],
    ]);
    expect(readNoteFile(root, 'AGENTS.md')).toContain(note.trimEnd());
    const content = readNoteFile(root, 'CLAUDE.md');
    expect(content.startsWith('# Mine\n\nMy rules.\n')).toBe(true);
    expect(content).toContain('My rules.');
    expect(content).toContain(AGENT_NOTE_START);
    expect(content).toContain(note.trimEnd());
  });

  it('leaves a CLAUDE.md that already imports AGENTS.md exactly as the owner wrote it', () => {
    const root = makeRoot('first-install-import', { 'CLAUDE.md': '# Mine\n\n@AGENTS.md\n' });
    const results = installAgentMeshNote([root], facts);
    expect(statuses(results)).toEqual([['AGENTS.md', 'created']]);
    expect(readNoteFile(root, 'AGENTS.md')).toContain(note.trimEnd());
    expect(readNoteFile(root, 'CLAUDE.md')).toBe('# Mine\n\n@AGENTS.md\n');
  });

  it('a refresh creates nothing, in a root that never had the install', () => {
    const root = makeRoot('refresh-creates-nothing', { 'CLAUDE.md': '@AGENTS.md\n' });
    const results = refreshAgentMeshNote([root], facts);
    expect(statuses(results)).toEqual([
      ['AGENTS.md', 'skipped'],
      ['CLAUDE.md', 'skipped'],
    ]);
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(readNoteFile(root, 'CLAUDE.md')).toBe('@AGENTS.md\n');
  });
});
