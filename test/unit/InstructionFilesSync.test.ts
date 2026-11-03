import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

interface Source {
  file: string;
  heading: string;
}

interface Copy {
  file: string;
  mode: 'verbatim' | 'pointer';
  after?: string;
  pointer?: string;
}

interface GeneralAnchor {
  file: string;
  anchor: string;
}

interface Concern {
  concern: string;
  source: Source;
  copies: Copy[];
  general: GeneralAnchor[];
}

const root = path.resolve(__dirname, '../..');
const map = JSON.parse(
  fs.readFileSync(path.join(root, 'test', 'fixtures', 'instruction-sync.json'), 'utf8'),
) as Concern[];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function normalize(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{2,}/gu, '\n')
    .trim();
}

function sectionBody(text: string, heading: string): string | undefined {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return undefined;
  const level = heading.match(/^#+/u)?.[0].length ?? 1;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('<!-- forge-agent-mesh:start -->')) {
      end = index;
      break;
    }
    const nextLevel = lines[index]?.match(/^(#+)\s/u)?.[1].length;
    if (nextLevel !== undefined && nextLevel <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

function copyBody(text: string, after: string): string | undefined {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const start = lines.indexOf(after);
  if (start < 0) return undefined;
  if (/^#{2,6}\s/u.test(after)) {
    const level = after.match(/^#+/u)?.[0].length ?? 2;
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
      const nextLevel = lines[index]?.match(/^(#+)\s/u)?.[1].length;
      if (nextLevel !== undefined && nextLevel <= level) {
        end = index;
        break;
      }
    }
    return lines.slice(start + 1, end).join('\n');
  }
  return lines.slice(start + 1).join('\n');
}

function checkConcern(concern: Concern, base: string): string[] {
  const problems: string[] = [];
  const sourcePath = path.join(base, concern.source.file);
  const sourceExists = fs.existsSync(sourcePath);
  const sourceText = sourceExists ? fs.readFileSync(sourcePath, 'utf8') : '';
  const sourceBody = sourceExists ? sectionBody(sourceText, concern.source.heading) : undefined;
  if (sourceExists && sourceBody === undefined) {
    problems.push(
      `${concern.concern}: ${concern.source.file} is missing heading '${concern.source.heading}'`,
    );
  }

  for (const copy of concern.copies) {
    const copyPath = path.join(base, copy.file);
    if (!sourceExists || !fs.existsSync(copyPath) || sourceBody === undefined) continue;
    const copyText = fs.readFileSync(copyPath, 'utf8');
    if (copy.mode === 'pointer') {
      if (!copy.pointer || !copyText.includes(copy.pointer)) {
        problems.push(
          `${concern.concern}: ${copy.file} must point to ${concern.source.file} heading '${concern.source.heading}'`,
        );
      }
      continue;
    }
    const copiedBody = copy.after ? copyBody(copyText, copy.after) : undefined;
    const guidance = `${concern.source.file} is the source; copy its section '${concern.source.heading}' into ${copy.file}, or update test/fixtures/instruction-sync.json`;
    if (copiedBody === undefined) {
      problems.push(`${concern.concern}: marker '${copy.after ?? ''}' is missing in ${copy.file}; ${guidance}`);
    } else if (normalize(copiedBody) !== normalize(sourceBody)) {
      problems.push(`${concern.concern}: ${copy.file} differs from ${concern.source.file}; ${guidance}`);
    }
  }

  for (const general of concern.general) {
    const generalPath = path.join(base, general.file);
    const text = fs.existsSync(generalPath) ? fs.readFileSync(generalPath, 'utf8') : '';
    if (!text.includes(general.anchor)) {
      problems.push(
        `${concern.concern}: ${general.file} is missing general-version anchor '${general.anchor}' (update test/fixtures/instruction-sync.json if intentionally renamed)`,
      );
    }
  }
  return problems;
}

function tempRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-instruction-sync-'));
  temporaryRoots.push(directory);
  return directory;
}

function write(base: string, file: string, text: string): void {
  const target = path.join(base, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, 'utf8');
}

describe('instruction file sync map', () => {
  it('matches verbatim copies after whitespace normalization and names drift', () => {
    const base = tempRoot();
    const concern: Concern = {
      concern: 'example',
      source: { file: 'CLAUDE.md', heading: '## Shared rule' },
      copies: [{ file: 'copy.md', mode: 'verbatim', after: '<!-- copy -->' }],
      general: [],
    };
    write(base, 'CLAUDE.md', '## Shared rule\n\nFirst line.\n\nSecond line.\n');
    write(base, 'copy.md', '<!-- copy -->\nFirst line.\nSecond line.\n');
    expect(checkConcern(concern, base)).toEqual([]);
    write(base, 'copy.md', '<!-- copy -->\nChanged line.\nSecond line.\n');
    const problems = checkConcern(concern, base);
    expect(problems[0]).toContain('CLAUDE.md');
    expect(problems[0]).toContain('copy.md');
    expect(problems[0]).toContain('## Shared rule');
  });

  it('checks pointers and skips pairs with an absent source or copy', () => {
    const base = tempRoot();
    const pointer: Concern = {
      concern: 'pointer',
      source: { file: 'CLAUDE.md', heading: '## Canonical' },
      copies: [{ file: 'AGENTS.md', mode: 'pointer', pointer: 'CLAUDE.md § `## Canonical`' }],
      general: [],
    };
    write(base, 'CLAUDE.md', '## Canonical\nRule.\n');
    write(base, 'AGENTS.md', 'Read CLAUDE.md § `## Canonical`.\n');
    expect(checkConcern(pointer, base)).toEqual([]);
    write(base, 'AGENTS.md', 'No pointer.\n');
    expect(checkConcern(pointer, base)[0]).toContain('AGENTS.md must point');

    const absentCopies: Concern = {
      ...pointer,
      concern: 'absent-copy',
      copies: [
        { file: 'missing.md', mode: 'verbatim', after: 'marker' },
        { file: 'AGENTS.md', mode: 'pointer', pointer: 'expected pointer' },
      ],
    };
    expect(checkConcern(absentCopies, base)).toHaveLength(1);
    fs.rmSync(path.join(base, 'CLAUDE.md'));
    expect(checkConcern(pointer, base)).toEqual([]);
  });

  it('fails a missing source heading by concern and checks general anchors', () => {
    const base = tempRoot();
    const concern: Concern = {
      concern: 'missing-heading',
      source: { file: 'CLAUDE.md', heading: '## Renamed' },
      copies: [{ file: 'copy.md', mode: 'pointer', pointer: 'CLAUDE.md § `## Renamed`' }],
      general: [{ file: 'general.md', anchor: 'required phrase' }],
    };
    write(base, 'CLAUDE.md', '## Old heading\nText.\n');
    write(base, 'copy.md', 'CLAUDE.md § `## Renamed`\n');
    write(base, 'general.md', 'required phrase is here\n');
    expect(checkConcern(concern, base)[0]).toContain('missing-heading');
    expect(checkConcern({ ...concern, copies: [] }, base)[0]).toContain('missing-heading');
    write(base, 'CLAUDE.md', '## Renamed\nText.\n');
    write(base, 'general.md', 'anchor removed\n');
    expect(checkConcern(concern, base).join('\n')).toContain('general-version anchor');
  });

  it('checks the real map against local files when present and tracked copies everywhere', () => {
    const problems = map.flatMap((concern) => checkConcern(concern, root));
    expect(problems).toEqual([]);
  });
});
