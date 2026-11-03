/**
 * The agent note (laptop audit 2026-10-26, F9 point 3): the marked section
 * Forge writes into a workspace's `AGENTS.md` / `CLAUDE.md` when the agent
 * mesh is on. The owner's fresh-folder check on the laptop is exactly the
 * three cases this file asserts, so they are asserted here rather than only
 * noticed by hand: created when absent, added beside existing text without
 * touching it, and never duplicated by a second run.
 *
 * Everything exercised here is the pure writer in `src/agentBus/agentMeshNote.ts`
 * — no VS Code, no workspace, no model.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_NOTE_END,
  AGENT_NOTE_START,
  AGENT_INSTRUCTION_FILE_NAMES,
  agentNoteTargetFiles,
  applyAgentMeshNote,
  buildAgentMeshNote,
  countAgentMeshSections,
  type AgentMeshNoteFacts,
} from '../../src/agentBus/agentMeshNote';

const facts: AgentMeshNoteFacts = {
  busDir: 'C:/Users/tester/.forge/agent-bus',
  configPath: 'C:/Users/tester/AppData/Roaming/Code/User/globalStorage/Efsoo.forge-llm/config.yaml',
  meshState: 'control server on, port 8799 (loopback only); agent bus on',
};
const note = buildAgentMeshNote(facts);
/** A section-shaped fake of a note, so a test can say "the note changed"
 *  without rebuilding the real one. */
const fakeNote = (body: string): string => `${AGENT_NOTE_START}\n${body}\n${AGENT_NOTE_END}`;

describe('the agent note body', () => {
  it('substitutes every fact and leaves no token behind', () => {
    expect(note).toContain(facts.busDir);
    expect(note).toContain(facts.configPath);
    expect(note).toContain(facts.meshState);
    expect(note).not.toContain('__FORGE_');
  });

  it('is wrapped in its markers and says how to remove it', () => {
    expect(note.startsWith(AGENT_NOTE_START)).toBe(true);
    expect(note.endsWith(AGENT_NOTE_END)).toBe(true);
    expect(note).toContain('delete everything between them');
  });

  it('says that an accepted message is not an answer', () => {
    // The laptop audit's F8/F9 complaint was that a caller reported success on
    // a 202 without reading the verdict back.
    expect(note).toContain('Accepted is not answered');
    expect(note).toContain('202');
  });

  it('explains unattended messages and busy-chat turn-end behavior', () => {
    expect(note).toContain('--unattended` means nobody is watching');
    expect(note).toContain(
      'A `say` to a busy chat is read at its next tool round; its answer arrives when',
    );
    expect(note).toContain('the turn ends; use `steer` only to stop the current work.');
    expect(note).toContain('--caption-file` reads');
    expect(note).toContain('the Telegram caption text from that file.');
  });

  it('names the Windows prerequisite instead of assuming bash', () => {
    expect(note).toContain('Git');
    expect(note).toContain('WSL');
  });

  it('tells a CLI agent to plan and review, and to delegate the implementing', () => {
    // Owner, 2026-10-28: Forge exists to save Claude and Codex usage, so the
    // agent reading this note plans and reviews while local lanes implement.
    expect(note).toContain('Who does what');
    expect(note).toContain('delegate the implementing');
    expect(note).toContain('fresh Forge chat per');
  });
});

