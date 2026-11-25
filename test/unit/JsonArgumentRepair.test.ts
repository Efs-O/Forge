/**
 * Covers the bounded repair that turns an array argument back into an array when
 * the model's hand-written JSON slipped on an escape
 * (`src/tools/jsonArgumentRepair.ts`). The fixtures are the real calls: the
 * `edits` string below is verbatim from `~/.forge/sessions/`
 * `c15dc8e3-e5a4-4e35-b72d-9d85cabfee8b.jsonl` row 149 (2026-11-21), one of the
 * 60 array arguments in the whole archive that arrived as text.
 */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import {
  parseJsonArgumentText,
  repairDeclaredJsonArguments,
  jsonArgumentRepairNote,
} from '../../src/tools/jsonArgumentRepair';

vi.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }] },
}));

// Two slips: a backslash standing right before a real line break, twice.
const BROKEN_EDITS =
  "[{\"new_str\": \"    expect(findUnexpectedVsixFiles(['skills-lab/media-inspect/SKILL.md'])).toEqual([\\\n      'skills-lab/media-inspect/SKILL.md',\\\n    ]);\\n  });\", \"old_str\": \"    expect(\\n      findUnexpectedVsixFiles(['skills-lab/media-inspect/SKILL.md']),\\n    ).toEqual(['skills-lab/media-inspect/SKILL.md']);\\n  });\"}]";

const target = path.join(process.cwd(), 'test', `json-arg-repair-${process.pid}.ts`);

afterEach(() => fs.rmSync(target, { force: true }));

describe('parseJsonArgumentText', () => {
  it('reads the verbatim broken edits string as the array it meant', () => {
    const parsed = parseJsonArgumentText(BROKEN_EDITS);
    expect(parsed).toBeDefined();
    const edits = parsed?.value as Array<{ old_str: string; new_str: string }>;
    expect(Array.isArray(edits)).toBe(true);
    expect(edits).toHaveLength(1);
    // The backslash before a real line break survives as a literal backslash,
    // and the line break itself survives as a line break. The `\n` escapes the
    // model wrote correctly also survive as line breaks.
    expect(edits[0].new_str).toContain(
      "toEqual([\\\n      'skills-lab/media-inspect/SKILL.md',\\\n    ]);",
    );
    expect(edits[0].new_str).toContain('\n  });');
    expect(parsed?.repairs).toHaveLength(4);
    expect(parsed?.repairs[0]).toContain('kept as a literal backslash at character');
    expect(parsed?.repairs[1]).toContain('raw control character inside a string was escaped at character');
  });

  it('keeps the backslash of a JavaScript-style apostrophe escape as a literal backslash', () => {
    const parsed = parseJsonArgumentText('[{"old_str": "GitHub\\\'s", "new_str": "x"}]');
    expect((parsed?.value as Array<{ old_str: string }>)[0].old_str).toBe("GitHub\\'s");
    expect(parsed?.repairs[0]).toContain('kept as a literal backslash at character 21');
  });

  it('escapes a raw control character inside a string so the strict re-read passes', () => {
    const parsed = parseJsonArgumentText('[{"old_str": "a\nb", "new_str": "x"}]');
    expect((parsed?.value as Array<{ old_str: string }>)[0].old_str).toBe('a\nb');
  });

  it('reads an ambiguous escape as a literal backslash plus the text', () => {
    const parsed = parseJsonArgumentText('[{"old_str": "\\const X = 1", "new_str": "x"}]');
    expect(parsed).toBeDefined();
    expect((parsed?.value as Array<{ old_str: string }>)[0].old_str).toBe('\\const X = 1');
  });

  it('returns the parsed value when the text was valid JSON all along', () => {
    const parsed = parseJsonArgumentText('[{"old_str": "a", "new_str": "b"}]');
    expect(parsed).toEqual({ value: [{ old_str: 'a', new_str: 'b' }], repairs: [], total: 0 });
  });

  it('keeps a Python line continuation: backslash before a real newline stays a backslash + newline', () => {
    const parsed = parseJsonArgumentText('[{"old_str": "x = 1 + \\\n2", "new_str": "y"}]');
    expect((parsed?.value as Array<{ old_str: string }>)[0].old_str).toBe('x = 1 + \\\n2');
  });

  it('keeps a JS single-quote escape: backslash-apostrophe stays a backslash-apostrophe', () => {
    const parsed = parseJsonArgumentText('[{"old_str": "\'it\\\'s\'", "new_str": "y"}]');
    expect((parsed?.value as Array<{ old_str: string }>)[0].old_str).toBe("'it\\'s'");
  });

  it('keeps regex escapes: \d, \. and \p{L} all survive with their backslashes', () => {
    const parsed = parseJsonArgumentText('[{"old_str": "/\\d+\\.\\p{L}/u", "new_str": "y"}]');
    expect((parsed?.value as Array<{ old_str: string }>)[0].old_str).toBe('/\\d+\\.\\p{L}/u');
  });

  it('passes valid JSON escapes through unchanged', () => {
    const parsed = parseJsonArgumentText('[{"old_str": "a\\nb\\"c\\\\dA", "new_str": "y"}]');
    expect(parsed?.total).toBe(0);
    expect((parsed?.value as Array<{ old_str: string }>)[0].old_str).toBe('a\nb"c\\dA');
  });
});

