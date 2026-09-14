/**
 * docs/COMMANDS.md claims to list every command Forge contributes to the
 * palette. It silently fell behind package.json by sixteen commands (Model
 * Manager, Add Models, Compact config, the whole remote-control set) because
 * nothing checked the claim. This does.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

interface ContributedCommand {
  command: string;
  title: string;
  category?: string;
}

function paletteLabel(entry: ContributedCommand): string {
  return entry.category ? `${entry.category}: ${entry.title}` : entry.title;
}

describe('docs/COMMANDS.md', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    contributes: { commands: ContributedCommand[] };
  };
  const doc = fs.readFileSync(path.join(root, 'docs', 'COMMANDS.md'), 'utf8');
  const documented = new Set(Array.from(doc.matchAll(/^\|\s*`([^`]+)`/gm), (match) => match[1]));

  it('documents every contributed command', () => {
    const missing = pkg.contributes.commands.map(paletteLabel).filter((label) => !documented.has(label));
    expect(missing).toEqual([]);
  });

  it('documents no command that is not contributed', () => {
    const contributed = new Set(pkg.contributes.commands.map(paletteLabel));
    expect([...documented].filter((label) => !contributed.has(label))).toEqual([]);
  });
});
