import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
  openNotebookDocument: vi.fn(),
  applyEdit: vi.fn(),
  replaceCells: vi.fn((range: unknown, cells: unknown[]) => ({ range, cells })),
  workspaceEditSet: vi.fn(),
}));

vi.mock('vscode', () => {
  class NotebookCellData {
    metadata: unknown;

    constructor(
      readonly kind: number,
      readonly value: string,
      readonly languageId: string,
    ) {}
  }

  class NotebookRange {
    constructor(
      readonly start: number,
      readonly end: number,
    ) {}
  }

  class WorkspaceEdit {
    set(uri: unknown, edits: unknown): void {
      vscodeMocks.workspaceEditSet(uri, edits);
    }
  }

  return {
    workspace: {
      openNotebookDocument: vscodeMocks.openNotebookDocument,
      applyEdit: vscodeMocks.applyEdit,
    },
    NotebookCellKind: { Code: 2 },
    NotebookCellData,
    NotebookRange,
    NotebookEdit: { replaceCells: vscodeMocks.replaceCells },
    WorkspaceEdit,
  };
});

vi.mock('../../src/util/WorkspacePaths', () => ({
  resolveWorkspaceUri: (path: string) => ({ fsPath: path }),
}));

import { makeEditNotebookCellTool, makeReadNotebookTool } from '../../src/tools/notebookTools';

function cell(
  index: number,
  source: string,
  kind = 2,
  languageId = 'typescript',
  outputs: unknown[] = [],
) {
  return {
    index,
    kind,
    document: { languageId, getText: () => source },
    outputs,
    metadata: { tags: [`cell-${index}`] },
  };
}

function notebook(cells: ReturnType<typeof cell>[]) {
  return {
    cellCount: cells.length,
    getCells: () => cells,
    cellAt: (index: number) => {
      const found = cells[index];
      if (!found) throw new Error(`No cell at ${index}`);
      return found;
    },
  };
}

describe('notebook tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vscodeMocks.applyEdit.mockResolvedValue(true);
  });

  it('reads every cell and reports source, kind, language, and output counts', async () => {
    vscodeMocks.openNotebookDocument.mockResolvedValue(
      notebook([cell(0, 'const n = 1;', 2, 'typescript', [{}]), cell(1, '# Notes', 1, 'markdown')]),
    );

    const result = await makeReadNotebookTool().handler({ path: 'notes.ipynb' });

    expect(JSON.parse(result)).toEqual({
      cell_count: 2,
      cells: [
        {
          index: 0,
          kind: 'code',
          language: 'typescript',
          source: 'const n = 1;',
          output_count: 1,
        },
        { index: 1, kind: 'markup', language: 'markdown', source: '# Notes', output_count: 0 },
      ],
    });
  });

  it('reads only the requested cell', async () => {
    vscodeMocks.openNotebookDocument.mockResolvedValue(
      notebook([cell(0, 'first'), cell(1, 'second', 1, 'markdown')]),
    );

    const result = await makeReadNotebookTool().handler({ path: 'notes.ipynb', cell_index: 1 });

    expect(JSON.parse(result)).toEqual({
      cell_count: 2,
      cells: [
        { index: 1, kind: 'markup', language: 'markdown', source: 'second', output_count: 0 },
      ],
    });
  });

  it('rejects an edit at or past the cell count before applying an edit', async () => {
    vscodeMocks.openNotebookDocument.mockResolvedValue(notebook([cell(0, 'source')]));

    await expect(
      makeEditNotebookCellTool().handler({ path: 'notes.ipynb', cell_index: 1, source: 'new' }),
    ).rejects.toThrow('cell_index 1 is outside this 1-cell notebook');

    expect(vscodeMocks.applyEdit).not.toHaveBeenCalled();
    expect(vscodeMocks.replaceCells).not.toHaveBeenCalled();
  });

  it('preserves the existing cell kind, language, and metadata on replacement', async () => {
    const previous = cell(0, 'old source', 1, 'markdown');
    vscodeMocks.openNotebookDocument.mockResolvedValue(notebook([previous]));

    await makeEditNotebookCellTool().handler({
      path: 'notes.ipynb',
      cell_index: 0,
      source: 'new source',
    });

    expect(vscodeMocks.replaceCells).toHaveBeenCalledTimes(1);
    const replacement = vscodeMocks.replaceCells.mock.results[0]?.value as {
      cells: Array<{ kind: number; value: string; languageId: string; metadata: unknown }>;
      range: { start: number; end: number };
    };
    expect(replacement.range).toEqual({ start: 0, end: 1 });
    expect(replacement.cells[0]).toMatchObject({
      kind: 1,
      value: 'new source',
      languageId: 'markdown',
      metadata: previous.metadata,
    });
    expect(vscodeMocks.workspaceEditSet).toHaveBeenCalledWith({ fsPath: 'notes.ipynb' }, [
      replacement,
    ]);
  });

  it('reports when VS Code rejects a notebook edit', async () => {
    vscodeMocks.openNotebookDocument.mockResolvedValue(notebook([cell(0, 'old source')]));
    vscodeMocks.applyEdit.mockResolvedValue(false);

    await expect(
      makeEditNotebookCellTool().handler({
        path: 'notes.ipynb',
        cell_index: 0,
        source: 'new source',
      }),
    ).rejects.toThrow('VS Code rejected the notebook edit');
  });
});
