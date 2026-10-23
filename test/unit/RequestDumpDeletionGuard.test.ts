import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('request dump deletion wiring', () => {
  it('deletes a conversation’s request dumps from the permanent-delete owner', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'sidebar', 'ConversationTabs.ts'),
      'utf8',
    );

    expect(source).toContain("import { deleteRequestDumps } from '../sessions/requestDump';");
    const methodStart = source.indexOf('async deleteConversation');
    const methodEnd = source.indexOf('capBlockers(', methodStart);
    const method = source.slice(methodStart, methodEnd);
    expect(method).toContain('await deleteRequestDumps(id);');
    expect(method.indexOf('stopStreamingIfNeeded')).toBeLessThan(
      method.indexOf('await deleteRequestDumps(id);'),
    );
  });

  it('prunes at activation even if config bootstrapping yields no config', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    expect(source).toMatch(
      /const bootstrapped = bootstrapConfig[\s\S]*?void pruneRequestDumps\(requestDumpsDirectory\(\), pruneOptions\)[\s\S]*?if \(!bootstrapped\) return;/u,
    );
  });
});
