import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

// Fails if the workers stop inheriting the guard's temp variables (a vitest
// upgrade could do that), instead of the guard silently checking nothing.
describe('temp guard', () => {
  it('points os.tmpdir() at this file’s folder inside the run folder', () => {
    expect(path.basename(os.tmpdir())).toMatch(/^file-/u);
    expect(path.basename(path.dirname(os.tmpdir()))).toMatch(/^forge-test-run-\d+-/u);
  });
});