describe('repairDeclaredJsonArguments', () => {
  const properties = {
    path: { type: 'string' },
    edits: { type: 'array' },
    meta: { type: 'object' },
  };

  it('replaces a declared array that arrived as text, in place', () => {
    const args: Record<string, unknown> = { path: 'a.ts', edits: '[{"old_str": "a\'b"}]' };
    const report = repairDeclaredJsonArguments(properties, args);
    expect(report.replacedKeys).toEqual(['edits']);
    expect(args['edits']).toEqual([{ old_str: "a\'b" }]);
  });

  it('never touches a declared string, nor an array-shaped value already parsed', () => {
    const args: Record<string, unknown> = {
      path: '[looks like an array]',
      edits: [{ old_str: 'a' }],
    };
    expect(repairDeclaredJsonArguments(properties, args).replacedKeys).toEqual([]);
    expect(args['path']).toBe('[looks like an array]');
    expect(args['edits']).toEqual([{ old_str: 'a' }]);
  });

  it('leaves a string that does not open like the declared shape', () => {
    const args: Record<string, unknown> = { meta: 'no braces here' };
    expect(repairDeclaredJsonArguments(properties, args).replacedKeys).toEqual([]);
    expect(args['meta']).toBe('no braces here');
  });
});

describe('the verbatim failing call through the registry and the tool', () => {
  it('is no longer refused, and writes the file', async () => {
    const tool = makeEditFileTool();
    // The file holds what the call's `old_str` asks for, so the edit can land.
    fs.writeFileSync(
      target,
      [
        '    expect(',
        "      findUnexpectedVsixFiles(['skills-lab/media-inspect/SKILL.md']),",
        "    ).toEqual(['skills-lab/media-inspect/SKILL.md']);",
        '  });',
      ].join('\n'),
    );
    const args: Record<string, unknown> = { path: target, edits: BROKEN_EDITS };
    expect(new ToolRegistry().invalidArgs(tool, args)).toBeUndefined();
    expect(Array.isArray(args['edits'])).toBe(true);
    await tool.handler(args);
    expect(fs.readFileSync(target, 'utf8')).toContain(
      "expect(findUnexpectedVsixFiles(['skills-lab/media-inspect/SKILL.md'])).toEqual([",
    );
  });

  it('still refuses an unescaped double quote inside the code, naming the position', () => {
    const tool = makeEditFileTool();
    const broken = '[{"new_str": "B["stone"]", "old_str": "y"}]';
    const refusal = new ToolRegistry().invalidArgs(tool, { path: target, edits: broken });
    expect(refusal).toContain('`edits` is not valid JSON at character');
  });
});

describe('jsonArgumentRepairNote', () => {
  it('names the key, the slip count and the repair phrases', () => {
    const report = {
      replacedKeys: ['edits'],
      repairs: ['a backslash with no valid escape was kept as a literal backslash at character 41'],
      total: 1,
    };
    expect(jsonArgumentRepairNote(report)).toBe(
      'Note: edits arrived as JSON text with 1 escape slip; read as: a backslash with no valid escape was kept as a literal backslash at character 41',
    );
  });

  it('returns undefined when nothing was replaced', () => {
    expect(jsonArgumentRepairNote({ replacedKeys: [], repairs: [], total: 0 })).toBeUndefined();
  });
});
