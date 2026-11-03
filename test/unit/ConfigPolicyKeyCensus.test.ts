import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/ConfigLoader';
import { defaultPolicyPath, isExecNamedField, policyKeys } from '../../src/config/PolicyLoader';
import { ENGINE_EXEC_FIELDS } from '../../src/config/engineSchema';
import { ForgeConfigShape } from '../../src/config/schema';
import { PolicyConfigSchema } from '../../src/config/policySchema';

/**
 * The CI row `docs/plans/SECURITY_SIMPLIFICATION_PLAN.md` §3 phase 3 asks for, and
 * the reason the phase-3 rules survive as rules instead of as a one-time cleanup.
 *
 * Phase 3 opens `config.yaml` to agents. What makes that safe is that the file no
 * longer contains the two kinds of thing an agent could use on itself: a block that
 * says what an agent may do, and a name of a program Forge runs. Both are easy to
 * write today and easy to add by accident in six months — a new `video.ffmpeg_binary`
 * or a `reload_command` on a model would reopen the wall with nobody noticing,
 * because every other test would still pass. So this file asks two questions of the
 * schema itself, not of a fixture: which top-level keys does the config side accept,
 * and which field names anywhere in it say "a program".
 *
 * The second question is answered by walking the schema, and a walker that quietly
 * fails to see a branch would make this file pass for the wrong reason — so it first
 * proves it can see fields it knows are there, and only then trusts its own answer.
 */

const tempDirs: string[] = [];

function mkDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-census-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A config.yaml beside a policy.yaml that exists but holds nothing, so the pair
 *  loads in the ENFORCED state without any other key being in two places. */
function enforced(configText: string): { configDir: string; policyPath: string } {
  const configDir = mkDir();
  fs.writeFileSync(path.join(configDir, 'config.yaml'), configText, 'utf8');
  const home = mkDir();
  const policyPath = defaultPolicyPath(home);
  fs.mkdirSync(path.join(home, '.forge'), { recursive: true });
  fs.writeFileSync(policyPath, '# the owner made this file, and left it empty\n', 'utf8');
  return { configDir, policyPath };
}

const ONE_MODEL = `active_model: z-cloud
models:
  - name: z-cloud
    provider: ollama
    endpoint: http://127.0.0.1:11434
`;

/** A schema as the walker finds it: zod v4 keeps its children in `_def`, and the
 *  wrapper types (`optional`, `default`, `prefault`, `superRefine`, `strict`) hide
 *  behind `unwrap` or behind `innerType`, so both are tried. Nothing here knows
 *  Forge's schema by name — the point is that a new field is found by the same walk
 *  whatever block it is added to.
 */
type SchemaNode = {
  shape?: Record<string, SchemaNode>;
  unwrap?: () => SchemaNode;
  _def?: Record<string, unknown>;
};

/** The key `childrenOf` gives a wrapper that adds no name of its own — `optional`,
 *  `default`, `nullable`, a union alternative. A key that starts with this character
 *  contributes no path segment, so `video.optional()` does not turn
 *  `video.ffmpeg_path` into `video.~.ffmpeg_path`, and the paths this file compares
 *  stay the paths an owner sees in the file.
 */
const TRANSPARENT = '~';
/** How deep the walker goes before it gives up on a schema that repeats itself.
 *  Forge's own schema is five deep at most; the limit is what stops a `z.lazy`
 *  recursion from hanging the test instead of answering it.
 */
const MAX_DEPTH = 14;

/** Is this `_def` entry a schema, or just the string tag zod puts in `_def.type`?
 *  Zod v4 stores the kind in `_def.type` (`'array'`, `'optional'`, `'default'`) and
 *  the child under `_def.elemType` or `_def.innerType`; zod v3 stored the child IN
 *  `_def.type`. Both are accepted here, because a walker that reads only one of them
 *  would answer "no program-named fields" for the wrong reason.
 */
