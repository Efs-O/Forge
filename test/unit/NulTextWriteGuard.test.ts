/**
 * The one check every agent text-write tool runs on the text it is about to save.
 *
 * Cause (docs/plans/WRITE_FILE_NUL_PLAN.md): a model writing a TypeScript test
 * meant the two-character source escape backslash-u-0000 and sent the JSON
 * escape instead, so the parsed argument held a real NUL and the file on disk
 * went binary to git while passing vitest. These tests pin the refusal the
 * model reads, and that nothing reaches disk.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: require('os').tmpdir() } }],
  },
}));

import { makeWriteFileTool } from '../../src/tools/builtinTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { guardNulFreeText, nulTextRefusal } from '../../src/tools/writeTextGuard';

/** A real NUL, spelled so this file can never hold one by accident. */
const NUL = String.fromCharCode(0);

/** The pinned sentence, exactly as the model reads it (Error: is added by dispatch). */
const refusal = (tool: string, count: number, first: number): string =>
  `${tool}: the new text holds ${count} NUL character(s) (U+0000), the first at character ` +
  `${first}; a source file never contains one, so nothing was written. If you meant the escape ` +
  `text \\u0000 in the file (for example a string separator in code), the JSON argument must ` +
  `carry the backslash doubled: write \\\\u0000. Otherwise resend the text without them.`;

