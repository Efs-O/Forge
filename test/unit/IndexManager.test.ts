import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { IndexManager } from '../../src/search/IndexManager';
import { EmbeddingClient } from '../../src/search/EmbeddingClient';
import type { EmbeddingBackend } from '../../src/backend/EmbeddingBackend';
import type { ForgeConfig } from '../../src/config/types';
import type { SearchChunk, SearchIndexFile } from '../../src/search/types';

const ROOT = path.resolve('/ws');

/** The private seams these tests drive: the embedding build, and index I/O. */
interface Internals {
  buildChunksForPaths(paths: string[]): Promise<SearchChunk[]>;
  findWorkspaceFiles(): Promise<string[]>;
  loadIndex(): Promise<SearchIndexFile | null>;
  saveIndex(): Promise<void>;
}
const internals = IndexManager.prototype as unknown as Internals;

function chunk(relPath: string): SearchChunk {
  return {
    id: relPath,
    path: relPath,
    languageId: 'typescript',
    startLine: 1,
    endLine: 1,
    hash: relPath,
    text: relPath,
    embedding: [1],
  };
}

function manager(): IndexManager {
  const config = { embeddings: { enabled: true, model_path: 'embed.gguf' } } as ForgeConfig;
  const backend = {
    start: async () => {},
    withActivity: <T>(operation: () => Promise<T>) => operation(),
    baseUrl: () => 'http://127.0.0.1:1',
  } as unknown as EmbeddingBackend;
  return new IndexManager(config, backend);
}

describe('IndexManager dirty paths (D-01)', () => {
  let build: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(ROOT) });
    vi.spyOn(EmbeddingClient.prototype, 'embedQuery').mockResolvedValue([1]);
    vi.spyOn(internals, 'loadIndex').mockResolvedValue({
      chunks: [],
    } as unknown as SearchIndexFile);
    vi.spyOn(internals, 'saveIndex').mockResolvedValue();
    vi.spyOn(internals, 'findWorkspaceFiles').mockResolvedValue(['a.ts']);
    build = vi.spyOn(internals, 'buildChunksForPaths');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscode.workspace.workspaceFolders.splice(0);
  });

  it('keeps a file saved while its old text was being embedded', async () => {
    const index = manager();
    index.markDirty(path.join(ROOT, 'a.ts'));
    build.mockImplementationOnce(async (paths: string[]) => {
      index.markDirty(path.join(ROOT, 'a.ts')); // saved again mid-embedding
      return paths.map(chunk);
    });
    build.mockImplementation(async (paths: string[]) => paths.map(chunk));
    await index.search('q');
    await index.search('q');
    expect(build).toHaveBeenNthCalledWith(2, ['a.ts']);
  });

  it('keeps the marks when the embedding fails', async () => {
    const index = manager();
    index.markDirty(path.join(ROOT, 'a.ts'));
    build.mockRejectedValueOnce(new Error('embedding server down'));
    build.mockImplementation(async (paths: string[]) => paths.map(chunk));
    await expect(index.search('q')).rejects.toThrow('embedding server down');
    await index.search('q');
    expect(build).toHaveBeenNthCalledWith(2, ['a.ts']);
  });

  it('a reindex keeps the marks made during its own build', async () => {
    const index = manager();
    build.mockImplementationOnce(async (paths: string[]) => {
      index.markDirty(path.join(ROOT, 'b.ts'));
      return paths.map(chunk);
    });
    build.mockImplementation(async (paths: string[]) => paths.map(chunk));
    await index.reindex();
    await index.search('q');
    expect(build).toHaveBeenNthCalledWith(2, ['b.ts']);
  });
});
