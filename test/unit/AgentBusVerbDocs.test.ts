/**
 * The client's verbs have to be named in the two places a reader actually
 * looks, or a session that follows the shipped instruction still cannot use
 * them. `README.md` is the store page; `BUS_README` is the text Forge writes
 * into `~/.forge/agent-bus`, and the optional agent note tells a session to
 * read that file first. Surface H of the 2026-10-26 laptop audit found
 * `remote-ask` and `remote-notify` shipped in the client's own usage header
 * and named in neither place, so an agent told to "read the header" learned the
 * words and nothing about what they do, and `forge.sh wait` was in the store
 * page not at all.
 *
 * The expected set is derived at test time from `src/agentBus/forge.sh`'s
 * leading comment block — exactly the range `usage()` prints — because Forge
 * rewrites that file on every start and a hand-typed list would freeze the
 * count while the client grew.
 *
 * What this asserts, and what it does not: each verb has to appear as a
 * standalone word (`(^|[^A-Za-z0-9-])verb(?![A-Za-z0-9-])`) in both files. A
 * mention counts, inside a code span or not, and that is stated on purpose —
 * the guard's teeth are "add a verb to the header without naming it where
 * readers look and CI goes red", not "prove a paragraph explains it". Whether
 * a paragraph explains it is a human reading the diff.
 *
 * `CLAUDE.md` and `AGENTS.md` are deliberately NOT read here: they are
 * gitignored, so they are absent on a fresh checkout and a CI runner, and a
 * check against them would fail for a reason nobody can fix from the repo.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { BUS_README, CLIENT_SCRIPT } from '../../src/agentBus/busContent';
import { AGENT_NOTE_TEMPLATE } from '../../src/agentBus/agentMeshNote';

const root = path.resolve(__dirname, '..', '..');

/** The verbs `usage()` prints: the leading comment block up to its first
 *  non-comment line, read at test time because the client is rewritten on
 *  every start. */
function headerVerbs(): string[] {
  const lines = fs
    .readFileSync(path.join(root, 'src', 'agentBus', 'forge.sh'), 'utf8')
    .split('\n')
    .slice(1);
  const found = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('#')) break;
    const match = /^#\s+forge\.sh ([a-z][a-z-]*)\b/u.exec(line);
    if (match) found.add(match[1] as string);
  }
  return [...found].sort();
}

/** The flags in the usage header, derived from the same printed block. */
function headerFlags(): string[] {
  const lines = fs
    .readFileSync(path.join(root, 'src', 'agentBus', 'forge.sh'), 'utf8')
    .split('\n')
    .slice(1);
  const found = new Set<string>();
  for (const line of lines) {
    if (!line.startsWith('#')) break;
    for (const match of line.matchAll(/--[a-z][a-z-]*/gu)) found.add(match[0]);
  }
  return [...found].sort();
}

/** A verb counts only as its own word: `say` inside `says` is not a mention,
 *  and `read-verdict` must not be matched by a bare `verdict`. */
function namesTheVerb(text: string, verb: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9-])${verb}(?![A-Za-z0-9-])`, 'u').test(text);
}

function namesTheFlag(text: string, flag: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9-])${flag}(?![A-Za-z0-9-])`, 'u').test(text);
}

describe('every client verb is named where a reader looks', () => {
  const verbs = headerVerbs();
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

  it('has a header to derive from, and it is the client itself', () => {
    expect(verbs.length).toBeGreaterThan(10);
    // The three the audit found missing are pinned by name, so a rewrite of
    // the header that silently drops one of them is caught here as well as by
    // the documentation checks below.
    for (const verb of ['wait', 'remote-ask', 'remote-notify']) {
      expect(verbs, `forge.sh ${verb} is no longer in the usage header`).toContain(verb);
    }
  });

  it('names every one of them in the bus README Forge writes into ~/.forge', () => {
    const missing = verbs.filter((verb) => !namesTheVerb(BUS_README, verb));
    expect(
      missing.map((verb) => `~/.forge/agent-bus/README.md is silent about forge.sh ${verb}`),
    ).toEqual([]);
  });

  it('names every one of them on the store page', () => {
    const missing = verbs.filter((verb) => !namesTheVerb(readme, verb));
    expect(missing.map((verb) => `README.md is silent about forge.sh ${verb}`)).toEqual([]);
  });

  // The note Forge writes into a workspace's AGENTS.md / CLAUDE.md is the
  // third place a reader looks, and the only one a *future* agent session
  // reads by itself: the laptop audit's F9 finding was that a session with no
  // prior knowledge could not discover the bridge at all. Same rule as the two
  // above — the template is a constant, so this reads it exactly as written.
  it('names every one of them in the workspace agent note', () => {
    const missing = verbs.filter((verb) => !namesTheVerb(AGENT_NOTE_TEMPLATE, verb));
    expect(missing.map((verb) => `the agent note is silent about forge.sh ${verb}`)).toEqual([]);
  });
});

