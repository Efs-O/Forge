import * as fs from 'fs';
import * as path from 'path';

const CONTACT_INSTRUCTIONS = path.join('.forge', 'contact-instructions.md');
const MAX_CONTACT_INSTRUCTIONS_BYTES = 20_000;

/** Reads the contact-only prompt without joining the normal FORGE.md chain. */
export class ContactInstructionsLoader {
  constructor(private readonly workspaceRoot?: string) {}

  load(): string | undefined {
    if (!this.workspaceRoot) return undefined;
    const root = path.resolve(this.workspaceRoot);
    const candidate = path.resolve(root, CONTACT_INSTRUCTIONS);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    try {
      if (!fs.statSync(candidate).isFile()) return undefined;
      const realRoot = fs.realpathSync(root);
      const realCandidate = fs.realpathSync(candidate);
      const realRelative = path.relative(realRoot, realCandidate);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) return undefined;
      const bytes = fs.readFileSync(realCandidate);
      if (bytes.length > MAX_CONTACT_INSTRUCTIONS_BYTES) {
        throw new Error(
          `Forge contact instructions exceed ${MAX_CONTACT_INSTRUCTIONS_BYTES} bytes.`,
        );
      }
      const text = bytes.toString('utf8').trim();
      return text || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
}

export const contactInstructionsPath = CONTACT_INSTRUCTIONS;
