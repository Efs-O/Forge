import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEditFileTool, MAX_EDITS_PER_CALL } from '../../src/tools/editFileTool';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
}));

const target = path.join(process.cwd(), 'test', `edit-cap-${process.pid}.txt`);

afterEach(() => fs.rmSync(target, { force: true }));

describe('edit_file batch cap', () => {
  it('accepts 200 edits and rejects 201', async () => {
    expect(MAX_EDITS_PER_CALL).toBe(200);
    const tool = makeEditFileTool();
    const definition = tool.definition.function;
    expect(JSON.stringify(definition)).toContain('Up to 200');
    expect(definition.parameters).toMatchObject({
      properties: { edits: { maxItems: 200 } },
    });
    const edits = Array.from({ length: 200 }, (_, index) => ({
      old_str: `old-${index}`,
      new_str: `new-${index}`,
    }));
    fs.writeFileSync(target, edits.map((edit) => edit.old_str).join('\n'));
    await tool.handler({ path: target, edits });
    expect(fs.readFileSync(target, 'utf8')).toContain('new-199');

    await expect(tool.handler({ path: target, edits: [...edits, edits[0]] })).rejects.toThrow(
      'at most 200 edits per call',
    );
  });
});
