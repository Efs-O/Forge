import { describe, expect, it } from 'vitest';
import {
  generatedImagePath,
  isFailureResult,
  readPathArg,
  rendersAsMarkdown,
  resultLabel,
} from '../../src/sidebar/toolResultView';
import { capDisplayText, MAX_DISPLAY_RESULT_CHARS } from '../../src/tools/resultCap';
import { workspaceFileUri } from '../../webview-ui/src/workspaceRootUri';

describe('resultLabel', () => {
  it('labels a read-only call with its path argument', () => {
    expect(resultLabel('read_file', 'file contents here', 'src/a.ts')).toBe('src/a.ts');
  });

  it('falls back to the first line when a read-only call has no path', () => {
    expect(resultLabel('search_code', 'hit one\nhit two', null)).toBe('hit one');
  });

  it('uses only the first line of a multi-line result', () => {
    expect(resultLabel('delegate_to_agent', 'Summary line\n\nDetails below', null)).toBe(
      'Summary line',
    );
  });

  it('strips listing markers', () => {
    expect(resultLabel('list_directory', '[dir] src', null)).toBe('src');
  });

  it('truncates an overlong first line', () => {
    const label = resultLabel('write_file', 'x'.repeat(500), null);
    expect(label).toHaveLength(121);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('capDisplayText', () => {
  it('leaves a short result untouched, newlines and all', () => {
    const text = 'line one\nline two\n\nline four';
    expect(capDisplayText(text)).toEqual({ text, totalChars: text.length });
  });

  it('preserves newlines in a long delegate report', () => {
    const report = Array.from({ length: 400 }, (_, i) => `## Section ${i}\n\nbody text`).join('\n');
    const capped = capDisplayText(report);
    expect(capped.text).toContain('\n');
    expect(capped.totalChars).toBe(report.length);
  });

  it('marks what it cut and reports the original size', () => {
    const text = 'a'.repeat(MAX_DISPLAY_RESULT_CHARS + 500);
    const capped = capDisplayText(text);
    expect(capped.text).toContain(
      `[truncated for display — showing ${MAX_DISPLAY_RESULT_CHARS} of ${text.length} chars]`,
    );
    expect(capped.totalChars).toBe(text.length);
  });

  it('shows far more than the 600-char preview it replaced', () => {
    const text = 'b'.repeat(5000);
    expect(capDisplayText(text).text).toBe(text);
  });
});

describe('readPathArg / isFailureResult', () => {
  it('accepts either argument spelling', () => {
    expect(readPathArg({ path: 'a.ts' })).toBe('a.ts');
    expect(readPathArg({ filepath: 'b.ts' })).toBe('b.ts');
    expect(readPathArg({ other: 1 })).toBeNull();
    expect(readPathArg(undefined)).toBeNull();
  });

  it('detects tool failures and refusals', () => {
    expect(isFailureResult('Error: nope')).toBe(true);
    expect(isFailureResult('User declined: write_file')).toBe(true);
    expect(isFailureResult('wrote 12 lines')).toBe(false);
  });
});

describe('rendersAsMarkdown', () => {
  it('renders a delegated agent report as prose', () => {
    expect(rendersAsMarkdown('ask_local_agent')).toBe(true);
    expect(rendersAsMarkdown('web_search')).toBe(true);
  });

  it('keeps file and command output verbatim', () => {
    // A YAML/shell/Python comment line is not a heading.
    expect(rendersAsMarkdown('read_file')).toBe(false);
    expect(rendersAsMarkdown('exec_command')).toBe(false);
    expect(rendersAsMarkdown('git_diff')).toBe(false);
    expect(rendersAsMarkdown('unknown_tool')).toBe(false);
  });
});

describe('generatedImagePath', () => {
  const ok =
    'Generated image saved to generated-images/20260914-a fox (1).jpg (image/jpeg, 130,038 bytes) with backend grok-imagine.\nSent to 1 remote chat(s).';

  it('reads the saved path back from a successful generate_image result', () => {
    expect(generatedImagePath('generate_image', ok)).toBe('generated-images/20260914-a fox (1).jpg');
  });

  it('ignores other tools, failures, and paths that leave the workspace', () => {
    expect(generatedImagePath('write_file', ok)).toBeUndefined();
    expect(generatedImagePath('generate_image', 'Error: grok-imagine: HTTP 401')).toBeUndefined();
    expect(
      generatedImagePath('generate_image', 'Generated image saved to ../outside.png (image/png'),
    ).toBeUndefined();
    expect(
      generatedImagePath('generate_image', 'Generated image saved to C:/x/a.png (image/png'),
    ).toBeUndefined();
  });

  it('builds an encoded thumbnail URL under the workspace root URI', () => {
    expect(workspaceFileUri('https://file.vscode-resource/N:/ws/', 'art/a fox (1).jpg')).toBe(
      'https://file.vscode-resource/N:/ws/art/a%20fox%20(1).jpg',
    );
  });
});
