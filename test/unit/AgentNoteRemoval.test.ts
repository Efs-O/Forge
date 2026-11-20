/**
 * Getting the agent note back out again: the registry of files Forge wrote it
 * into, and the removal the mesh-off start and the uninstall both run.
 *
 * The two guarantees the owner will check are pinned here. The first is that a
 * removal costs the workspace nothing: everything outside the markers survives
 * byte for byte, in the file's own line endings. The second is that Forge only
 * ever deletes a file it created and left empty — a file it merely wrote a
 * section into keeps its file, even when that file holds nothing else.
 *
 * Every path here is in a temporary folder, including the registry: a test that
 * reached the real `~/.forge` would rewrite the operator's own note list.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENTS_MD_IMPORT_FILE_CONTENT,
  AGENT_NOTE_START,
  buildAgentMeshNote,
  type AgentMeshNoteFacts,
} from '../../src/agentBus/agentMeshNote';
import {
  noteFilesRegistryPath,
  readNoteFiles,
  recordNoteFiles,
  removeNoteFromFile,
  removeRecordedAgentNotes,
  removeWorkspaceAgentNotes,
} from '../../src/agentBus/agentNoteRemoval';
import { runUninstall } from '../../src/uninstall';

const facts: AgentMeshNoteFacts = {
  busDir: 'C:/Users/tester/.forge/agent-bus',
  configPath: 'C:/Users/tester/config.yaml',
  meshState: 'control server on, port 8799 (loopback only); agent bus off',
};
const note = buildAgentMeshNote(facts);
const noteCrlf = note.split('\n').join('\r\n');

/** A temporary home: the registry lives under it, never under the operator's. */
let home: string;
let registry: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-note-remove-'));
  registry = noteFilesRegistryPath(home);
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(filePath: string, content: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe('the registry of files Forge wrote the note into', () => {
  it('keeps a file Forge created deletable through every later refresh', () => {
    const target = path.resolve(path.join(home, 'AGENTS.md'));
    recordNoteFiles(registry, [{ path: target, status: 'created' }]);
    recordNoteFiles(registry, [{ path: target, status: 'replaced' }]);
    expect(readNoteFiles(registry)).toEqual([{ path: target, created: true }]);
  });

  it('records a file it only wrote into as one it must never delete', () => {
    const agents = path.resolve(path.join(home, 'AGENTS.md'));
    const claude = path.resolve(path.join(home, 'CLAUDE.md'));
    recordNoteFiles(registry, [
      { path: claude, status: 'appended' },
      { path: agents, status: 'unchanged' },
    ]);
    expect(readNoteFiles(registry)).toEqual([
      { path: agents, created: false },
      { path: claude, created: false },
    ]);
  });

  it('records nothing for a file it skipped or could not read', () => {
    recordNoteFiles(registry, [
      { path: path.join(home, 'AGENTS.md'), status: 'skipped' },
      { path: path.join(home, 'CLAUDE.md'), status: 'error' },
    ]);
    expect(readNoteFiles(registry)).toEqual([]);
    expect(fs.existsSync(registry)).toBe(false);
  });

  it('reads a torn or foreign registry as empty, and the next record rebuilds it', () => {
    for (const torn of ['{ "version": 1, "files":', JSON.stringify({ version: 9, files: [] })]) {
      write(registry, torn);
      expect(readNoteFiles(registry)).toEqual([]);
    }
    const target = path.resolve(path.join(home, 'AGENTS.md'));
    recordNoteFiles(registry, [{ path: target, status: 'created' }]);
    expect(readNoteFiles(registry)).toEqual([{ path: target, created: true }]);
  });
});

describe('taking the note out of one file', () => {
  it('leaves the owner text byte for byte and drops the blank line above the section', () => {
    const filePath = write(path.join(home, 'AGENTS.md'), `own\n\n${note}\n`);
    expect(removeNoteFromFile(filePath, false)).toEqual({ path: filePath, status: 'removed' });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('own\n');
  });

  it('keeps the owner text on both sides of the section, in the file’s CRLF endings', () => {
    const filePath = write(path.join(home, 'AGENTS.md'), `own\r\n\r\n${noteCrlf}\r\n\r\nmore\r\n`);
    expect(removeNoteFromFile(filePath, false).status).toBe('removed');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(`own\r\n\r\nmore\r\n`);
  });

  it('deletes a file Forge created that holds nothing but the section', () => {
    const filePath = write(path.join(home, 'AGENTS.md'), `${note}\n`);
    expect(removeNoteFromFile(filePath, true).status).toBe('deleted');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deletes a created CLAUDE.md that holds only the @AGENTS.md import', () => {
    const filePath = write(path.join(home, 'CLAUDE.md'), AGENTS_MD_IMPORT_FILE_CONTENT);
    expect(removeNoteFromFile(filePath, true).status).toBe('deleted');
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('refuses to delete a file it did not create, even one holding only the section', () => {
    const filePath = write(path.join(home, 'AGENTS.md'), `${note}\n`);
    expect(removeNoteFromFile(filePath, false).status).toBe('removed');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('');
  });

  it('leaves a not-created import CLAUDE.md completely alone', () => {
    const filePath = write(path.join(home, 'CLAUDE.md'), AGENTS_MD_IMPORT_FILE_CONTENT);
    expect(removeNoteFromFile(filePath, false).status).toBe('none');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(AGENTS_MD_IMPORT_FILE_CONTENT);
  });

  it('reports a lone marker instead of guessing what it cuts', () => {
    const torn = `own\n\n${AGENT_NOTE_START}\nleftover text to the end`;
    const filePath = write(path.join(home, 'AGENTS.md'), torn);
    const result = removeNoteFromFile(filePath, true);
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('a lone forge-agent-mesh marker; left as it is');
    expect(fs.readFileSync(filePath, 'utf8')).toBe(torn);
  });

  it('reports a file with no note in it as nothing to do, and does not rewrite it', () => {
    const filePath = write(path.join(home, 'AGENTS.md'), '# Mine\n');
    expect(removeNoteFromFile(filePath, true).status).toBe('none');
    expect(fs.readFileSync(filePath, 'utf8')).toBe('# Mine\n');
  });

  it('refuses to write through a symlink, leaving its target untouched', () => {
    const target = write(path.join(home, 'shared.md'), `own\n\n${note}\n`);
    const link = path.join(home, 'AGENTS.md');
    let madeLink = false;
    try {
      fs.symlinkSync(target, link);
      madeLink = true;
    } catch {
      // Windows without developer mode: a junction cannot point at a file, so
      // only a real symlink can carry the note — skip instead of substituting.
      return;
    }
    expect(madeLink).toBe(true);
    recordNoteFiles(registry, [{ path: link, status: 'unchanged' }]);
    const result = removeNoteFromFile(link, false);
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('not a regular file');
    expect(fs.readFileSync(target, 'utf8')).toBe(`own\n\n${note}\n`);
    // The entry stays: a file Forge could not clean up is still owed a removal.
    expect(readNoteFiles(registry)).toEqual([{ path: link, created: false }]);
  });

  it('answers nothing to do for a link whose target holds no note', () => {
    const target = write(path.join(home, 'shared.md'), 'own\n');
    const link = path.join(home, 'AGENTS.md');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // Windows without developer mode: no symlink to test with.
    }
    expect(removeNoteFromFile(link, false)).toEqual({ path: link, status: 'none' });
    // Nothing is written, so the target keeps its text.
    expect(fs.readFileSync(target, 'utf8')).toBe('own\n');
  });

  it('answers nothing to do when the instruction name is a folder, not a file', () => {
    const dir = path.join(home, 'AGENTS.md');
    fs.mkdirSync(dir);
    expect(removeNoteFromFile(dir, false)).toEqual({ path: dir, status: 'none' });
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('cleaning a workspace root', () => {
  it('deletes both files it created there and forgets the registry', () => {
    const root = path.join(home, 'repo');
    const agents = write(path.join(root, 'AGENTS.md'), `${note}\n`);
    const claude = write(path.join(root, 'CLAUDE.md'), AGENTS_MD_IMPORT_FILE_CONTENT);
    recordNoteFiles(registry, [
      { path: agents, status: 'created' },
      { path: claude, status: 'created' },
    ]);
    expect(removeWorkspaceAgentNotes([root], registry).map((r) => r.status)).toEqual([
      'deleted',
      'deleted',
    ]);
    expect(fs.existsSync(agents)).toBe(false);
    expect(fs.existsSync(claude)).toBe(false);
    expect(fs.existsSync(registry)).toBe(false);
  });

  it('removes a section an older Forge wrote and keeps the file it did not create', () => {
    const root = path.join(home, 'repo');
    const agents = write(path.join(root, 'AGENTS.md'), `own\n\n${note}\n`);
    expect(removeWorkspaceAgentNotes([root], registry).map((r) => r.status)).toEqual([
      'removed',
      'none',
    ]);
    expect(fs.readFileSync(agents, 'utf8')).toBe('own\n');
  });

  it('keeps what it could not remove in the registry, with the rest forgotten', () => {
    const root = path.join(home, 'repo');
    const other = write(path.join(home, 'elsewhere.md'), `${note}\n`);
    write(path.join(root, 'AGENTS.md'), `${note}\n`);
    recordNoteFiles(registry, [
      { path: path.join(root, 'AGENTS.md'), status: 'created' },
      { path: other, status: 'created' },
    ]);
    removeWorkspaceAgentNotes([root], registry);
    expect(readNoteFiles(registry)).toEqual([{ path: other, created: true }]);
  });
});

describe('the uninstall sweep over every recorded file', () => {
  it('clears the user-wide copy and the workspace copies, and forgets them', () => {
    const userClaude = write(path.join(home, '.claude', 'CLAUDE.md'), `mine\n\n${note}\n`);
    const workspaceAgents = write(path.join(home, 'repo', 'AGENTS.md'), `${note}\n`);
    recordNoteFiles(registry, [
      { path: userClaude, status: 'appended' },
      { path: workspaceAgents, status: 'created' },
    ]);

    expect(runUninstall(home).map((r) => r.status)).toEqual(['removed', 'deleted']);
    expect(fs.readFileSync(userClaude, 'utf8')).toBe('mine\n');
    expect(fs.existsSync(workspaceAgents)).toBe(false);
    expect(fs.existsSync(registry)).toBe(false);
    // Nothing recorded, so an uninstall run twice says so instead of failing.
    expect(removeRecordedAgentNotes(registry)).toEqual([]);
  });
});