describe('every client flag is named in the bus README', () => {
  const flags = headerFlags();

  it('derives the say and send-file flags from the printed usage header', () => {
    expect(flags).toEqual([
      '--caption-file',
      '--force',
      '--model',
      '--new',
      '--reopen-claude',
      '--to',
      '--to-running',
    ]);
  });

  it('names every usage-header flag as its own flag in BUS_README', () => {
    const missing = flags.filter((flag) => !namesTheFlag(BUS_README, flag));
    expect(missing.map((flag) => `~/.forge/agent-bus/README.md is silent about ${flag}`)).toEqual(
      [],
    );
  });

  it('explains next-tool-round delivery and steer in the README and client header', () => {
    expect(BUS_README).toContain(
      'A `say` to a busy chat is read at its next tool round; its answer',
    );
    expect(CLIENT_SCRIPT).toContain(
      'A say to a busy chat is read at its next tool round; its answer arrives when the turn ends;',
    );
    expect(CLIENT_SCRIPT).toContain('A chat you start with --new runs in Clanker mode');
    expect(AGENT_NOTE_TEMPLATE).toContain(
      'A `say` to a busy chat is read at its next tool round; its answer arrives when',
    );
    expect(AGENT_NOTE_TEMPLATE).toContain(
      'the turn ends; use `steer` only to stop the current work.',
    );
  });

  it('keeps the agent-note reload verb exact', () => {
    expect(AGENT_NOTE_TEMPLATE.split('\n').find((line) => line.includes('reload <your-name>'))).toBe(
      '- `reload <your-name> --to <chat> [--reopen-claude <sessionId>]`: reload the VS Code window that holds that chat, so a newly installed VSIX takes effect; it refuses while a turn runs there unless you add `--force`; reopens that idle Claude Code session\'s tab after the reload; a watcher session must still message it awake.',
    );
  });

  it('ships the exact Claude reopen explanation in the README', () => {
    const start = BUS_README.indexOf('After a reload the Claude Code extension restores only a session that was');
    const end = BUS_README.indexOf('\nreload goes to the window', start);
    expect(BUS_README.slice(start, end)).toBe(
      'After a reload the Claude Code extension restores only a session that was\n' +
        "mid-turn; an idle session's tab stays closed and no message can reach it.\n" +
        '`--reopen-claude <sessionId>` makes Forge reopen that session\'s tab in the\n' +
        'reloaded window. Reopening does not wake it: another Claude session (a\n' +
        'watcher in a different window) must then send it a message, for example with\n' +
        'SendMessage once `ListAgents` lists it again. The session id stays the same\n' +
        'across reloads; its peer name and [ref] change.',
    );
  });

  it('detects a header flag removed from the README text', () => {
    const withoutModel = BUS_README.replaceAll('--model', '');
    expect(flags.filter((flag) => !namesTheFlag(withoutModel, flag))).toContain('--model');
  });

  it('explains each say flag, the file caption, and an owner approval wait', () => {
    expect(BUS_README).toContain('The new chat runs in Clanker mode');
    expect(BUS_README).toContain('--model <name>` selects the model');
    expect(BUS_README).toContain('--new` opens and links a second chat');
    expect(BUS_README).toContain('--to <conversationId>` selects one linked Forge chat');
    expect(BUS_README).toContain('--to-running` selects the currently running Forge chat');
    expect(BUS_README).toContain('--caption-file <file>');
    expect(BUS_README).toContain('supplies the Telegram caption text');
    expect(BUS_README).toContain(
      "it waits for the owner; `stop` or `steer`\ncancels that approval card.",
    );
  });
});
