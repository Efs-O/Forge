import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { BUS_README } from '../../src/agentBus/busContent';

const root = path.resolve(__dirname, '..', '..');

const machinePathRules = [
  {
    name: 'Windows profile path',
    pattern: /[A-Za-z]:[\\/]Users[\\/](?![<%${])/iu,
  },
  {
    name: 'Unix profile path',
    pattern: /\/(?:home|Users)\/(?![<${])/u,
  },
  {
    name: 'workspace path',
    pattern: /vs code apps/iu,
  },
];

interface ShippedFile {
  name: string;
  text: string;
}

function shippedInstructionFiles(): ShippedFile[] {
  const builtInDir = path.join(root, 'config', 'templates', 'builtin');
  const builtIns = fs
    .readdirSync(builtInDir)
    .filter((name) => name.endsWith('.njk'))
    .sort()
    .map((name) => ({
      name: `config/templates/builtin/${name}`,
      text: fs.readFileSync(path.join(builtInDir, name), 'utf8'),
    }));

  const fixedFiles = [
    'AI_SETUP.md',
    'src/agentBus/agentNote.md',
    'resources/instructions/FORGE.starter.md',
    'resources/tips/CODING_TIPS.md',
  ].map((name) => ({ name, text: fs.readFileSync(path.join(root, name), 'utf8') }));

  return [...fixedFiles, ...builtIns, { name: 'BUS_README', text: BUS_README }];
}

function machinePathMatches(text: string): string[] {
  return machinePathRules.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

interface SecretPattern {
  line: number;
  pattern: RegExp;
}

function secretPatterns(): SecretPattern[] {
  const file = path.join(root, '.secrets-patterns.txt');
  if (!fs.existsSync(file)) return [];

  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line, index) => ({ value: line.trim(), line: index + 1 }))
    .filter(({ value }) => value.length > 0 && !value.startsWith('#'))
    .map(({ value, line }) => ({ line, pattern: new RegExp(value, 'iu') }));
}

const allowedExamples = [
  ['Git Bash in Program Files', 'C:\\Program Files\\Git\\bin\\bash.exe'],
  ['Git Bash under LOCALAPPDATA', '%LOCALAPPDATA%\\Programs\\Git\\bin\\bash.exe'],
  ['a redacted Windows profile', 'C:/Users/<name>'],
  ['the agent bus home alias', '~/.forge/agent-bus'],
  ['the HOME alias', '$HOME/.forge'],
] as const;

const refusedExamples = [
  ['a named Windows profile', 'C:\\Users\\alice\\x', 'Windows profile path'],
  ['a named Unix profile', '/home/bob/.forge', 'Unix profile path'],
  ['the machine workspace path', 'N:\\vs code apps\\Forge', 'workspace path'],
] as const;

describe('shipped instruction files contain no machine-specific paths', () => {
  const files = shippedInstructionFiles();

  for (const file of files) {
    it(`keeps ${file.name} free of machine-specific paths`, () => {
      expect(machinePathMatches(file.text), `${file.name} contains a machine path`).toEqual([]);
    });
  }

  const patterns = secretPatterns();
  if (patterns.length > 0) {
    for (const { line, pattern } of patterns) {
      it(`keeps shipped instructions clear of local pattern ${line}`, () => {
        const offenders = files.filter(({ text }) => pattern.test(text)).map(({ name }) => name);
        expect(offenders, `local pattern ${line} matched shipped instruction files`).toEqual([]);
      });
    }
  }
});

describe('machine path matcher examples', () => {
  it.each(allowedExamples)('allows %s', (_name, sample) => {
    expect(machinePathMatches(sample)).toEqual([]);
  });

  it.each(refusedExamples)('refuses %s', (_name, sample, rule) => {
    expect(machinePathMatches(sample)).toContain(rule);
  });
});
