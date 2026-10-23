import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

const filesThatTeachApprovalPolicy = [
  'src/sidebar/turnContext.ts',
  'src/sidebar/ToolApprovalService.ts',
  'src/sidebar/SlashCommandHandler.ts',
  'src/tools/fileEditTools.ts',
  'config/templates/builtin/execute.njk',
];

describe('delete approval prompt copy', () => {
  it('does not teach that recursive recycle-bin deletes are dangerous', () => {
    const copy = filesThatTeachApprovalPolicy
      .map((file) => fs.readFileSync(path.resolve(file), 'utf8'))
      .join('\n');

    expect(copy).not.toContain('So is delete_file with recursive: true.');
    expect(copy).not.toContain('delete_file with recursive: true is dangerous');
    expect(copy).not.toContain('Recursive deletes still confirm.');
    expect(copy).toContain('only `to_trash: false` is a dangerous delete');
  });
});
