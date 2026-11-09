import { describe, expect, it } from 'vitest';
import { repairTrailingPathSpace, trailingPathSpaceNote } from '../../src/tools/pathArgTrim';

/**
 * A path argument ending in whitespace is a stray space, not a filename, and the refusal
 * it produced cost a whole round chasing a base that was never wrong (lab arm U6b,
 * 2026-11-09). The repair is decided from the tool's own schema, so `edit_notebook_cell`'s
 * `source` — cell text, where trailing whitespace is meaningful — stays untouched while
 * `move_file`'s `source`, which the schema calls a path, is repaired. `ToolDispatch.test.ts`
 * proves the gate and the checkpoint see the repaired path; these pin the repair and the
 * exact text the agent is shown.
 */
const parameters = (properties: Record<string, unknown>) => ({ type: 'object', properties });
const PATH_DESC = { type: 'string', description: 'File path, absolute or workspace-relative.' };

describe('trailing space in a path argument (lab arm U6b)', () => {
  it('repairs `path` and says so in the words the model is shown', () => {
    const args: Record<string, unknown> = { path: 'N:/vs code apps/Forge/scratch ' };
    expect(repairTrailingPathSpace(parameters({ path: PATH_DESC }), args)).toEqual(['path']);
    expect(args).toEqual({ path: 'N:/vs code apps/Forge/scratch' });
    expect(trailingPathSpaceNote(['path'])).toBe(
      'Note: argument "path" ended with a space; trimmed it before running the tool.',
    );
  });

  it('repairs a path `source` and `destination`, but not a notebook cell `source`', () => {
    const moveArgs: Record<string, unknown> = { source: 'a.txt ', destination: 'b.txt ' };
    expect(
      repairTrailingPathSpace(
        parameters({
          source: { type: 'string', description: 'Source file or directory path.' },
          destination: { type: 'string', description: 'Destination file or directory path.' },
        }),
        moveArgs,
      ),
    ).toEqual(['source', 'destination']);
    expect(moveArgs).toEqual({ source: 'a.txt', destination: 'b.txt' });

    const cellArgs: Record<string, unknown> = { path: 'nb.ipynb', source: 'print(1)  ' };
    expect(
      repairTrailingPathSpace(
        parameters({
          path: { type: 'string', description: 'Notebook path, absolute or workspace-relative.' },
          source: { type: 'string', description: 'New complete source for the cell.' },
        }),
        cellArgs,
      ),
    ).toEqual([]);
    expect(cellArgs).toEqual({ path: 'nb.ipynb', source: 'print(1)  ' });
  });

  it('leaves a leading or internal space exactly as the model wrote it', () => {
    const args: Record<string, unknown> = { path: ' N:/vs code apps/my scratch' };
    expect(repairTrailingPathSpace(parameters({ path: PATH_DESC }), args)).toEqual([]);
    expect(args).toEqual({ path: ' N:/vs code apps/my scratch' });
  });

  it('repairs every entry of a path list and names the list once', () => {
    const args: Record<string, unknown> = { paths: ['a.txt ', 'b\t', 'clean.txt'] };
    expect(
      repairTrailingPathSpace(
        parameters({ paths: { type: 'array', items: { type: 'string' } } }),
        args,
      ),
    ).toEqual(['paths']);
    expect(args).toEqual({ paths: ['a.txt', 'b', 'clean.txt'] });
    expect(trailingPathSpaceNote(['paths'])).toBe(
      'Note: argument "paths" ended with a space; trimmed it before running the tool.',
    );
  });

  it('names both arguments when two are repaired', () => {
    const args: Record<string, unknown> = { cwd: 'N:/x ', path: 'y ' };
    expect(
      repairTrailingPathSpace(parameters({ cwd: { type: 'string' }, path: { type: 'string' } }), args),
    ).toEqual(['cwd', 'path']);
    expect(args).toEqual({ cwd: 'N:/x', path: 'y' });
    expect(trailingPathSpaceNote(['cwd', 'path'])).toBe(
      'Note: arguments "cwd", "path" ended with a space; trimmed them before running the tool.',
    );
  });

  it('never touches a git ref or a chat target, whose schemas say neither is a path', () => {
    const args: Record<string, unknown> = { from: 'main ', to: 'the other chat ' };
    expect(
      repairTrailingPathSpace(
        parameters({
          from: { type: 'string', description: 'Starting ref (branch, hash). Optional.' },
          to: { type: 'string', description: 'Another chat id, `#N` from list, or words from the title.' },
        }),
        args,
      ),
    ).toEqual([]);
    expect(args).toEqual({ from: 'main ', to: 'the other chat ' });
  });
});
