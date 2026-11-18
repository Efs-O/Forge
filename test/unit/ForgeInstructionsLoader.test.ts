import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import starterContent from '../../resources/instructions/FORGE.starter.md';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: undefined,
    createFileSystemWatcher: vi.fn(),
    RelativePattern: vi.fn(),
  },
  extensions: { getExtension: vi.fn() },
  window: { showWarningMessage: vi.fn() },
}));

import {
  discoverWorkspaceRepositoryRoots,
  ensureForgeInstructionsFile,
  ForgeInstructionsLoader,
} from '../../src/llm/ForgeInstructionsLoader';
import { MAX_INSTRUCTION_BYTES } from '../../src/llm/forgeInstructionsChain';
import { AGENT_NOTE_TEMPLATE } from '../../src/agentBus/agentMeshNote';

const roots: string[] = [];

describe('shipped Markdown instruction text', () => {
  it('matches the original note and starter bytes and the instruction budget', () => {
    const noteBeforeMove = fs.readFileSync(
      path.join(__dirname, '../fixtures/instruction-baselines/agentNote.md'),
      'utf8',
    );
    const starterBeforeMove = fs.readFileSync(
      path.join(__dirname, '../fixtures/instruction-baselines/forgeStarter.md'),
      'utf8',
    );

    expect(AGENT_NOTE_TEMPLATE).toBe(noteBeforeMove);
    expect(starterContent).toBe(starterBeforeMove);
    expect(starterContent).toContain(MAX_INSTRUCTION_BYTES.toLocaleString('en-US'));
  });
});

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-instructions-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('ensureForgeInstructionsFile', () => {
  it('creates a small FORGE.md starter in a repository without one', () => {
    const root = makeRoot();

    const result = ensureForgeInstructionsFile(root);

    expect(result.status).toBe('created');
    const content = fs.readFileSync(path.join(root, 'FORGE.md'), 'utf8');
    expect(content).toContain('# Project Instructions');
    expect(content).not.toContain('exec_command');
    expect(content).toContain('reusing its suggested_next_wait_ms (each call waits up to 60 s)');
    expect(content).toContain('instead of polling in short steps');
    // The starter is paid on EVERY turn in EVERY new workspace, so its size is
    // the budget, not a loose sanity number. Measured 2026-10-27: 3,293 bytes
    // before lane 5.2, 4,557 after the eight review items and the changelog
    // blank were added (docs/plans/V1_FINISH_PLAN.md phase 5.2), which is about
    // 273 tokens at the ~4.62 chars/token ratio the tool-schema budget test
    // uses — inside the ~300 tokens the owner accepted. 4,700 is that
    // measurement plus a little slack, so growth is noticed when it is added.
    // 2026-10-30: 4,725 bytes after the notify_on_exit rewording of the waiting
    // line. The flag is on by default for a background command, so the line no
    // longer tells the agent to pass it: it says to start the command in the
    // background, tell the user what is being waited for, end the turn or work
    // on something else, and let the exit notice arrive on its own — an agent
    // that forgot the flag spent four model rounds polling a job that would have
    // woken it by itself. The cap is 4,800, 75 bytes of slack, so the next
    // growth is still noticed when it is added.
    // 2026-10-30, merge of docs/tool-traps-sync: 5,398 bytes. The instruction-
    // file sync added three general rules (acceptance criteria per plan,
    // separate worktrees for overlapping lanes, the durable-state ledger) on
    // top of the 4,725 above. Cap 5,475 keeps the same 75 bytes of slack.
    // 2026-10-31: 5,889 bytes. "Remembering past sessions" gained a second
    // rule: read the record a screen symptom is drawn from (Forge's own state
    // under ~/.forge/, a config field) before grepping the logs, then git log
    // for the commit that changed it, whose message is usually the diagnosis;
    // search mechanism words, not symptom phrasing. An agent that grepped for
    // the symptom spent fourteen rounds on a discussion that the job state file
    // and that commit message each named outright. 46 bytes came back out of
    // the waiting line. Cap 5,964 keeps the same 75 bytes of slack.
    // 2026-11-05: 6,260 bytes. "Asking the user" carries the general version of
    // the question-card rule this repository's FORGE.md gained the same day:
    // a choice between fixed answers goes on an ask_user card, not a numbered
    // list, except in an unattended run. Cap 6,335 keeps the same 75 bytes.
    // 2026-11-12: 6,377 bytes. The instruction audit found one general rule the
    // starter lacked: never swallow an error or hide bad config behind a silent
    // fallback. Cap 6,452 keeps the same 75 bytes.
    // 2026-11-17: 9,082 bytes. Owner: a new workspace's starter carries every general
    // rule of this repository's FORGE.md (laptop fresh-install test): recording mistakes
    // in the tips table, refused tool arguments, gate logs, the push rule. Cap 9,157.
    // 2026-11-18: 9,211 bytes. The tips rule names `## FORGE_TOOLS`, where a Forge-tool
    // mistake goes (the tool's tips move into its description). Cap 9,286.
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(9286);
  });

  it('carries the review items that took this repo to 0.8% failed calls', () => {
    const root = makeRoot();
    expect(ensureForgeInstructionsFile(root).status).toBe('created');
    const content = fs.readFileSync(path.join(root, 'FORGE.md'), 'utf8');
    // (a) and (b): the two questions this repo's reviews kept failing on.
    expect(content).toMatch(/what cancels it .* test that path/u);
    expect(content).toMatch(/right session, chat or sender/u);
    // (c) the line cap, checked while editing rather than at the end of the turn.
    expect(content).toMatch(/`wc -l`/u);
    expect(content).toContain('real seam before the cap');
    // (d) and (e): plan documents that disagree with the code, and durable state.
    expect(content).toContain('acceptance criteria disagree with the code');
    expect(content).toMatch(/outlives its turn/u);
    expect(content).toMatch(/create, delete, pause or disable, crash mid-write, owner-process death, and expiry/u);
    expect(content).toContain('a file, a registry entry, a config field, a lease, a queue item');
    // (f), (g), (h): one owner per concern, an audit's scope, and "reply only".
    expect(content).toContain('already owns a concern');
    expect(content).toContain('every reference to it');
    expect(content).toContain('commit range and the baseline');
    expect(content).toMatch(/"reply only".*no tool calls/u);
    // The changelog line is a blank to fill in, not a rule: it ends at its
    // colon, so a new workspace still has to say which file its changelog is.
    expect(content).toContain(
      '\n- Changelog (update it in the same change as a version bump):\n',
    );
  });

  it('creates FORGE.md beside an AGENTS.md and leaves the AGENTS.md alone', () => {
    const root = makeRoot();
    const agents = path.join(root, 'AGENTS.md');
    fs.writeFileSync(agents, '# Codex instructions\n', 'utf8');

    const result = ensureForgeInstructionsFile(root);

    expect(result.status).toBe('created');
    expect(fs.readFileSync(agents, 'utf8')).toBe('# Codex instructions\n');
    expect(result.path).toBe(path.join(root, 'FORGE.md'));
  });
});

