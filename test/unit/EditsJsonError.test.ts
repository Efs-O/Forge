import { describe, expect, it } from 'vitest';
import { editFileStringError } from '../../src/tools/editsJsonError';

// A low-bit model writes `edits` as JSON text by hand and slips on one escape
// now and then (docs/reports/EDIT_FILE_BROKEN_JSON_2026_11_21.md, local only).
// The refusal names where and what, and steers the retry to the single-edit
// form, whose top-level strings need no JSON escaping.
describe('editFileStringError', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ path: 'a.ts', edits: "[{\"old_str\": \"a\", \"new_str\": \"x([\\\n  y\"}]" },
      "Error: `edits` is not valid JSON at character 35: a backslash stands right before a line break; inside a JSON string a line break is written \\n. Near it: …ld_str\": \"a\", \"new_str\": \"x([\\⟨here⟩⏎  y\"}]… Resend it as one edit_file call per edit, each with top-level \"path\", \"old_str\" and \"new_str\": those take the text as written, with no JSON escaping."],
    [{ path: 'a.ts', edits: "[{\"old_str\": \"a\", \"new_str\": \"x;\\const y\"}]" },
      "Error: `edits` is not valid JSON at character 34: a backslash is followed by \"c\", which JSON does not allow; inside a JSON string a backslash is written \\\\ and a line break \\n. Near it: …old_str\": \"a\", \"new_str\": \"x;\\⟨here⟩const y\"}]… Resend it as one edit_file call per edit, each with top-level \"path\", \"old_str\" and \"new_str\": those take the text as written, with no JSON escaping."],
    [{ path: 'a.ts', edits: "[{\"old_str\": \"a\", \"new_str\": \"x \\ y\"}]" },
      "Error: `edits` is not valid JSON at character 34: a backslash is followed by a space, which JSON does not allow; inside a JSON string a backslash is written \\\\ and a line break \\n. Near it: …old_str\": \"a\", \"new_str\": \"x \\⟨here⟩ y\"}]… Resend it as one edit_file call per edit, each with top-level \"path\", \"old_str\" and \"new_str\": those take the text as written, with no JSON escaping."],
    [{ path: 'a.ts', edits: "[{\"old_str\": \"a\", \"new_str\": \"say \"hi\" now\"}]" },
      "Error: `edits` is not valid JSON at character 36: this is often a double quote inside \"old_str\" or \"new_str\" that is not written as \\\". Near it: …d_str\": \"a\", \"new_str\": \"say \"⟨here⟩hi\" now\"}]… Resend it as one edit_file call per edit, each with top-level \"path\", \"old_str\" and \"new_str\": those take the text as written, with no JSON escaping."],
    [{ path: 'a.ts', edits: "[{\"old_str\": \"a\", \"new_str\": \"abc" },
      "Error: `edits` is not valid JSON at character 34: the text ends inside a string, so a closing quote is missing or the list was cut off. Near it: …old_str\": \"a\", \"new_str\": \"abc⟨here⟩… Resend it as one edit_file call per edit, each with top-level \"path\", \"old_str\" and \"new_str\": those take the text as written, with no JSON escaping."],
    [{ edits: "{\"old_str\"" },
      "Error: missing required `path`. `edits` is not valid JSON at character 11: this is often a double quote inside \"old_str\" or \"new_str\" that is not written as \\\". Near it: …{\"old_str\"⟨here⟩… Resend it as one edit_file call per edit, each with top-level \"path\", \"old_str\" and \"new_str\": those take the text as written, with no JSON escaping."],
  ];

  it.each(cases)('names the position, the slip and the single-edit form for %j', (args, expected) => {
    expect(editFileStringError(args)).toBe(expected);
  });

  it('keeps the valid-JSON-string refusal as it was', () => {
    expect(editFileStringError({ path: 'a.ts', edits: '[]' })).toBe(
      'Error: `edits` arrived as a string, not an array. Send `edits` as a JSON array of { "old_str": "...", "new_str": "..." } objects.',
    );
  });

  it('leaves an array or a missing edits alone', () => {
    expect(editFileStringError({ path: 'a.ts', edits: [{ old_str: 'a', new_str: 'b' }] })).toBeUndefined();
    expect(editFileStringError({ path: 'a.ts', old_str: 'a', new_str: 'b' })).toBeUndefined();
  });
});
