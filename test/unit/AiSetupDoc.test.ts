/**
 * AI_SETUP.md is read by the user's Claude Code / Codex, which follows it
 * literally. A command id, config key or shipped path that stops existing turns
 * into a setup that fails on a stranger's machine where nobody from this repo is
 * watching — so every name the file uses is checked against the source of truth.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ForgeConfigSchema } from '../../src/config/schema';
import { JobSchema } from '../../src/jobs/jobSchema';
import { agentSetupPrompt } from '../../src/vscode/agentSetupCommand';
import { isPartialExample, validateConfigExample, yamlBlocks } from '../support/docConfigExamples';

const root = path.resolve(__dirname, '..', '..');
const doc = fs.readFileSync(path.join(root, 'AI_SETUP.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[] };
};

describe('AI_SETUP.md', () => {
  it('requests one plan confirmation and automates the rest of the chosen setup', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(doc.match(/Proceed with this setup plan/g)).toHaveLength(1);
    expect(text).toContain('offer only the optional items listed in Step 0, in that one question');
    expect(text).toContain('do not ask the user to choose');
    expect(text).toContain('every model file and release archive');
    expect(text).toContain('the selected llama.cpp build');
    expect(text).toContain('any missing selected CLI and its prerequisites');
    expect(text).toContain('Never ask the user to install it');
    expect(text).not.toContain('the user installs the CLI');
    expect(text).toContain('Stop for the login only');
    expect(text).toContain('winget install --id Git.Git -e');
    expect(text).toContain('permissions.agents.delegate');
    expect(text).toContain('crossSessionInbound');
    expect(text).toContain('the exact config file path to write');
    expect(text).toContain('resources/instructions/FORGE.starter.md');
    expect(text).toContain('`FORGE.md` files are left untouched.');
    expect(text).toContain('not ask them to run **Forge: Validate Config**');
    expect(text).toContain('do not ask the user to send one');
    expect(text).toContain('ControlServerRecord.url');
    expect(text).toContain('If `LOCALAPPDATA` is unset');
  });

  // Step 0 is the only place the user can say yes to an optional section, so
  // the offers have to be in that one question: an agent that cannot ask a
  // second question would otherwise set up only what the user happened to name
  // in their first message.
  it('offers the five optional items in the one Step 0 question', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'Proceed with this setup plan? Answer yes/no, and yes/no for each optional item.',
    );
    expect(text).toContain(
      'Telegram: control Forge from your phone over Telegram (needs your own bot ' +
        'from @BotFather; a second computer needs its own bot).',
    );
    expect(text).toContain(
      "Other computer: use models from another computer of yours, or share this one's (Tailscale).",
    );
    expect(text).toContain(
      'Daily chat retitle: rename idle chats each morning to titles that say what they were about.',
    );
    expect(text).toContain(
      "User files: put Forge's agent note in your own `~/.claude/CLAUDE.md` and " +
        '`~/.codex/AGENTS.md` too, so Claude Code and Codex reach Forge from any folder.',
    );
    expect(text).toContain(
      'tell the user to run **Forge: Add Agent Note to My User Files** ' +
        '(`forge.agentMesh.installUserNote`)',
    );
    expect(text).toContain(
      'a missing `CLAUDE.md` is created holding only that import line',
    );
    expect(text).toContain(
      'Git identity, only when the survey found `user.name` or `user.email` empty: ' +
        'the name and email to put on your commits (leave it blank to skip).',
    );
  });

  it('gates each optional step on the Step 0 answer and keeps the agent out of the user\u2019s network', () => {
    const text = doc.replace(/\s+/gu, ' ');
    expect(text).toContain(
      'Run this section only when the user\'s setup request names Telegram or the user ' +
        'said yes to Telegram in Step 0. Do not ask about it again.',
    );
    expect(text).toContain(
      'You may run only `tailscale status`, which reads and changes nothing.',
    );
    expect(text).toContain(
      '{"action": "accept", "src": ["<this computer or your user>"], "dst": ["<main computer>:8797,8798"]}',
    );
    // The policy move must be the last step: once policy.yaml exists, a
    // config.yaml still holding a security key is refused, so any later config
    // edit would break the setup it just checked.
    expect(text).toContain('Move the security settings into policy.yaml');
    expect(text).toContain('(`forge.movePolicy`)');
  });

  it('runs the policy move as the last step, before Finish', () => {
    const headings = [...doc.matchAll(/^## (Step \d+|Finish)\b/gm)].map((m) => ({
      title: m[1],
      at: m.index ?? -1,
    }));
    const step14 = headings.find((h) => h.title === 'Step 14');
    const finish = headings.find((h) => h.title === 'Finish');
    expect(step14).toBeDefined();
    expect(finish).toBeDefined();
    const others = headings.filter((h) => h.title.startsWith('Step') && h.title !== 'Step 14');
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((h) => h.at < step14!.at)).toBe(true);
    expect(step14!.at).toBeLessThan(finish!.at);
  });

  it('sends manage_jobs a definition it can create, with no id of its own', () => {
    const marker = 'Create this job with manage_jobs: ';
    const at = doc.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const rest = doc.slice(at + marker.length);
    const definition = JSON.parse(rest.slice(0, rest.indexOf('\n'))) as Record<string, unknown>;
    // `manage_jobs create` derives the id from the name and adds version and
    // the timestamps (src/tools/jobTools.ts): a doc that sends them would be
    // pinning values the tool owns.
    expect(Object.keys(definition)).not.toContain('id');
    expect(
      JobSchema.safeParse({
        version: 1,
        id: 'daily-chat-retitle',
        created_at: 0,
        updated_at: 0,
        ...definition,
      }).success,
    ).toBe(true);
  });

  it('names only commands the extension contributes', () => {
    const contributed = new Set(pkg.contributes.commands.map((c) => c.command));
    // Written as **Title** (`forge.id`); the parentheses keep `forge.sh` out.
    const named = [...doc.matchAll(/\(`(forge\.[A-Za-z.]+)`\)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((id) => !contributed.has(id))).toEqual([]);
  });

  it('names only config files that ship with the extension', () => {
    const named = [...doc.matchAll(/`(config\/[\w./-]+\.ya?ml)`/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((file) => !fs.existsSync(path.join(root, file)))).toEqual([]);
  });

  it('uses only top-level keys the config schema knows, and shows examples that parse', () => {
    const known = new Set(Object.keys(ForgeConfigSchema.shape));
    const blocks = yamlBlocks(doc);
    expect(blocks.length).toBeGreaterThan(0);
    const keys = blocks
      .map((block) => parse(block.content))
      .filter(
        (value): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
      )
      .flatMap((value) => Object.keys(value));
    expect(keys.filter((key) => !known.has(key))).toEqual([]);
    // The keys being legal is not the check: four README examples once had
    // every key right and the shape of `models:` wrong.
    const failures = blocks
      .filter((block) => block.content.trim().length > 0)
      .flatMap((block) =>
        validateConfigExample(block.content).map(
          (error) => `AI_SETUP.md:${String(block.fenceLine)} ${error}`,
        ),
      );
    expect(failures).toEqual([]);
  });

  it('marks every fragment as partial', () => {
    const unmarked = yamlBlocks(doc)
      .filter((block) => !isPartialExample(block.content))
      .filter((block) => validateConfigExample(block.content).length > 0)
      .map((block) => `AI_SETUP.md:${String(block.fenceLine)}`);
    expect(unmarked).toEqual([]);
  });

  it('has the setup agent look for Git Bash on Windows instead of assuming it', () => {
    // The audited laptop had no Git for Windows, so the client it sent the
    // agent to run could not run, and the file assumed
    // `C:\\Program Files\\Git\\bin\\bash.exe` existed. An agent that follows
    // this file literally has to be told to look first, where a per-user Git
    // puts its bash, and what to say when there is no Git at all.
    const step7 = doc.slice(doc.indexOf('## Step 7'), doc.indexOf('## Step 8'));
    expect(step7.length).toBeGreaterThan(0);
    expect(step7).toContain('Get-Command git.exe');
    expect(step7).toContain('Git for Windows');
    expect(step7).toContain('winget install --id Git.Git -e');
    expect(step7).toMatch(/LOCALAPPDATA.*Git|per-user/i);
    // The plan confirmation authorizes the listed install; only OS prompts
    // return to the user.
    expect(step7).toContain('After the confirmation');
    expect(step7).toContain('stop only for any Windows prompt');
    expect(step7).not.toMatch(/ask first[^.]*never install unasked/i);
    // The check comes before the run: an agent that runs the example first
    // fails on a machine with no Git and has nothing to tell the user.
    const checkAt = step7.indexOf('git --exec-path');
    const runAt = step7.indexOf('bash.exe>" ~/.forge/agent-bus/forge.sh');
    expect(checkAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(checkAt);
    // WSL is why bare `bash` is not a fallback, and this file has to give the
    // reason, not just the rule: WSL's home is not the Windows profile that
    // holds `~/.forge/agent-bus`.
    expect(step7).toContain('WSL');
    expect(step7).toMatch(/WSL[^"]*\$HOME|whose [^"]*home|WSL.s home/i);
    expect(step7).not.toMatch(/(^|\s)bash ~\/\.forge/u);
  });

  it('ships in the VSIX', () => {
    const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8').split('\n');
    expect(ignore).toContain('!AI_SETUP.md');
  });

  // The state × lifecycle ledger row for config.yaml (docs/plans/AI_SETUP_HANDOFF_PLAN.md):
  // a crashed agent must leave either the old config or its backup behind.
  it('tells the agent to back up an existing config before replacing it', () => {
    expect(doc).toContain('config.yaml.bak');
  });
});

describe('agentSetupPrompt', () => {
  it('pins the entire setup prompt for a workspace config', () => {
    expect(agentSetupPrompt('/ext', '/global/config.yaml', '/ws/.forge/config.yaml')).toBe(
      [
        'Set up the Forge LLM VS Code extension on this machine.',
        `Follow the instructions in ${path.join('/ext', 'AI_SETUP.md')} step by step.`,
        'The extension is installed at /ext.',
        'Forge reads its config from one of: global config: /global/config.yaml; workspace config: /ws/.forge/config.yaml.',
        "Follow AI_SETUP.md's single confirmation and human-only stops; complete the named setup sections without further questions.",
      ].join('\n'),
    );
  });

  it('pins the entire setup prompt when no workspace is open', () => {
    expect(agentSetupPrompt('/ext', '/global/config.yaml', undefined)).toBe(
      [
        'Set up the Forge LLM VS Code extension on this machine.',
        `Follow the instructions in ${path.join('/ext', 'AI_SETUP.md')} step by step.`,
        'The extension is installed at /ext.',
        'Forge reads its config from one of: global config: /global/config.yaml; workspace config: none (no folder is open in VS Code).',
        "Follow AI_SETUP.md's single confirmation and human-only stops; complete the named setup sections without further questions.",
      ].join('\n'),
    );
  });
});