describe('putting the note into a file', () => {
  it('creates one when the file does not exist', () => {
    const applied = applyAgentMeshNote(undefined, note);
    expect(applied.status).toBe('created');
    expect(countAgentMeshSections(applied.content)).toBe(1);
    expect(applied.content.endsWith('\n')).toBe(true);
  });

  it('adds it beside existing text without touching that text', () => {
    const existing = '# My project\nRules I wrote myself.\nKeep them.\n';
    const applied = applyAgentMeshNote(existing, note);
    expect(applied.status).toBe('appended');
    expect(applied.content.startsWith(existing)).toBe(true);
    expect(countAgentMeshSections(applied.content)).toBe(1);
  });

  it('adds it without a gap when the file has no trailing newline', () => {
    const applied = applyAgentMeshNote('Own line', note);
    expect(applied.content).toBe(`Own line\n\n${note}\n`);
  });

  it('a second run changes nothing', () => {
    const once = applyAgentMeshNote(undefined, note).content;
    const twice = applyAgentMeshNote(once, note);
    expect(twice.status).toBe('unchanged');
    expect(twice.content).toBe(once);
    expect(countAgentMeshSections(twice.content)).toBe(1);
  });

  it('a second run after the user edited their own lines still holds one section', () => {
    const once = applyAgentMeshNote(undefined, note).content;
    const edited = `${once}\n## Another rule\nAdded by hand.\n`;
    const again = applyAgentMeshNote(edited, note);
    expect(again.status).toBe('unchanged');
    expect(again.content).toBe(edited);
    expect(countAgentMeshSections(again.content)).toBe(1);
  });

  it('refreshes the section in place when the note itself changes', () => {
    const older = applyAgentMeshNote(undefined, fakeNote('OLD')).content;
    const applied = applyAgentMeshNote(older, fakeNote('NEW'));
    expect(applied.status).toBe('replaced');
    expect(applied.content).toBe(`${fakeNote('NEW')}\n`);
  });

  it('leaves the user text on both sides of an in-document section alone', () => {
    const existing = `Head line.\n\n${note}\n\nTail line.\n`;
    const applied = applyAgentMeshNote(existing, fakeNote('OTHER'));
    expect(applied.content).toBe(`Head line.\n\n${fakeNote('OTHER')}\n\nTail line.\n`);
  });

  it('keeps one section when the user pasted a second copy', () => {
    const existing = `Own rules.\n\n${note}\n\n${note}\n`;
    const applied = applyAgentMeshNote(existing, note);
    expect(applied.status).toBe('replaced');
    expect(countAgentMeshSections(applied.content)).toBe(1);
    expect(applied.content.startsWith('Own rules.\n')).toBe(true);
    expect(applied.content.endsWith(`${note}\n`)).toBe(true);
  });

  it('a half-deleted section (start marker, no end) is replaced to the end of the file', () => {
    const existing = `Own rules.\n\n${AGENT_NOTE_START}\nleftover text to the end`;
    const applied = applyAgentMeshNote(existing, fakeNote('NOTE'));
    expect(applied.content).toBe(`Own rules.\n\n${fakeNote('NOTE')}`);
    expect(countAgentMeshSections(applied.content)).toBe(1);
  });

  it('preserves a CRLF file instead of rewriting all of it', () => {
    const existing = '# Rules\r\nWritten on Windows.\r\n';
    const applied = applyAgentMeshNote(existing, fakeNote('NOTE'));
    const crlfNote = fakeNote('NOTE').split('\n').join('\r\n');
    expect(applied.content).toBe(`# Rules\r\nWritten on Windows.\r\n\r\n${crlfNote}\r\n`);
    const again = applyAgentMeshNote(applied.content, fakeNote('NOTE'));
    expect(again.status).toBe('unchanged');
    expect(again.content).toBe(applied.content);
  });

  it('replacing a CRLF section writes CRLF again', () => {
    const existing = `Rules.\r\n\r\n${note.split('\n').join('\r\n')}\r\n`;
    const applied = applyAgentMeshNote(existing, fakeNote('NOTE'));
    expect(applied.content).toBe(`Rules.\r\n\r\n${fakeNote('NOTE').split('\n').join('\r\n')}\r\n`);
  });
});

describe('which files get the section', () => {
  it('creates AGENTS.md when neither exists', () => {
    expect(agentNoteTargetFiles([])).toEqual(['AGENTS.md']);
  });

  it('writes into every file that already exists', () => {
    expect(agentNoteTargetFiles(['CLAUDE.md'])).toEqual(['CLAUDE.md']);
    expect(agentNoteTargetFiles(['AGENTS.md', 'CLAUDE.md'])).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
    ]);
  });

  it('ignores other names', () => {
    expect(agentNoteTargetFiles(['README.md', 'FORGE.md'])).toEqual(['AGENTS.md']);
    expect([...AGENT_INSTRUCTION_FILE_NAMES]).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });
});
