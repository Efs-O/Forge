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
import { agentSetupPrompt } from '../../src/vscode/agentSetupCommand';
import { isPartialExample, validateConfigExample, yamlBlocks } from '../support/docConfigExamples';

const root = path.resolve(__dirname, '..', '..');
const doc = fs.readFileSync(path.join(root, 'AI_SETUP.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  contributes: { commands: { command: string }[] };
};

describe('AI_SETUP.md', () => {
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
    // Ask, never install on the user's behalf.
    expect(step7).toMatch(/ask first[^.]*never install unasked/i);
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
  it('points the agent at the shipped file and both config locations', () => {
    const prompt = agentSetupPrompt('/ext', '/global/config.yaml', '/ws/.forge/config.yaml');
    expect(prompt).toContain(path.join('/ext', 'AI_SETUP.md'));
    expect(prompt).toContain('/global/config.yaml');
    expect(prompt).toContain('/ws/.forge/config.yaml');
  });

  it('says so when no workspace is open instead of inventing a path', () => {
    expect(agentSetupPrompt('/ext', '/global/config.yaml', undefined)).toContain(
      'no folder is open',
    );
  });
});
