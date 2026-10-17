import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ visibleTextEditors: [] as unknown[] }));

vi.mock('vscode', () => ({
  window: {
    visibleTextEditors: mocks.visibleTextEditors,
    createTextEditorDecorationType: vi.fn(() => ({})),
    onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
  },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  Range: class {
    constructor(
      readonly startLine: number,
      readonly startCharacter: number,
      readonly endLine: number,
      readonly endCharacter: number,
    ) {}
  },
  OverviewRulerLane: { Right: 4 },
}));

import * as vscode from 'vscode';
import { DiffDecorations } from '../../src/sidebar/DiffDecorations';

interface FakeEditor {
  document: { uri: { fsPath: string } };
  setDecorations: ReturnType<typeof vi.fn>;
}

function editor(file: string): FakeEditor {
  return {
    document: { uri: { fsPath: file } },
    setDecorations: vi.fn(),
  };
}

describe('DiffDecorations', () => {
  let directory: string | undefined;

  afterEach(() => {
    mocks.visibleTextEditors.length = 0;
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
    vi.restoreAllMocks();
  });

  it('clears pending highlights when a later write restores the original content', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-diff-decorations-'));
    const file = path.join(directory, 'changed.txt');
    const visible = editor(file);
    mocks.visibleTextEditors.push(visible);
    const decorations = new DiffDecorations();

    fs.writeFileSync(file, 'after');
    decorations.apply(file, 'before');
    expect(visible.setDecorations).toHaveBeenCalledWith(expect.anything(), expect.any(Array));
    visible.setDecorations.mockClear();

    fs.writeFileSync(file, 'before');
    decorations.apply(file, 'before');

    expect(visible.setDecorations).toHaveBeenCalledTimes(2);
    expect(visible.setDecorations).toHaveBeenNthCalledWith(1, expect.anything(), []);
    expect(visible.setDecorations).toHaveBeenNthCalledWith(2, expect.anything(), []);
  });

  it('clears pending highlights when the changed file disappears', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-diff-decorations-'));
    const file = path.join(directory, 'changed.txt');
    const visible = editor(file);
    mocks.visibleTextEditors.push(visible);
    const decorations = new DiffDecorations();

    fs.writeFileSync(file, 'after');
    decorations.apply(file, 'before');
    visible.setDecorations.mockClear();

    fs.rmSync(file);
    decorations.apply(file, 'before');

    expect(visible.setDecorations).toHaveBeenCalledTimes(2);
    expect(visible.setDecorations).toHaveBeenNthCalledWith(1, expect.anything(), []);
    expect(visible.setDecorations).toHaveBeenNthCalledWith(2, expect.anything(), []);
  });
});
