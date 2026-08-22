/**
 * Pre-spawn and pre-adopt checks on a model's files.
 *
 * Split out of `DirectBackend`: both answer "is this the model we think it is?"
 * before anything irreversible happens — spawning a server against a missing
 * file, or adopting one that is serving something else.
 */

import { existsSync } from 'fs';
import type { ModelConfig } from '../config/types';

/**
 * Fail with a clear, specific message when a configured GGUF/mmproj file is
 * absent — llama-server would otherwise exit code 1 and bury the cause.
 */
export function assertModelFilesExist(model: ModelConfig): void {
  const files: Array<readonly [string, string | undefined]> = [
    ['gguf_path', model.gguf_path],
    ['mmproj_path', model.mmproj_path],
  ];
  for (const [field, filePath] of files) {
    if (filePath && !existsSync(filePath)) {
      throw new Error(
        `Model "${model.name}": ${field} not found on disk: ${filePath}. ` +
          `Fix the path in config.yaml or restore the file.`,
      );
    }
  }
}

/**
 * True when the identifier reported by a running server matches the model we
 * want to load. llama-server reports the `-m` path, so we compare against the
 * model's gguf_path by normalized full path and by basename (the server build
 * may report either). Returns false when the served model is unknown — we
 * refuse to adopt rather than risk serving the wrong model.
 */
export function servedModelMatches(served: string | null, model: ModelConfig): boolean {
  if (!served || !model.gguf_path) return false;
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const base = (p: string): string => norm(p).split('/').pop() ?? norm(p);
  return norm(served) === norm(model.gguf_path) || base(served) === base(model.gguf_path);
}
