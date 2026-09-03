import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * No source file may contain invisible control characters.
 *
 * This has now cost this project two separate debugging sessions, because the
 * failure is perfectly disguised: a stray 0x08 inside a regex literal renders as
 * `\b` in `od`, as NOTHING in every editor, terminal and `grep` output, and the
 * pattern then silently requires a backspace character in its input and never
 * matches. The code looks correct in every view you would think to check.
 *
 * Both occurrences came from generating source through a shell heredoc, where a
 * backslash escape collapsed one layer too far. The guard is cheap, and it turns
 * an invisible bug into a named test failure.
 *
 * Tab (0x09), newline (0x0a) and carriage return (0x0d) are excluded -- those
 * are legitimate whitespace. So is NUL (0x00), which this codebase uses
 * deliberately as a map-key separator (`UserNotificationService`,
 * `PendingVoiceDraft`) precisely because it cannot occur in a channel name or a
 * chat id. Everything remaining has no legitimate use in source.
 */
const FORBIDDEN = /[\x01-\x08\x0b\x0c\x0e-\x1f]/;

describe('source hygiene', () => {
  it('has no invisible control characters in tracked source', () => {
    const root = path.resolve(__dirname, '..', '..');
    // git ls-files rather than a glob walk: it is the same set CI lints, and it
    // costs one process instead of a recursive read of node_modules.
    const tracked = execFileSync('git', ['ls-files', 'src', 'test', 'scripts', 'docs'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);

    const offenders: string[] = [];
    for (const file of tracked) {
      if (!/\.(ts|tsx|mjs|js|json|md|css|ya?ml)$/.test(file)) continue;
      // The WORKING COPY, not HEAD: an uncommitted edit is precisely where this
      // bug appears, and checking the committed version would clear the file
      // that is currently broken.
      let content: string;
      try {
        content = fs.readFileSync(path.join(root, file), 'utf8');
      } catch {
        continue; // Deleted but still listed.
      }
      if (FORBIDDEN.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
