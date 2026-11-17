/**
 * The agent note: the one marked section Forge writes into a workspace's
 * `AGENTS.md` and `CLAUDE.md` when the agent mesh is on.
 *
 * Why this exists at all (laptop audit 2026-10-26, F9): the mesh lets Claude
 * Code, Codex and Copilot message, steer and stop Forge chats, but the next
 * agent session cannot discover it. On the laptop the owner had to point Codex
 * at the bridge repeatedly, and Codex wrote its own `AGENTS.md` afterwards.
 * Once the mesh is on, the note is part of the feature rather than an
 * optional extra: without it the bridge is effectively unusable by an agent
 * that was never told about it.
 *
 * Everything here is pure text, so the three guarantees the owner will check
 * on a fresh folder are testable without VS Code: created when absent, added
 * beside existing text without touching that text, and never duplicated by a
 * second run. `src/vscode/agentMeshNoteSetup.ts` decides *which* files and
 * *when*; this module owns the section and its markers.
 */

import agentNoteText from './agentNote.md';

/** The section's boundaries. A user removes the note by deleting everything
 *  between these two comment lines; nothing outside them is ever touched. */
export const AGENT_NOTE_START = '<!-- forge-agent-mesh:start -->';
export const AGENT_NOTE_END = '<!-- forge-agent-mesh:end -->';

/** Per-install facts substituted into the template. Kept out of the template
 *  text so the template stays a constant the verb-drift test can read. */
export interface AgentMeshNoteFacts {
  /** Absolute path of the agent-bus folder Forge maintains (`~/.forge/agent-bus`). */
  busDir: string;
  /** Absolute path of the config file this window actually reads. */
  configPath: string;
  /** One line stating what is enabled, as the note should record it. */
  meshState: string;
}

const BUS_DIR_TOKEN = '__FORGE_BUS_DIR__';
const CONFIG_PATH_TOKEN = '__FORGE_CONFIG__';
const MESH_STATE_TOKEN = '__FORGE_MESH_STATE__';

/**
 * The note body, before the markers and before substitution.
 *
 * Static on purpose: `test/unit/AgentBusVerbDocs.test.ts` reads it to check
 * that every verb `forge.sh` prints in its usage header is named here, the
 * same guard that already covers `BUS_README` and `README.md`. A note
 * generated at runtime from the header would always agree with itself and
 * prove nothing.
 *
 * Contents are the F6 list: where the live reference is, the whole command
 * inventory, identity, model selection, accepted-vs-answered, the real state
 * and how to turn it off, the Windows prerequisite, and how to verify real
 * Forge execution instead of a model echo.
 */
export const AGENT_NOTE_TEMPLATE = agentNoteText;

/** The note as it should appear in a file: markers, body, markers. */
export function buildAgentMeshNote(facts: AgentMeshNoteFacts): string {
  const body = AGENT_NOTE_TEMPLATE.replaceAll(BUS_DIR_TOKEN, facts.busDir)
    .replaceAll(CONFIG_PATH_TOKEN, facts.configPath)
    .replaceAll(MESH_STATE_TOKEN, facts.meshState);
  return `${AGENT_NOTE_START}\n${body.trimEnd()}\n${AGENT_NOTE_END}`;
}

/** What a write did, so the caller can say it plainly instead of "saved". */
export type AgentMeshNoteApplyStatus = 'created' | 'appended' | 'replaced' | 'unchanged';

export interface AgentMeshNoteApplyResult {
  status: AgentMeshNoteApplyStatus;
  /** The full new file content; identical to `existing` when unchanged. */
  content: string;
}

interface Span {
  start: number;
  end: number;
}

/** Every complete section, as byte spans. A start marker with no end marker
 *  owns the rest of the file: the user's removal instruction is "delete
 *  everything between the markers", so a half-deleted section is already
 *  Forge's text to the end. */
function locateSections(content: string): Span[] {
  const spans: Span[] = [];
  let from = 0;
  for (;;) {
    const start = content.indexOf(AGENT_NOTE_START, from);
    if (start < 0) break;
    const end = content.indexOf(AGENT_NOTE_END, start + AGENT_NOTE_START.length);
    const stop = end < 0 ? content.length : end + AGENT_NOTE_END.length;
    spans.push({ start, end: stop });
    from = stop;
  }
  return spans;
}

/** How many sections a document holds — the guard against a duplicated note. */
export function countAgentMeshSections(content: string): number {
  return locateSections(content).length;
}

/**
 * Put the note in one file without touching anything else in it.
 *
 * `existing` is undefined when the file does not exist. The line ending of the
 * existing file is preserved: a CRLF `AGENTS.md` is a Windows file its owner
 * committed, and rewriting every line of it to LF to insert one section would
 * show up as a whole-file diff.
 *
 * When the document holds more than one section (a hand-made copy, or a paste
 * of the same note), the first is replaced in place and the rest are dropped:
 * the invariant is one section, and everything outside a section is the user's.
 */
