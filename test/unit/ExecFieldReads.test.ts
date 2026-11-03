import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * The CI row `docs/plans/SECURITY_SIMPLIFICATION_PLAN.md` §3 phase 2 asks for: a
 * consumer that reads a model's exec fields (`start_command`, `stop_command`,
 * `unload_path`, `llama_server_binary`) straight out of `config.models` fails
 * here, because since phase 2 those fields can live in `~/.forge/policy.yaml`
 * under the model's `engine` and a raw read reports them as absent.
 *
 * The failure this prevents is the quiet kind: `ChatMode.ts` used to read
 * `start_command[3]` from `config.models` to tell solo from multi, and a migrated
 * Strata would have answered "this model has no solo/multi setting" — a feature
 * that disappears with no error anywhere. Reading through the resolver
 * (`resolveModelEntry`, `mergeGroupsIntoModel`, `resolveRequestModel`,
 * `resolveSpawnModel`) is what makes the answer right, so that is what a file
 * that touches `config.models` and an exec field must do.
 *
 * The files that own the exec-field vocabulary are exempt: the resolver that
 * folds engines, the schemas that validate and describe the fields, and the policy
 * files that move them.
 */
const SRC_ROOT = path.resolve(import.meta.dirname, '../../src');
const FIELDS = ['start_command', 'stop_command', 'unload_path', 'llama_server_binary'];

/** Files that define or fold these fields, so reading them is the job, not a bug. */
const EXEMPT = new Set([
  'config/ConfigResolver.ts',
  'config/modelSchema.ts',
  'config/modelTypes.ts',
  'config/schema.ts',
  'config/types.ts',
  'config/engineSchema.ts',
  'config/policySchema.ts',
  'config/PolicyLoader.ts',
  'config/policyMigration.ts',
  'config/policyYamlNodes.ts',
  'config/ConfigWriterHelpers.ts',
]);

/** Anything that flattens a model before using it counts as reading through the
 *  resolver, which is the point of the rule. */
const RESOLVER_MARKERS = [
  'resolveModelEntry',
  'mergeGroupsIntoModel',
  'resolveRequestModel',
  'resolveSpawnModel',
];

function walk(dir: string, into: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(child, into);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) into.push(child);
  }
}

describe('exec fields are read through the resolver, never out of config.models', () => {
  it('every file that reads one has folded the model first', () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    const offenders: string[] = [];

    for (const file of files) {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      if (EXEMPT.has(relative)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const readsField = FIELDS.some((field) => new RegExp(`\\.${field}\\b`).test(text));
      if (!readsField) continue;
      // A file that never touches `config.models` gets its model from somewhere
      // that already flattened it — a resolver call, a pool acquire, a webview
      // message — so it is not what this rule is about.
      if (!/\bmodels\.(find|some|map|flatMap|filter)\(/.test(text) && !/\.models\b/.test(text))
        continue;
      if (RESOLVER_MARKERS.some((marker) => text.includes(marker))) continue;
      offenders.push(relative);
    }

    expect(offenders).toEqual([]);
  });

  it('the resolver itself is the only place that folds an engine', () => {
    // `applyEngine` is private to `ConfigResolver.ts`: a second implementation
    // somewhere else is how the two files drift apart without anyone noticing.
    const files: string[] = [];
    walk(SRC_ROOT, files);
    const faders = files
      .filter((file) => fs.readFileSync(file, 'utf8').includes('function applyEngine'))
      .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join('/'));
    expect(faders).toEqual(['config/ConfigResolver.ts']);
  });

  it('nothing in src/ lets an environment variable pick the policy file', () => {
    // An agent's own shell can set a variable — `setx FORGE_POLICY_PATH
    // <workspace>\p.yaml` — so an env override in `src/` would let the next VS
    // Code start read its permissions, host list and engines from a file the
    // agent can write, which is exactly what phase 3's `Forge: Lock policy.yaml`
    // is meant to make impossible. The tests stay hermetic by stubbing
    // `defaultPolicyPath` in `test/support/tempGuard.setup.ts` instead.
    const files: string[] = [];
    walk(SRC_ROOT, files);
    const readers = files
      .filter((file) =>
        /\bprocess\.env\.[A-Z_]*POLICY[A-Z_]*\b|process\.env\[[^\]]*POLICY/i.test(
          fs.readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => path.relative(SRC_ROOT, file).split(path.sep).join('/'));
    expect(readers).toEqual([]);
  });
});
