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
export const AGENT_NOTE_TEMPLATE = `## Forge agent bus

Workspace memories are editable files in \`~/.forge/memories/<workspace-folder>-<workspace-id>/\`; changes take effect on the next read.

Forge LLM is installed in this machine's VS Code, and its agent mesh is on: a local
coding agent can message, steer and stop a Forge chat, and read what one is doing.
That means agents other than you can act in this workspace — the last line says how to
turn it off.

**Read before first use:** \`__FORGE_BUS_DIR__/README.md\` (what each command returns,
and what it does not), and the usage header of \`__FORGE_BUS_DIR__/forge.sh\` — running
it with no arguments prints that header. Do not guess a verb; there is no \`join\`.

**Identity, not a name.** Forge identifies the sending session from its own environment:
Claude Code \`CLAUDE_CODE_SESSION_ID\`, Codex \`CODEX_SESSION_ID\`, Copilot
\`COPILOT_AGENT_SESSION_ID\`. The client refuses to send when that variable is unset, so
an empty \`who\` is normal before any session is linked.

**The verbs** — \`<your-name>\` is \`claude\`, \`codex\` or \`copilot\`:

- \`who\`: the linked agent sessions open Forge windows hold.
- \`say <your-name> [--model <name>] [--new] [--unattended] [--to <chat>|--to-running]\`:
  message Forge. \`--model\` picks the model explicitly; \`--new\` starts and links a
  second chat, so the first keeps its link; \`--to <chat>\` picks any chat this
  session is linked to, or links an open chat that holds none. \`--new\` needs a free
  chat tab: at the window's chat cap the client exits non-zero with a 409 naming what
  holds every tab, and your message is **not** queued — close a chat and send again, or
  send it without \`--new\`. \`--to-running\`
  picks the currently running chat. \`--unattended\` means nobody is watching:
  dangerous tools are refused at once with a reason instead of opening an approval
  card that would hang the turn; any other action that needs approval is refused
  too unless its approval key is listed in \`approvals.unattended_bus.allow\` in
  \`~/.forge/policy.yaml\` (the refusal names the key); only a confirmation with no
  approval key is approved automatically. Use it whenever the owner may be away.
  A \`say\` to a busy chat is read at its next tool round, and the answer arrives
  when that turn ends; one
  with \`--unattended\`, \`--model\` or \`--new\` waits for that turn to end.
- \`send <your-name> <to>\`: relay to another agent (\`<to>\` may be \`forge\` to target a
  Forge chat). \`send-file <your-name> --to <chat> <path> [--caption-file <file>]\`
  sends a file to its Telegram chat without a model turn; \`--caption-file\` reads
  the Telegram caption text from that file.
- \`steer <your-name> <to>\`: when \`<to>\` is \`forge\`, it stops that chat's running turn
  and runs your text next. A \`say\` to a busy chat is read at its next tool round; its answer arrives when
  the turn ends; use \`steer\` only to stop the current work. When \`<to>\` is \`claude\`, \`codex\` or \`copilot\`, it withdraws
  what this chat already asked that agent and asks this instead — Forge cannot interrupt
  an agent session the owner has open in a terminal.
- \`stop <your-name> [--to <chat>]\`: cancel a running Forge turn; queued messages may
  still start. \`cancel <your-name> <id|all>\`: withdraw your queued messages.
- \`reload <your-name> --to <chat> [--reopen-claude <sessionId>]\`: reload the VS Code window that holds that chat, so a newly installed VSIX takes effect; it refuses while a turn runs there unless you add \`--force\`; reopens that idle Claude Code session's tab after the reload; a watcher session must still message it awake.
- \`status <your-name>\`: what your Forge chat is doing now — before your first message
  has started it answers \`State: queued\` with how many of your messages are waiting,
  which is normal, not an error. \`view <your-name> [n]\`: its last answers; it refuses
  until your first answer exists. \`wait <your-name> [minutes]\`: block until it is idle
  with nothing queued.
- \`reply <id> [file]\`: answer a question Forge is waiting on.
- \`read-verdict <your-name> <exchangeId>\` and \`ack-verdict <your-name> <exchangeId>\`:
  read a retained answer, then remove its retained copy.
- \`remote-notify <claude|codex|copilot> <exchangeId>\` and \`remote-ask\` for the same:
  message the Telegram chat that opened this exchange; \`remote-ask\` waits for an answer.

**Accepted is not answered.** A \`202\` only means the message was queued or the exchange
started. Read the outcome back with \`view\`, \`wait\` or \`read-verdict\` before telling
anyone it worked.

**Verify real Forge execution.** Confirm the result in the Forge chat (\`view\`) or in the
workspace (\`git status\`, the file, the test output). A direct HTTP call to the control
server proves the endpoint answers, not that a Forge chat ran the tool.

**Windows.** \`forge.sh\` is a bash script and VS Code ships no bash on Windows. Find Git
Bash first: \`Get-Command git.exe\`, then \`& "$(git --exec-path)/../../../bin/bash.exe"\`
(\`C:\\Program Files\\Git\\bin\\bash.exe\` for an all-users install). Run the client through
that path. If Git for Windows is absent, say so plainly and offer
\`winget install --id Git.Git -e\`; never fall back to bare \`bash\`, which on Windows may be
WSL, whose \`$HOME\` is not the profile holding this folder.

**Who does what.** Forge exists so that the bulk of the work runs on the owner's local
model instead of Claude or Codex subscription usage. If you are a CLI agent (Claude Code,
Codex, Copilot), your job here is planning, advice and review; delegate the implementing:

- Write the plan (task, files, acceptance criteria), send it to a fresh Forge chat per
  lane (\`say <your-name> --new --model <name>\`), then review the diff strictly. Send
  defects back with file and line rather than rewriting the code yourself.
- Verify a brief before you send it: check every claim against the code, write out any
  exact text the result must produce, list what a changed check must still allow, and
  ask for pasted output rather than a description. Each vague direction costs a round.
- Local models implement well but plan and recall less well, so plans, reviews and
  design questions stay with you. Advise a Forge chat when it asks.
- A local engine serves only so many chats at full speed — the number is the engine's
  parallel slot count (\`n_parallel\` for llama.cpp), and your config rarely says it, so
  ask the owner what it is; one chat beyond that number slows every lane.
- When the Forge lanes are full, hand the next implementation to another CLI agent (for
  example \`codex exec\`) in its own git worktree. An extra Forge lane is for something
  very small only. You own a worktree you created: when its branch is merged or
  abandoned, remove it then, not at the end — \`git worktree remove "<path>"\` one call
  at a time with a timeout of at least 600 s, then \`git branch -d\` and
  \`git worktree prune\`; never \`--force\`, and ask the owner if it holds uncommitted work.
- Implement yourself only a trivial fix, or when the owner asks you to.
- These rules are for the agent the owner talks to. If another agent handed you the
  task (a Forge chat, or a \`codex exec\` or \`claude -p\` it started), you are the
  implementer: do the work yourself. Ask that agent before you open or message a Forge
  chat, start another agent, or load or stop a model. When you cannot ask, skip the
  operation and say so in your report.

**State, as Forge recorded it when this section was written:** __FORGE_MESH_STATE__
Config: \`__FORGE_CONFIG__\`. \`agent_bus: { enabled: false }\` there stops agents from
messaging Forge; \`control_server.enabled\` is what the client connects to. The
settings that say what an agent may do live in \`~/.forge/policy.yaml\`, which no
agent may write, and a policy key — or a model naming its own \`start_command\` —
left in the config file above makes Forge refuse to load it. Moving them is the
owner's command, \`Forge: Move security settings to policy.yaml\`, not yours.

Approval rules are separate from permission settings. A card's **Allow for this
chat** button remembers only the displayed action for that conversation;
\`/approvals\` lists its rules and matching project rules, and \`/approvals reset\`
clears only that chat's remembered rules. **Always in this project** is an owner
button that writes \`approvals.always\` through Forge; it is not a tool, and no
agent tool can write \`policy.yaml\`. If the file is locked, the project rule is
not saved and the approval stays chat-only. Jobs and \`--unattended\` bus turns
have no card and use only \`approvals.jobs.<id>.allow\` or
\`approvals.unattended_bus.allow\`; an unmatched refusal names the exact policy
line, so report it to the owner instead of retrying. The owner may set
\`permissions.approval_timeout_minutes\`: a new install ships 10 minutes, and a
config with no key still waits forever.

This section belongs to Forge: keep your own rules outside these two comment lines, and
to remove the note delete everything between them. Forge refreshes this section when its
own text changes, and never re-adds it once you have deleted it; to put it back, run
**Forge: Set Up Agent Note**.
`;

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
 * Which files the note goes into, given what already exists in one root.
 *
 * Claude Code reads `CLAUDE.md`, and since v2.1.277 reads `AGENTS.md` only when
 * no `CLAUDE.md` is in scope — so a note in `AGENTS.md` alone is invisible to a
 * Claude Code session in a repository that has a `CLAUDE.md`. Codex and Copilot
 * read `AGENTS.md`. Hence: every one of the two that exists gets the section
 * (each agent then finds it in the file it actually reads); neither exists, so
 * only `AGENTS.md` is created, which serves Codex directly and Claude Code for
 * want of a `CLAUDE.md`.
 */
export function agentNoteTargetFiles(
  existingNames: readonly string[],
): (typeof AGENT_INSTRUCTION_FILE_NAMES)[number][] {
  const present = AGENT_INSTRUCTION_FILE_NAMES.filter((name) => existingNames.includes(name));
  return present.length ? present : ['AGENTS.md'];
}