describe('ForgeInstructionsLoader', () => {
  it('loads the FORGE.md belonging to the target nested repository', () => {
    const root = makeRoot();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    fs.mkdirSync(path.join(nested, 'src'));
    fs.writeFileSync(path.join(root, 'FORGE.md'), '# Workspace instructions\n', 'utf8');
    fs.writeFileSync(path.join(nested, 'FORGE.md'), '# Nested instructions\n', 'utf8');
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructions).toBe('# Workspace instructions\n');
    expect(loader.instructionsFor(path.join(nested, 'src', 'a.ts'))).toBe(
      '# Nested instructions\n',
    );
    loader.dispose();
  });

  it('never reads AGENTS.md, even where no FORGE.md exists', () => {
    const root = makeRoot();
    const nested = path.join(root, 'nested');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Root Codex instructions\n', 'utf8');
    fs.writeFileSync(path.join(nested, 'AGENTS.md'), '# Nested Codex instructions\n', 'utf8');
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructions).toBeUndefined();
    expect(loader.instructionsFor(path.join(nested, 'new.ts'))).toBeUndefined();
    loader.dispose();
  });

  it('warns once when a rendered instruction file reaches 90% of the byte budget', () => {
    const root = makeRoot();
    const file = path.join(root, 'FORGE.md');
    const content = 'a'.repeat(MAX_INSTRUCTION_BYTES - 4_000);
    fs.writeFileSync(file, content, 'utf8');
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructions).toBe(content);
    expect(loader.instructions).toBe(content);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('FORGE.md'),
    );
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        `${(MAX_INSTRUCTION_BYTES - 4_000).toLocaleString('en-US')} of ${MAX_INSTRUCTION_BYTES.toLocaleString(
          'en-US',
        )} bytes`,
      ),
    );
    loader.dispose();
  });

  it('does not warn below 90% of the byte budget', () => {
    const root = makeRoot();
    const below = Math.floor(MAX_INSTRUCTION_BYTES * 0.8);
    fs.writeFileSync(path.join(root, 'FORGE.md'), 'a'.repeat(below), 'utf8');
    const loader = new ForgeInstructionsLoader(root);

    expect(loader.instructions).toHaveLength(below);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    loader.dispose();
  });
});

describe('discoverWorkspaceRepositoryRoots', () => {
  it('returns every Git repository discovered inside the workspace', async () => {
    const root = makeRoot();
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    fs.mkdirSync(first);
    fs.mkdirSync(second);
    vi.mocked(vscode.extensions.getExtension).mockReturnValue({
      isActive: true,
      exports: {
        getAPI: () => ({
          repositories: [{ rootUri: { fsPath: first } }, { rootUri: { fsPath: second } }],
        }),
      },
    } as never);

    await expect(discoverWorkspaceRepositoryRoots(root)).resolves.toEqual([first, second]);
  });
});