export function applyAgentMeshNote(
  existing: string | undefined,
  note: string,
): AgentMeshNoteApplyResult {
  if (existing === undefined) return { status: 'created', content: `${note}\n` };

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const noteInFileEnding = note.split('\n').join(eol);
  const spans = locateSections(existing);

  if (!spans.length) {
    const separator = existing.endsWith(eol) ? eol : `${eol}${eol}`;
    return {
      status: 'appended',
      content: `${existing}${separator}${noteInFileEnding}${eol}`,
    };
  }

  const rebuilt: string[] = [];
  let cursor = 0;
  for (const [index, span] of spans.entries()) {
    rebuilt.push(existing.slice(cursor, span.start));
    if (index === 0) rebuilt.push(noteInFileEnding);
    // Any later section is dropped, together with the blank lines that
    // separated it from the previous one, so the file does not grow gaps.
    cursor = span.end;
    if (index === 0 && spans.length > 1) {
      while (existing.startsWith(eol, cursor)) cursor += eol.length;
    }
  }
  rebuilt.push(existing.slice(cursor));
  const content = rebuilt.join('');
  return {
    status: content === existing ? 'unchanged' : 'replaced',
    content,
  };
}

/** The two file names agent CLIs read, in the order the note should consider them. */
export const AGENT_INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * The one line that makes a `CLAUDE.md` import the workspace's `AGENTS.md`:
 * Claude Code expands an `@file` line into the context it is given, so the
 * section Forge writes into `AGENTS.md` reaches a Claude Code session through
 * it. Forge recognises only the line on its own — Claude Code also accepts a
 * path with a directory or a glob, and `@AGENTS.md` alone is the whole of what
 * Forge writes, so that is the whole of what Forge reads back.
 */
export const AGENTS_MD_IMPORT_LINE = '@AGENTS.md';

/** Does this content already import `AGENTS.md` on a line of its own? A mention
 *  inside a sentence does not count: only a line Claude Code would act on. */
export function hasAgentsMdImportLine(content: string): boolean {
  return content.split(/\r?\n/u).some((line) => line.trim() === AGENTS_MD_IMPORT_LINE);
}

/** The whole content of a `CLAUDE.md` Forge creates: the import line, one
 *  newline, nothing else, no markers. Writing the section into that file as
 *  well would put the same 9 KB into Claude Code's context twice. */
export const AGENTS_MD_IMPORT_FILE_CONTENT = `${AGENTS_MD_IMPORT_LINE}\n`;

/** One file in the install plan: which file, and what is written into it. */
export interface AgentNoteTarget {
  name: (typeof AGENT_INSTRUCTION_FILE_NAMES)[number];
  /** `section`: the marked note. `import`: a created `CLAUDE.md` holding only
   *  the `@AGENTS.md` line, which is how a file Forge creates reaches Claude. */
  write: 'section' | 'import';
}

/**
 * Which files the note goes into, given what already exists in one root.
 *
 * Claude Code reads `CLAUDE.md`, and since v2.1.277 reads `AGENTS.md` only when
 * no `CLAUDE.md` is in scope — so a note in `AGENTS.md` alone is invisible to a
 * Claude Code session in a repository that has a `CLAUDE.md`. Codex and Copilot
 * read `AGENTS.md`. So `AGENTS.md` always takes the section (it is created when
 * missing, which is what Codex reads), and an existing `CLAUDE.md` takes it too,
 * because that is the file its agent actually reads.
 *
 * A `CLAUDE.md` that does not exist is created holding only `@AGENTS.md`: the
 * import reaches the section sitting in `AGENTS.md`, and a second copy of the
 * 9 KB body in the same file would double Claude's context for nothing. An
 * existing `CLAUDE.md` that already carries that line is left completely alone
 * — it gets the note through its own import, and appending a section to it
 * would duplicate the text.
 *
 * `claudeHasImportLine` is whether an existing `CLAUDE.md` holds that line
 * (`hasAgentsMdImportLine`); it means nothing when there is no `CLAUDE.md`.
 */
export function agentNoteTargetFiles(
  existingNames: readonly string[],
  claudeHasImportLine: boolean,
): AgentNoteTarget[] {
  const plan: AgentNoteTarget[] = [{ name: 'AGENTS.md', write: 'section' }];
  if (!existingNames.includes('CLAUDE.md')) {
    plan.push({ name: 'CLAUDE.md', write: 'import' });
  } else if (!claudeHasImportLine) {
    plan.push({ name: 'CLAUDE.md', write: 'section' });
  }
  return plan;
}