function asSchema(value: unknown): SchemaNode | undefined {
  return value && typeof value === 'object' && ((value as SchemaNode)._def || (value as SchemaNode).shape)
    ? (value as SchemaNode)
    : undefined;
}

/** The children of one node, as `[key, child]` pairs. An array's or a record's
 *  element is `[]`, because `models[].start_command` is how the file reads.
 */
function childrenOf(node: SchemaNode | undefined): [string, SchemaNode][] {
  if (!node || typeof node !== 'object') return [];
  const shape = node.shape;
  if (shape && typeof shape === 'object') return Object.entries(shape);
  const def = (node._def ?? {}) as Record<string, unknown>;
  const tag = typeof def.type === 'string' ? def.type : '';
  if (Array.isArray(def.options)) {
    // A union's alternatives all count as fields this block accepts; an enum's
    // `options` are strings, which the walk stops at on its own.
    return (def.options as SchemaNode[]).map((option, index) => [`${TRANSPARENT}${index}`, option]);
  }
  const element =
    asSchema(def.element) ?? asSchema(def.elemType) ?? (tag === 'array' ? asSchema(def.type) : undefined);
  if (element) return [['[]', element]];
  if (tag === 'record' || tag === 'set' || tag === 'map') {
    const value = asSchema(def.valueType);
    if (value) return [['[]', value]];
  }
  const inner = asSchema(def.innerType) ?? asSchema(def.wrapped) ?? asSchema(def.valueType);
  if (inner) return [[TRANSPARENT, inner]];
  if (typeof node.unwrap === 'function') {
    try {
      return childrenOf(node.unwrap());
    } catch {
      return [];
    }
  }
  return [];
}

/** Every field name the config.yaml side of the schema accepts, as `block[].name`. */
function configFieldNames(): { names: Set<string>; paths: Set<string> } {
  const names = new Set<string>();
  const paths = new Set<string>();
  const walk = (node: SchemaNode | undefined, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    for (const [key, child] of childrenOf(node)) {
      if (key.startsWith(TRANSPARENT) || key === '[]') {
        walk(child, key === '[]' ? `${path}.[]` : path, depth + 1);
        continue;
      }
      const next = path ? `${path}.${key}` : key;
      names.add(key.toLowerCase());
      paths.add(next);
      walk(child, next, depth + 1);
    }
  };
  for (const [key, schema] of Object.entries(ForgeConfigShape)) {
    if (policyKeys().includes(key)) continue; // the policy file's half, not this one
    walk(schema as SchemaNode, key, 0);
  }
  return { names, paths };
}

