#!/usr/bin/env node
/**
 * Extracts one version's section from CHANGES.md, for a GitHub Release body.
 *
 * The Publish workflow shipped VSIXes to both registries but never created a
 * GitHub Release, so the repo's own releases page stopped at v0.12.29 in July
 * while 0.13, 0.14 and 0.15 went out — anyone reading the source had no record
 * of what shipped. CHANGES.md is already the canonical account, so the release
 * body is cut from it rather than written twice and left to drift.
 *
 * Usage: node scripts/release-notes.mjs <version> [outfile]
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const version = process.argv[2];
if (!version) {
  console.error('release-notes: a version argument is required (e.g. 0.15.1).');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(root, 'CHANGES.md'), 'utf8').split(/\r?\n/);

// Headings carry trailing prose on some entries ("## 0.13.4 — video frames"),
// so match the version as a whole token rather than the whole line.
const isHeading = (line) => /^## /.test(line);
const start = lines.findIndex((line) => isHeading(line) && line.slice(3).trim().split(/[\s—-]/)[0] === version);

if (start === -1) {
  // Loud: a release whose notes silently came out empty is the failure this
  // script exists to prevent, and the tag is already pushed by this point.
  console.error(`release-notes: no "## ${version}" section in CHANGES.md.`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (isHeading(lines[i])) {
    end = i;
    break;
  }
}

const body =
  lines
    .slice(start + 1, end)
    .join('\n')
    .trim() + `\n\nFull changelog: https://github.com/Efs-O/Forge/blob/v${version}/CHANGES.md\n`;

const outfile = process.argv[3];
if (outfile) writeFileSync(outfile, body);
else process.stdout.write(body);
