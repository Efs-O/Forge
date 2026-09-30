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

  it('uses only top-level keys the config schema knows', () => {
    const known = new Set(Object.keys(ForgeConfigSchema.shape));
    const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    const keys = blocks.flatMap((block) => Object.keys(parse(block) as object));
    expect(keys.filter((key) => !known.has(key))).toEqual([]);
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
