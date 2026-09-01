#!/usr/bin/env node
/**
 * Generates CHANGELOG.md from CHANGES.md at package time.
 *
 * Both registries look for a file named CHANGELOG.md at the package root and
 * show a "No changelog available" tab when it is absent. This repo's changelog
 * has always been CHANGES.md, so every release since the first shipped without
 * one — and `.vscodeignore` excludes `*.md` with only README.md re-admitted, so
 * even a correctly named file would not have made it into the VSIX.
 *
 * A generated copy rather than a rename: CHANGES.md is referenced by CLAUDE.md,
 * docs/OWNERS.md and years of commit messages, and renaming it to satisfy a
 * packaging convention would churn all of that to fix a marketplace tab. The
 * copy is gitignored — it is a build artifact, and committing it would create a
 * second file that silently drifts from the real one.
 */

import { copyFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'CHANGES.md');
const target = join(root, 'CHANGELOG.md');

if (!existsSync(source)) {
  // Loud, not silent: shipping a release with no changelog is exactly the
  // failure this script exists to prevent, so it must not degrade quietly.
  console.error(`sync-changelog: ${source} is missing; cannot generate CHANGELOG.md.`);
  process.exit(1);
}

copyFileSync(source, target);
console.log('sync-changelog: CHANGELOG.md generated from CHANGES.md.');
