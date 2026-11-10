import * as path from 'path';
import * as fs from 'fs/promises';
import * as chunking from '../../src/search/chunking';
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
      files: {},
    } as unknown as SearchIndexFile);
    vi.spyOn(internals, 'saveIndex').mockResolvedValue();
    vi.spyOn(internals, 'findWorkspaceFiles').mockResolvedValue([]);
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
      return [];
    });
    build.mockImplementation(async () => []);
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

describe('IndexManager file freshness', () => {
  let root: string;
  let files: string[];
  let buildSeeds: ReturnType<typeof vi.spyOn>;
  let embedDocuments: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(process.cwd(), 'index-manager-'));
    files = [];
    vscode.workspace.workspaceFolders.splice(0, Infinity, { uri: vscode.Uri.file(root) });
    vi.spyOn(internals, 'findWorkspaceFiles').mockImplementation(async () => [...files]);
    vi.spyOn(internals, 'loadIndex').mockResolvedValue(null);
    vi.spyOn(EmbeddingClient.prototype, 'embedQuery').mockResolvedValue([1]);
    embedDocuments = vi.spyOn(EmbeddingClient.prototype, 'embedDocuments').mockResolvedValue([[1]]);
    buildSeeds = vi.spyOn(chunking, 'buildChunkSeeds').mockImplementation(async (document, relPath) => [{
      id: relPath,
      path: relPath,
      languageId: 'typescript',
      startLine: 1,
      endLine: 1,
      hash: 'hash',
      text: document.lineAt(0).text,
    }]);
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(async (glob) => {
      const requested = String(glob).includes('scope') ? files.filter((file) => file.startsWith('scope/')) : files;
      return requested.map((relPath) => ({ fsPath: path.join(root, relPath) }));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscode.workspace.workspaceFolders.splice(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('indexes a file created on disk after the index was built', async () => {
    const index = manager();
    await index.reindex();
    await fs.mkdir(path.join(root, 'scope'), { recursive: true });
    await fs.writeFile(path.join(root, 'scope/new.ts'), 'export const fresh = true;');
    files.push('scope/new.ts');

    const hits = await index.search('fresh', 5, 'scope/**');

    expect(hits[0]?.path).toBe('scope/new.ts');
    expect(embedDocuments).toHaveBeenCalledTimes(1);
    expect(buildSeeds).toHaveBeenCalledWith(expect.anything(), 'scope/new.ts', expect.any(Number), expect.anything(), expect.anything());
  });

  it('refreshes changed disk content and returns the new snippet', async () => {
    const index = manager();
    await fs.writeFile(path.join(root, 'changed.ts'), 'old text');
    files.push('changed.ts');
    await index.reindex();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(root, 'changed.ts'), 'new text');

    const hits = await index.search('updated');

    expect(hits[0]?.snippet).toBe('new text');
  });

  it('removes a deleted file and its chunks from the saved index', async () => {
    const index = manager();
    await fs.writeFile(path.join(root, 'deleted.ts'), 'remove me');
    files.push('deleted.ts');
    await index.reindex();
    await fs.rm(path.join(root, 'deleted.ts'));
    files = [];

    expect(await index.search('remove')).toEqual([]);
    const saved = await fs.readFile(path.join(root, '.forge/embeddings.index.json'), 'utf8');
    expect(JSON.parse(saved)).toMatchObject({ files: {}, chunks: [] });
  });

  it('does not embed unchanged files on a later search', async () => {
    const index = manager();
    await fs.writeFile(path.join(root, 'same.ts'), 'stable text');
    files.push('same.ts');
    await index.reindex();
    embedDocuments.mockClear();

    await index.search('stable');
    await index.search('stable again');

    expect(embedDocuments).not.toHaveBeenCalled();
  });

  it('rebuilds a version-5 index stored on disk', async () => {
    const index = manager();
    await fs.mkdir(path.join(root, '.forge'), { recursive: true });
    await fs.writeFile(path.join(root, '.forge/embeddings.index.json'), JSON.stringify({ version: 5 }));
    const load = vi.mocked(internals.loadIndex);
    load.mockRestore();
    const build = vi.spyOn(internals, 'buildChunksForPaths').mockResolvedValue([]);

    await index.search('q');

    expect(build).toHaveBeenCalledWith([]);
    expect(embedDocuments).not.toHaveBeenCalled();
  });
});
