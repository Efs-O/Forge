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

  /** Item 7 of `docs/plans/OWNER_GUARDS_PLAN.md`: an agent whose secret read was
   *  declined went and got the same content through the shell, which turned a
   *  refusal the user gave into a round the user never agreed to. The fix is one
   *  line in the prompt, so it is pinned here against the template itself.
   */
  it('tells the agent what to do when a secret read is declined', () => {
    const template = fs.readFileSync(
      path.resolve('config/templates/builtin/execute.njk'),
      'utf8',
    );
    expect(template).toContain('If a read of a secret path is declined, do not get it another way');
    expect(template).toContain('tell the user it was declined');
  });
});
