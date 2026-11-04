import * as fs from 'fs';
import * as path from 'path';
import { applyEol, dominantEol } from './editMatch';

export type EolChoice = { eol: '\n' | '\r\n'; reason: string } | { eol: 'none' };

/** Choose line endings for write_file, keeping existing files and Git policy. */
export async function chooseWriteEol(
  filePath: string,
  existing: string | undefined,
): Promise<EolChoice> {
  if (existing && /[\r\n]/u.test(existing)) {
    const eol = dominantEol(existing);
    return { eol, reason: `kept from the existing file` };
  }

  try {
    const { getRepo, repoRelative, runGit } = await import('./gitRepo');
    const repo = await getRepo(filePath);
    const relative = repoRelative(repo, filePath);
    const attrs = await runGit(repo, ['check-attr', 'eol', 'text', '--', relative]);
    const values = new Map<string, string>();
    for (const line of attrs.split(/\r?\n/u)) {
      const match = /^.*: (eol|text): (.*)$/u.exec(line);
      if (match) values.set(match[1]!, match[2]!);
    }
    if (values.get('text') === 'unset') return { eol: 'none' };
    if (values.get('eol') === 'lf') return { eol: '\n', reason: 'from Git eol=lf' };
    if (values.get('eol') === 'crlf') return { eol: '\r\n', reason: 'from Git eol=crlf' };
  } catch {
    // A missing repository or Git executable uses the documented default.
    // Other Git failures also use it, without claiming Git supplied the choice.
  }

  return defaultEol(filePath);
}

function defaultEol(filePath: string): EolChoice {
  const extension = path.extname(filePath).toLowerCase();
  return extension === '.bat' || extension === '.cmd'
    ? { eol: '\r\n', reason: `${extension} file` }
    : { eol: '\n', reason: 'default LF' };
}

export function applyWriteEol(
  content: string,
  choice: EolChoice,
): {
  content: string;
  note: string;
} {
  if (choice.eol === 'none') return { content, note: '' };
  const converted = applyEol(content, choice.eol);
  if (converted === content) return { content, note: '' };
  const label = choice.eol === '\r\n' ? 'CRLF' : 'LF';
  return { content: converted, note: ` (${label} line endings, ${choice.reason})` };
}

/** Read existing text for EOL selection; absent and empty files have no style. */
export function readExistingForWrite(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return fs.readFileSync(filePath, 'utf8');
}
