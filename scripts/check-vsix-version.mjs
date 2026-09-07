/**
 * Refuses to package a version that is already sitting at the repo root.
 *
 * `vsce package` overwrites `forge-llm-<version>.vsix` in place with no
 * warning, so re-packaging without a version bump silently replaces the artifact
 * you were about to compare against — and the two builds become
 * indistinguishable after the fact. An audited session did exactly this: asked
 * to "build a new version VSIX", it packaged at the current version and nobody
 * noticed until later.
 *
 * This is a mechanical guarantee, not a reminder: a prompt rule about bumping
 * the version costs tokens on every turn and is forgotten on the one that
 * matters.
 *
 * `FORGE_ALLOW_VSIX_OVERWRITE=1` is the deliberate escape hatch — a rebuild of
 * the same version after a failed publish is legitimate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const target = `${name}-${version}.vsix`;

if (existsSync(join(root, target)) && process.env.FORGE_ALLOW_VSIX_OVERWRITE !== '1') {
  console.error(
    `\n${target} already exists.\n\n` +
      `Packaging again would overwrite it, leaving two different builds with one\n` +
      `filename. Bump "version" in package.json first, or delete ${target}.\n\n` +
      `To rebuild this exact version on purpose:\n` +
      `  FORGE_ALLOW_VSIX_OVERWRITE=1 npm run package\n`,
  );
  process.exit(1);
}
