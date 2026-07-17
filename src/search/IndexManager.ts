import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../config/types';
import { EmbeddingBackend } from '../backend/EmbeddingBackend';
import { EmbeddingClient } from './EmbeddingClient';
import { buildChunkSeeds } from './chunking';
import { cosineSimilarity } from './semanticMath';
import { DEFAULT_PROMPT_STYLE, type EmbeddingPromptStyle } from './embeddingPrompts';
import type { SearchChunk, SearchHit, SearchIndexFile, SearchResultSummary } from './types';

const INDEX_VERSION = 2;
const DEFAULT_INCLUDE_GLOBS = ['**/*'];
const DEFAULT_EXCLUDE_GLOBS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/out/**',
  '**/.git/**',
  '**/.forge/**',
];
const DEFAULT_MAX_FILE_SIZE_KB = 256;
const EMBEDDING_BATCH_SIZE = 24;

export class IndexManager {
  private readonly client: EmbeddingClient;
  private index: SearchIndexFile | null = null;
  private indexLoaded = false;
  private readonly dirtyPaths = new Set<string>();
  private pendingSave = false;

  constructor(
    private config: ForgeConfig,
    private readonly backend: EmbeddingBackend,
  ) {
    this.client = new EmbeddingClient(
      () => this.backend.baseUrl(),
      () => this.promptStyle(),
    );
  }

  applyForgeConfig(next: ForgeConfig): void {
    this.config = next;
    this.backend.applyForgeConfig(next);
    this.indexLoaded = false;
  }

  markDirty(fsPath: string): void {
    const normalized = this.toWorkspaceRelative(fsPath);
    if (!normalized) return;
    this.dirtyPaths.add(normalized);
  }

  removePath(fsPath: string): void {
    const normalized = this.toWorkspaceRelative(fsPath);
    if (!normalized) return;
    this.dirtyPaths.delete(normalized);
    if (!this.index) return;
    const before = this.index.chunks.length;
    this.index.chunks = this.index.chunks.filter((chunk) => chunk.path !== normalized);
    if (this.index.chunks.length !== before) this.pendingSave = true;
  }

  async reindex(): Promise<SearchResultSummary> {
    this.ensureEmbeddingsEnabled();
    await this.backend.start();

    const paths = await this.findWorkspaceFiles();
    const chunks = await this.buildChunksForPaths(paths);
    this.index = {
      version: INDEX_VERSION,
      workspaceRoot: this.workspaceRoot(),
      modelPath: this.modelPath(),
      includeGlobs: this.includeGlobs(),
      excludeGlobs: this.excludeGlobs(),
      maxFileSizeKb: this.maxFileSizeKb(),
      promptStyle: this.promptStyle(),
      builtAt: Date.now(),
      chunks,
    };
    this.indexLoaded = true;
    this.dirtyPaths.clear();
    this.pendingSave = false;
    await this.saveIndex();

    return {
      filesIndexed: new Set(chunks.map((chunk) => chunk.path)).size,
      chunksIndexed: chunks.length,
    };
  }

  async search(query: string, topK = 5, scopeGlob?: string): Promise<SearchHit[]> {
    this.ensureEmbeddingsEnabled();
    await this.backend.start();
    await this.ensureIndexReady();
    if (!this.index) return [];

    if (this.dirtyPaths.size > 0) {
      await this.refreshDirtyPaths();
      if (this.pendingSave) await this.saveIndex();
    }

    const queryEmbedding = await this.client.embedQuery(query);
    const scopedPaths = scopeGlob ? await this.findScopedPaths(scopeGlob) : null;
    return this.index.chunks
      .filter((chunk) => scopedPaths === null || scopedPaths.has(chunk.path))
      .map((chunk) => ({
        path: chunk.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: cosineSimilarity(queryEmbedding, chunk.embedding),
        snippet: chunk.text,
        ...(chunk.symbolName ? { symbolName: chunk.symbolName } : {}),
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, topK);
  }

  private async ensureIndexReady(): Promise<void> {
    if (!this.indexLoaded) {
      this.index = await this.loadIndex();
      this.indexLoaded = true;
    }

    if (this.index) return;
    if (this.config.embeddings?.auto_index_on_search === false) {
      throw new Error(
        'Forge: semantic index missing. Run /reindex or Forge: Reindex Codebase Search Index first.',
      );
    }
    await this.reindex();
  }

  private async refreshDirtyPaths(): Promise<void> {
    if (!this.index) return;
    const dirty = [...this.dirtyPaths];
    if (dirty.length === 0) return;

    const replacements = await this.buildChunksForPaths(dirty);
    const replacementMap = new Map<string, SearchChunk[]>();
    for (const chunk of replacements) {
      const current = replacementMap.get(chunk.path) ?? [];
      current.push(chunk);
      replacementMap.set(chunk.path, current);
    }

    const dirtySet = new Set(dirty);
    const nextChunks = this.index.chunks.filter((chunk) => !dirtySet.has(chunk.path));
    for (const relPath of dirty) {
      const chunks = replacementMap.get(relPath);
      if (chunks) nextChunks.push(...chunks);
    }

    this.index.chunks = nextChunks;
    this.index.builtAt = Date.now();
    this.dirtyPaths.clear();
    this.pendingSave = true;
  }

  private async buildChunksForPaths(relativePaths: string[]): Promise<SearchChunk[]> {
    const chunks: SearchChunk[] = [];
    for (const relPath of relativePaths) {
      const doc = await this.openEligibleDocument(relPath);
      if (!doc) continue;
      const seeds = await buildChunkSeeds(doc, relPath);
      for (let offset = 0; offset < seeds.length; offset += EMBEDDING_BATCH_SIZE) {
        const batch = seeds.slice(offset, offset + EMBEDDING_BATCH_SIZE);
        const embeddings = await this.client.embedDocuments(batch.map((seed) => seed.text));
        batch.forEach((seed, index) => {
          const embedding = embeddings[index];
          if (!embedding) return;
          chunks.push({
            id: seed.id,
            path: seed.path,
            languageId: seed.languageId,
            startLine: seed.startLine,
            endLine: seed.endLine,
            hash: seed.hash,
            text: seed.text,
            embedding,
            ...(seed.symbolName ? { symbolName: seed.symbolName } : {}),
          });
        });
      }
    }
    return chunks;
  }

  private async openEligibleDocument(relativePath: string): Promise<vscode.TextDocument | null> {
    const uri = vscode.Uri.file(path.join(this.workspaceRoot(), relativePath));
    try {
      const stat = await fs.stat(uri.fsPath);
      if (stat.size > this.maxFileSizeKb() * 1024) return null;
      return await vscode.workspace.openTextDocument(uri);
    } catch {
      return null;
    }
  }

  private async findWorkspaceFiles(): Promise<string[]> {
    const found = new Set<string>();
    const exclude = this.excludePattern();
    for (const include of this.includeGlobs()) {
      const matches = await vscode.workspace.findFiles(include, exclude);
      for (const match of matches) {
        const relative = this.toWorkspaceRelative(match.fsPath);
        if (relative) found.add(relative);
      }
    }
    return [...found].sort();
  }

  private async findScopedPaths(scopeGlob: string): Promise<Set<string>> {
    const found = await vscode.workspace.findFiles(scopeGlob, this.excludePattern());
    const scoped = new Set<string>();
    for (const match of found) {
      const relative = this.toWorkspaceRelative(match.fsPath);
      if (relative) scoped.add(relative);
    }
    return scoped;
  }

  private async loadIndex(): Promise<SearchIndexFile | null> {
    try {
      const raw = await fs.readFile(this.indexPath(), 'utf8');
      const parsed = JSON.parse(raw) as SearchIndexFile;
      if (!this.isCompatibleIndex(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async saveIndex(): Promise<void> {
    if (!this.index) return;
    await fs.mkdir(path.dirname(this.indexPath()), { recursive: true });
    await fs.writeFile(this.indexPath(), JSON.stringify(this.index, null, 2), 'utf8');
    this.pendingSave = false;
  }

  private isCompatibleIndex(index: SearchIndexFile): boolean {
    return (
      index.version === INDEX_VERSION &&
      index.workspaceRoot === this.workspaceRoot() &&
      index.modelPath === this.modelPath() &&
      JSON.stringify(index.includeGlobs) === JSON.stringify(this.includeGlobs()) &&
      JSON.stringify(index.excludeGlobs) === JSON.stringify(this.excludeGlobs()) &&
      index.maxFileSizeKb === this.maxFileSizeKb() &&
      // Vectors are only comparable within one prompt style. An index written
      // before prompt_style existed has `undefined` here and correctly rebuilds.
      index.promptStyle === this.promptStyle()
    );
  }

  private promptStyle(): EmbeddingPromptStyle {
    return this.config.embeddings?.prompt_style ?? DEFAULT_PROMPT_STYLE;
  }

  private ensureEmbeddingsEnabled(): void {
    if (!this.config.embeddings?.enabled) {
      throw new Error(
        'Forge: embeddings are disabled. Enable the embeddings block in config.yaml first.',
      );
    }
    if (!this.config.embeddings.model_path) {
      throw new Error('Forge: embeddings.model_path is required.');
    }
  }

  private includeGlobs(): string[] {
    const configured = this.config.embeddings?.include_globs;
    return configured && configured.length > 0 ? configured : DEFAULT_INCLUDE_GLOBS;
  }

  private excludeGlobs(): string[] {
    const configured = this.config.embeddings?.exclude_globs;
    return configured && configured.length > 0 ? configured : DEFAULT_EXCLUDE_GLOBS;
  }

  private excludePattern(): string | undefined {
    const exclude = this.excludeGlobs();
    if (exclude.length === 0) return undefined;
    return `{${exclude.join(',')}}`;
  }

  private maxFileSizeKb(): number {
    return this.config.embeddings?.max_file_size_kb ?? DEFAULT_MAX_FILE_SIZE_KB;
  }

  private modelPath(): string {
    return path.resolve(this.config.embeddings?.model_path ?? '');
  }

  private indexPath(): string {
    return path.join(this.workspaceRoot(), '.forge', 'embeddings.index.json');
  }

  private workspaceRoot(): string {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) throw new Error('Forge: no workspace folder open.');
    return root;
  }

  private toWorkspaceRelative(fsPath: string): string | null {
    const root = this.workspaceRoot();
    const relative = path.relative(root, fsPath);
    if (!relative || relative.startsWith('..')) return null;
    return relative.replace(/\\/g, '/');
  }
}
