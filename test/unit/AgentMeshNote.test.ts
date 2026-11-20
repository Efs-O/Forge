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
  AGENT_NOTE_TEMPLATE,
  agentNoteTargetFiles,
  applyAgentMeshNote,
  buildAgentMeshNote,
  countAgentMeshSections,
  hasAgentsMdImportLine,
  removeAgentMeshSections,
  NOTE_STATE_ANCHOR,
  WHO_DOES_WHAT_ANCHOR,
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

  it('explains Clanker for new chats and busy-chat turn-end behavior', () => {
    expect(note).toContain('A chat you start with `--new` runs in Clanker');
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

  it('starts every copy with the guard line', () => {
    // A note left behind when Forge is uninstalled used to send every agent to
    // a `forge.sh` that is gone. The first body line of every copy, in both
    // scopes, names that copy's own path and tells the agent to skip the rest.
    const guardFacts: AgentMeshNoteFacts = { ...facts, busDir: 'C:/Users/t/.forge/agent-bus' };
    for (const scope of ['workspace', 'user'] as const) {
      const lines = buildAgentMeshNote(guardFacts, scope).split('\n');
      expect(lines[0]).toBe(AGENT_NOTE_START);
      expect(lines[1]).toBe('## Forge agent bus');
      expect(lines[2]).toBe('');
      expect(lines[3]).toBe(
        'If `C:/Users/t/.forge/agent-bus/forge.sh` does not exist, ignore this section.',
      );
    }
  });

  it('leaves Who does what out of the user-wide copy only', () => {
    // The user-wide copy is read by every Claude Code / Codex session on the
    // machine, including ones in folders Forge never touched, where a
    // delegation policy for this owner's local lanes is not the reader's call.
    const user = buildAgentMeshNote(facts, 'user');
    expect(user).not.toContain('Who does what');
    expect(user).not.toContain('delegate the implementing');
    expect(user).toContain(NOTE_STATE_ANCHOR);
    expect(user).toContain('**Windows.**');
    // The workspace copy keeps the policy and everything around it.
    expect(note).toContain('Who does what');
    expect(note).toContain('delegate the implementing');
    expect(note).toContain(NOTE_STATE_ANCHOR);
    expect(note).toContain('**Windows.**');
  });

  it('refuses a user copy that kept any line of the delegation list', () => {
    // Not just the heading: a single surviving bullet would still read as a
    // standing instruction to hand the work to a Forge chat.
    expect(buildAgentMeshNote(facts, 'user')).not.toContain('fresh Forge chat per');
  });

  it('keeps every verb in the user-wide copy: cutting the policy cuts no commands', () => {
    const user = buildAgentMeshNote(facts, 'user');
    for (const verb of [
      'say <your-name>',
      'send <your-name>',
      'reply <id>',
      'steer <your-name>',
      'stop <your-name>',
    ]) {
      expect(user).toContain(verb);
    }
  });

  it('still carries both anchors the user-wide cut runs between', () => {
    // Without them the cut cannot find its own bounds: buildAgentMeshNote
    // throws rather than write a note with a chunk of it missing.
    expect(AGENT_NOTE_TEMPLATE).toContain(WHO_DOES_WHAT_ANCHOR);
    expect(AGENT_NOTE_TEMPLATE).toContain(NOTE_STATE_ANCHOR);
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

/**
 * Taking the note out again — the mesh-off path and the uninstall both call
 * this, and the guarantee they are judged by is that it gives back exactly the
 * file as it was before the note went in: nothing the owner wrote is touched,
 * and the blank line Forge added when it appended goes with the section.
 */
describe('taking the note back out of a file', () => {
  const noteCrlf = note.split('\n').join('\r\n');

  it('removes a section appended below the owner text, and the blank line above it', () => {
    const result = removeAgentMeshSections(`own\n\n${note}\n`);
    expect(result.status).toBe('removed');
    expect(result.content).toBe('own\n');
  });

  it('empties a file that held nothing but the section', () => {
    const result = removeAgentMeshSections(`${note}\n`);
    expect(result.status).toBe('removed');
    expect(result.content).toBe('');
  });

  it('keeps text on both sides of the section, with one blank line between them', () => {
    const result = removeAgentMeshSections(`a\n\n${note}\n\nb\n`);
    expect(result.status).toBe('removed');
    expect(result.content).toBe('a\n\nb\n');
  });

  it('removes a section from a CRLF file without rewriting its line endings', () => {
    const result = removeAgentMeshSections(`own\r\n\r\n${noteCrlf}\r\n`);
    expect(result.status).toBe('removed');
    expect(result.content).toBe('own\r\n');
  });

  it('gives back exactly what applyAgentMeshNote started from', () => {
    for (const original of ['own\n', 'a\n\nb\n', 'own\r\n']) {
      const applied = applyAgentMeshNote(original, note).content;
      expect(removeAgentMeshSections(applied).content).toBe(original);
    }
  });

  it('reports a file that never held a marker and does not touch it', () => {
    const content = '# Mine\nNo Forge text here.\n';
    const result = removeAgentMeshSections(content);
    expect(result.status).toBe('none');
    expect(result.content).toBe(content);
  });

  it('refuses to guess where a torn section ends: a start with no end', () => {
    const content = `own\n\n${AGENT_NOTE_START}\nleftover text to the end`;
    const result = removeAgentMeshSections(content);
    expect(result.status).toBe('lone-marker');
    expect(result.content).toBe(content);
  });

  it('refuses to guess past an end marker that is outside every section', () => {
    for (const content of [`${AGENT_NOTE_END}\n`, `${note}\n\n${AGENT_NOTE_END}\n`]) {
      const result = removeAgentMeshSections(content);
      expect(result.status).toBe('lone-marker');
      expect(result.content).toBe(content);
    }
  });

  it('removes every copy when the owner pasted the section twice', () => {
    const result = removeAgentMeshSections(`own\n\n${note}\n\n${note}\n`);
    expect(result.status).toBe('removed');
    expect(result.content).toBe('own\n');
  });
});

describe('which files get the section', () => {
  const section = { name: 'AGENTS.md', write: 'section' } as const;
  const importOnly = { name: 'CLAUDE.md', write: 'import' } as const;
  const claudeSection = { name: 'CLAUDE.md', write: 'section' } as const;

  it('neither file exists: AGENTS.md gets the section, CLAUDE.md is created as the import', () => {
    expect(agentNoteTargetFiles([], false)).toEqual([section, importOnly]);
  });

  it('only AGENTS.md: the section goes there, CLAUDE.md is created as the import', () => {
    expect(agentNoteTargetFiles(['AGENTS.md'], false)).toEqual([section, importOnly]);
  });

  it('only CLAUDE.md, without the import line: AGENTS.md is created with the section, and so is that file', () => {
    expect(agentNoteTargetFiles(['CLAUDE.md'], false)).toEqual([section, claudeSection]);
  });

  it('only CLAUDE.md, and it already imports AGENTS.md: that file is left out of the plan', () => {
    expect(agentNoteTargetFiles(['CLAUDE.md'], true)).toEqual([section]);
  });

  it('both files: the same two decisions about CLAUDE.md', () => {
    expect(agentNoteTargetFiles(['AGENTS.md', 'CLAUDE.md'], false)).toEqual([
      section,
      claudeSection,
    ]);
    expect(agentNoteTargetFiles(['AGENTS.md', 'CLAUDE.md'], true)).toEqual([section]);
  });

  it('ignores other names', () => {
    expect(agentNoteTargetFiles(['README.md', 'FORGE.md'], false)).toEqual([section, importOnly]);
    expect([...AGENT_INSTRUCTION_FILE_NAMES]).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('recognises the import line only as a line of its own', () => {
    expect(hasAgentsMdImportLine('@AGENTS.md\n')).toBe(true);
    expect(hasAgentsMdImportLine('# Mine\r\n\n@AGENTS.md\r\n')).toBe(true);
    expect(hasAgentsMdImportLine('Rules say to read `@AGENTS.md` first.\n')).toBe(false);
    expect(hasAgentsMdImportLine('')).toBe(false);
  });
});
