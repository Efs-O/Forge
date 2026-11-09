import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { openNotebookOrExplain } from '../../src/tools/notebookTools';

/**
 * `openNotebookDocument` used to answer both mistakes below with an internal VS Code
 * string: `Missing viewType for '<percent-encoded uri>'` for a file that is not a
 * notebook, and a bare `Unable to resolve nonexistent file '…'` for a missing one.
 * Neither names the tool, the file's real type, or the tool to use instead, so the agent
 * could not act on it (lab arm U5a, 2026-11-09). These pin the replacement text whole.
 */
const uriOf = (fsPath: string) => ({ fsPath, scheme: 'file' }) as vscode.Uri;

const messageFrom = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => '',
    (err: Error) => err.message,
  );

describe('notebook tool argument errors (lab arm U5a)', () => {
  it('says a plain text file is not a notebook, and names the tool to use instead', async () => {
    expect(
      await messageFrom(
        openNotebookOrExplain(
          'read_notebook',
          'scratch/lab-fc1a.txt',
          uriOf('n:\\vs code apps\\Forge\\scratch\\lab-fc1a.txt'),
        ),
      ),
    ).toBe(
      'read_notebook: "scratch/lab-fc1a.txt" is not a notebook (.ipynb). Use read_file for a plain text file.',
    );
  });

  it('says the same thing for edit_notebook_cell, naming that tool', async () => {
    expect(await messageFrom(openNotebookOrExplain('edit_notebook_cell', 'notes.txt', uriOf('n:\\notes.txt')))).toBe(
      'edit_notebook_cell: "notes.txt" is not a notebook (.ipynb). Use read_file for a plain text file.',
    );
  });
});