/** The message a synchronous throw carries, so the wording can be pinned with toBe. */
function thrownMessage(run: () => unknown): string {
  try {
    run();
    return '(did not throw)';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The message a rejected handler carries. */
async function rejectedMessage(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return '(did not throw)';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-nul-guard-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const callWrite = async (args: Record<string, unknown>) =>
  makeWriteFileTool().handler(args, { signal: new AbortController().signal } as never);

describe('the shared NUL check', () => {
  it('names one NUL, how many there are, and where the first one is', () => {
    expect(nulTextRefusal('write_file', `a${NUL}b`)).toBe(refusal('write_file', 1, 1));
    expect(nulTextRefusal('edit_file', `${NUL}a${NUL}b${NUL}`)).toBe(refusal('edit_file', 3, 0));
    expect(nulTextRefusal('apply_line_edits', `line one\nline two${NUL}\n`)).toBe(
      refusal('apply_line_edits', 1, 17),
    );
  });

  it('is undefined for text that only looks like one, so ordinary writes pass', () => {
    const allowed = [
      '',
      'plain text, no control characters',
      'tabs\tbetween\twords',
      'crlf\r\nlines stay',
      'emoji 🎂 and a combining é',
      'const char *s = "a\\0b"; /* a C string escape is backslash + zero, not a NUL */',
      'a vertical tab \x0B and a form feed \x0C are not NULs either',
    ];
    for (const text of allowed) {
      expect(nulTextRefusal('write_file', text)).toBe(undefined);
    }
  });

  it('throws the refusal it computed, so a refusal means no bytes changed', () => {
    expect(thrownMessage(() => guardNulFreeText('write_file', `a${NUL}`))).toBe(
      refusal('write_file', 1, 1),
    );
    expect(thrownMessage(() => guardNulFreeText('edit_file', 'clean text'))).toBe(
      '(did not throw)',
    );
  });

  it('names the doubled backslash, so the model can fix the escape instead of deleting it', () => {
    const message = nulTextRefusal('write_file', `fake${NUL}chat`) ?? '';
    expect(message).toBe(
      'write_file: the new text holds 1 NUL character(s) (U+0000), the first at character 4; ' +
        'a source file never contains one, so nothing was written. If you meant the escape text ' +
        '\\u0000 in the file (for example a string separator in code), the JSON argument must ' +
        'carry the backslash doubled: write \\\\u0000. Otherwise resend the text without them.',
    );
    // The first mention is the escape text itself: one backslash. The spelling it must
    // put in a JSON argument carries it doubled: two backslashes, and not the one.
    expect(message.includes('escape text \\u0000 in the file')).toBe(true);
    expect(message.includes('write \\\\u0000.')).toBe(true);
    expect(message.includes('write \\u0000.')).toBe(false);
  });
});

describe('write_file refuses a NUL in content and writes nothing', () => {
  it('refuses a new file, leaving the directory empty', async () => {
    const target = path.join(dir, 'nul.ts');
    expect(await rejectedMessage(callWrite({ path: target, content: `x${NUL}y` }))).toBe(
      refusal('write_file', 1, 1),
    );
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('counts every NUL in the content, not just the first', async () => {
    const target = path.join(dir, 'many.ts');
    const content = `a${NUL}b${NUL}\n\nc${NUL}`;
    expect(await rejectedMessage(callWrite({ path: target, content }))).toBe(
      refusal('write_file', 3, 1),
    );
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses mode "append" too, and leaves the file it was going to append to alone', async () => {
    const target = path.join(dir, 'appended.txt');
    const original = Buffer.from('first line\n', 'utf8');
    fs.writeFileSync(target, original);
    expect(
      await rejectedMessage(
        callWrite({ path: target, content: `tail${NUL}piece`, mode: 'append' }),
      ),
    ).toBe(refusal('write_file', 1, 4));
    expect(fs.readFileSync(target).equals(original)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['appended.txt']);
  });

  it('writes text that merely mentions an escape byte-exactly, adding no NUL of its own', async () => {
    const target = path.join(dir, 'escapes.txt');
    const content = 'const nul = "a\\0b";\t// emoji 🎂 and a tab above\nnext line\n';
    await callWrite({ path: target, content });
    const bytes = fs.readFileSync(target);
    expect(bytes.equals(Buffer.from(content, 'utf8'))).toBe(true);
    expect(bytes.includes(0)).toBe(false);
  });

  it('still accepts carriage returns, since line endings are not a NUL', async () => {
    const target = path.join(dir, 'crlf.txt');
    const result = await callWrite({ path: target, content: 'one\r\ntwo\r\n' });
    expect(String(result)).toContain('Written');
    expect(fs.readFileSync(target).includes(0)).toBe(false);
  });
});

describe('edit_file refuses a NUL in new_str', () => {
  it('refuses the single form and leaves the file byte-identical', async () => {
    const target = path.join(dir, 'single.txt');
    const original = Buffer.from('before\n', 'utf8');
    fs.writeFileSync(target, original);
    expect(
      await rejectedMessage(
        makeEditFileTool().handler({ path: target, old_str: 'before', new_str: `after${NUL}more` }),
      ),
    ).toBe(refusal('edit_file', 1, 5));
    expect(fs.readFileSync(target).equals(original)).toBe(true);
  });

  it('refuses a batch as a whole, naming the first offending edit', async () => {
    const target = path.join(dir, 'batch.txt');
    const original = Buffer.from('aaa\nbbb\n', 'utf8');
    fs.writeFileSync(target, original);
    expect(
      await rejectedMessage(
        makeEditFileTool().handler({
          path: target,
          edits: [
            { old_str: 'aaa', new_str: 'AAA' },
            { old_str: 'bbb', new_str: `B${NUL}B${NUL}B${NUL}` },
          ],
        }),
      ),
    ).toBe(refusal('edit_file', 3, 1));
    expect(fs.readFileSync(target).equals(original)).toBe(true);
  });

  it('accepts a new_str that only mentions an escape', async () => {
    const target = path.join(dir, 'escape-edit.txt');
    fs.writeFileSync(target, 'placeholder\n', 'utf8');
    await makeEditFileTool().handler({
      path: target,
      old_str: 'placeholder',
      new_str: 'const terminator = "\\0";',
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('const terminator = "\\0";\n');
    expect(fs.readFileSync(target).includes(0)).toBe(false);
  });
});

describe('apply_line_edits refuses a NUL in replacement_text', () => {
  const operations = (replacement: string): Record<string, unknown>[] => [
    { start_line: 1, end_line: 1, expected_text: 'before', replacement_text: replacement },
  ];

  it('refuses before the file is read, so nothing is written', async () => {
    const target = path.join(dir, 'lines.txt');
    const original = Buffer.from('before\n', 'utf8');
    fs.writeFileSync(target, original);
    expect(
      await rejectedMessage(
        makeApplyLineEditsTool().handler({ path: target, operations: operations(`after${NUL}`) }),
      ),
    ).toBe(refusal('apply_line_edits', 1, 5));
    expect(fs.readFileSync(target).equals(original)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['lines.txt']);
  });

  it('accepts a replacement_text that only mentions an escape', async () => {
    const target = path.join(dir, 'escape-lines.txt');
    fs.writeFileSync(target, 'before\n', 'utf8');
    await makeApplyLineEditsTool().handler({
      path: target,
      operations: operations('const terminator = "\\0";'),
    });
    expect(fs.readFileSync(target, 'utf8')).toBe('const terminator = "\\0";\n');
    expect(fs.readFileSync(target).includes(0)).toBe(false);
  });
});

describe('the sentence lives in one place', () => {
  it('is built by the helper for every tool name, so the tools cannot drift apart', () => {
    const built = new Set(
      ['write_file', 'edit_file', 'apply_line_edits'].map(
        (tool) => nulTextRefusal(tool, NUL)?.slice(`${tool}: `.length),
      ),
    );
    expect(built.size).toBe(1);
    expect([...built][0]).toBe(
      'the new text holds 1 NUL character(s) (U+0000), the first at character 0; a source file ' +
        'never contains one, so nothing was written. If you meant the escape text \\u0000 in the ' +
        'file (for example a string separator in code), the JSON argument must carry the backslash ' +
        'doubled: write \\\\u0000. Otherwise resend the text without them.',
    );
  });
});