describe('the config.yaml side of the schema (phase 3 census)', () => {
  it('walks the schema deeply enough to see fields it knows are there', () => {
    // Without this, the two checks below could pass because the walker saw nothing.
    // The paths are in the walker's own notation: an array's element is `[]`, so
    // `models.[].name` is how `models[].name` reads in the file. `num_ctx` is checked
    // by name rather than by path because `defaults` keeps its sampling fields in a
    // block of their own — what matters here is that the walker reached it at all.
    const { names, paths } = configFieldNames();
    for (const known of [
      'models.[].name',
      'models.[].gguf_path',
      'models.[].endpoint',
      'models.[].start_command',
      'video.ffmpeg_path',
      'embeddings.model_path',
      'groups.[].provider',
      'defaults.sampling',
    ]) {
      expect(paths.has(known), known).toBe(true);
    }
    for (const deep of ['num_ctx', 'n_parallel', 'ffmpeg_path', 'model_path']) {
      expect(names.has(deep), deep).toBe(true);
    }
  });

  it('accepts no policy key, so a block that says what an agent may do cannot come back', () => {
    const configSide = Object.keys(ForgeConfigShape).filter((key) => !policyKeys().includes(key));
    for (const key of policyKeys()) {
      expect(configSide, `${key} is a policy key`).not.toContain(key);
    }
    // The policy side must still accept every one of them, or the migration would
    // have nowhere to put what it moves out of config.yaml.
    const policySide = Object.keys(PolicyConfigSchema.shape);
    for (const key of policyKeys()) {
      expect(policySide, `${key} has no home in policy.yaml`).toContain(key);
    }
  });

  it('names no program Forge runs, except the four fields the migration turns into engines', () => {
    const { names } = configFieldNames();
    const found = [...names].filter((name) => isExecNamedField(name)).sort();
    // `unload_path` is not program-named — it names an HTTP path, not an executable —
    // so it is the one engine field this list does not have to contain.
    const allowed = ['llama_server_binary', 'start_command', 'stop_command'];
    expect(found).toEqual(allowed);
    // And those three are only allowed because the load check refuses them; a later
    // phase that adds `video.ffmpeg_binary` or a `reload_command` fails the line
    // above, which is the whole point of this file.
    for (const name of allowed) {
      expect(isExecNamedField(name), name).toBe(true);
    }
  });

  it('refuses each of those fields at load, so being in the schema is not being allowed', () => {
    const cases: Array<[string, string]> = [
      ['start_command', 'start_command: ["python", "x.py"]'],
      ['stop_command', 'stop_command: ["python", "y.py"]'],
      ['llama_server_binary', 'llama_server_binary: V:/Tools/llama-server.exe'],
      ['unload_path', 'unload_path: /unload'],
    ];
    for (const [field, line] of cases) {
      const { configDir, policyPath } = enforced(
        `active_model: strata\nmodels:\n  - name: strata\n    provider: openai-compatible\n    endpoint: http://127.0.0.1:8081\n    ${line}\n`,
      );
      expect(() => loadConfig(configDir, { policyPath }), field).toThrow(/config\.yaml names programs/);
    }
    // `stop_on_exit` is the model's own choice, not a program, and stays.
    const kept = enforced(
      `${ONE_MODEL}stop_on_exit: true\n`,
    );
    expect(() => loadConfig(kept.configDir, { policyPath: kept.policyPath })).not.toThrow();
  });

  it('refuses a program-named field added to any other block, by name alone', () => {
    // The rule that makes this file's second half future-proof: `ConfigLoader` does
    // not know which blocks exist, it refuses names, so a field nobody has thought
    // of yet is refused the day it is written.
    const { configDir, policyPath } = enforced(`${ONE_MODEL}video:\n  ffmpeg_binary: V:/Tools/ffmpeg.exe\n`);
    expect(() => loadConfig(configDir, { policyPath })).toThrow(/ffmpeg_binary/);
    const before = mkDir();
    fs.writeFileSync(
      path.join(before, 'config.yaml'),
      `${ONE_MODEL}video:\n  ffmpeg_binary: V:/Tools/ffmpeg.exe\n`,
      'utf8',
    );
    // …and before the owner has a policy file, the same field is only a shape the
    // file has always had: nothing is refused, because nothing is open yet.
    expect(() => loadConfig(before, { policyPath: path.join(before, 'no-policy.yaml') })).not.toThrow();
  });

  it('loads the example config a fresh install starts from, with no policy file', () => {
    // `config/config.example.yaml` is what the wizard and the README point at. It
    // still holds its policy keys and its model server programs — the un-migrated
    // state — so this load is the proof that phase 3 broke the split and not the
    // first run: an install that has never seen policy.yaml must still start.
    const example = fs.readFileSync(
      path.resolve(__dirname, '../../config/config.example.yaml'),
      'utf8',
    );
    const uncommented = example
      .split(/\r?\n/)
      .filter((line) => /^\s*(start_command|stop_command|llama_server_binary):/u.test(line));
    expect(uncommented.length, 'the example shows the fields phase 3 refuses').toBeGreaterThan(0);
    const dir = mkDir();
    fs.writeFileSync(path.join(dir, 'config.yaml'), example, 'utf8');
    expect(() => loadConfig(dir, { policyPath: path.join(dir, 'no-policy.yaml') })).not.toThrow();
  });
});
