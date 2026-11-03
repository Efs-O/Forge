import * as fs from 'fs';
import * as YAML from 'yaml';

/**
 * The YAML-side utilities `policyMigration.ts` runs on: find a pair by key, read
 * a scalar, copy a node to plain JS, tell whether a file parses, and decide
 * whether an anchor would be left behind when a block moves to another file. They
 * live here because they know nothing about policy, engines or Forge's schema —
 * and because the migration file has to stay under the line limit while still
 * carrying the rules that make a move safe: comments travel with the node, anchors
 * do not travel alone, and two models that start the same program share one
 * engine.
 *
 * vscode-free, like the migration: every interesting case is tested in plain node
 * against a fixture copy of the owner's config, never against the live file.
 */

/** This machine: a model on loopback reaches nothing an agent could leak to, so
 *  it needs no `model_hosts` entry. The whole 127.0.0.0/8 block is loopback by
 *  RFC 6761, not only `127.0.0.1`, and `isLoopbackHost` says so because the
 *  migration's census and phase 3's host rule must agree on the word: two
 *  definitions would disagree about a server on `127.0.0.2`, and the owner would
 *  get a load error for a host the migration had just promised was allowed.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '0.0.0.0', 'localhost', '::1', '[::1]']);

/** The host an `endpoint` names, lowercased and without IPv6 brackets, or undefined
 *  when the string is not a URL. An endpoint this cannot read is not a host the
 *  owner could have allowed, and `modelSchema.ts` refuses the shape elsewhere, so
 *  nothing is being let through here — only judged. */
export function endpointHostOf(endpoint: unknown): string | undefined {
  if (typeof endpoint !== 'string') return undefined;
  try {
    const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Is this host this machine? The 127.0.0.0/8 block whole, not only `127.0.0.1`. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare.length > 0 && (LOOPBACK_HOSTS.has(bare) || bare.startsWith('127.'));
}
export function findPair(map: YAML.YAMLMap, key: string): YAML.Pair<unknown, unknown> | undefined {
  for (const item of map.items) {
    if (YAML.isPair(item) && keyName(item.key) === key) return item;
  }
  return undefined;
}

export function keyName(node: unknown): string | undefined {
  if (YAML.isScalar(node)) {
    const value = node.value;
    return typeof value === 'string' ? value : value === undefined ? undefined : String(value);
  }
  return undefined;
}

export function scalarText(nodeOrValue: unknown): string | undefined {
  if (typeof nodeOrValue === 'string') return nodeOrValue;
  if (YAML.isScalar(nodeOrValue)) {
    return typeof nodeOrValue.value === 'string' ? nodeOrValue.value : undefined;
  }
  return undefined;
}

export function stringListOf(nodeOrValue: unknown): string[] | undefined {
  if (Array.isArray(nodeOrValue)) return nodeOrValue.filter((v) => typeof v === 'string');
  if (YAML.isSeq(nodeOrValue)) {
    const out: string[] = [];
    for (const item of nodeOrValue.items) {
      const text = scalarText(YAML.isPair(item) ? item.value : item);
      if (text !== undefined) out.push(text);
    }
    return out;
  }
  return undefined;
}

/** A plain JS copy of a node, built by walking it instead of calling `toJS()`,
 *  so a single field can be compared without a document context. Aliases come
 *  back as null — `findForeignAlias` already refuses the case where that would
 *  matter, so nothing here silently loses an anchor. */
export function plainValueOf(node: unknown): unknown {
  if (node === null || node === undefined) return null;
  if (YAML.isScalar(node)) return node.value ?? null;
  if (YAML.isSeq(node)) {
    return node.items.map((item) => plainValueOf(YAML.isPair(item) ? item.value : item));
  }
  if (YAML.isMap(node)) {
    const out: Record<string, unknown> = {};
    for (const item of node.items) {
      if (!YAML.isPair(item)) continue;
      const key = keyName(item.key);
      if (key === undefined) continue;
      out[key] = plainValueOf(item.value);
    }
    return out;
  }
  return null;
}

/** The name of the first alias in `node` whose anchor is defined OUTSIDE `node`.
 *  That anchor would be left behind in config.yaml, and policy.yaml would then
 *  hold `*ref` pointing at nothing — a file that parses and means something
 *  entirely different. An anchor that moves with its own block is fine, and so is
 *  an anchor defined inside the block being moved: both are answered by resolving
 *  the alias and asking whether the resolved node travelled with it.
 */
export function findForeignAlias(node: unknown, doc: YAML.Document): string | undefined {
  const owned = new Set<unknown>();
  collectNodes(node, owned);
  return searchForeignAlias(node, owned, doc);
}

function collectNodes(node: unknown, into: Set<unknown>): void {
  if (!YAML.isNode(node)) return;
  into.add(node);
  if (YAML.isCollection(node)) {
    for (const item of node.items) {
      if (YAML.isPair(item)) {
        collectNodes(item.key, into);
        collectNodes(item.value, into);
      } else collectNodes(item, into);
    }
  }
}

function searchForeignAlias(
  node: unknown,
  owned: Set<unknown>,
  doc: YAML.Document,
): string | undefined {
  if (!YAML.isNode(node)) return undefined;
  if (YAML.isAlias(node)) {
    // `source` is the anchor NAME; `resolve` is the node it points at. Asking
    // whether that node travelled with the block is the whole question — an
    // anchor defined inside the block moves with it and stays legal, one defined
    // elsewhere in config.yaml does not and would leave `*name` dangling here.
    const resolved = node.resolve(doc);
    return resolved !== undefined && owned.has(resolved) ? undefined : node.source;
  }
  if (YAML.isCollection(node)) {
    for (const item of node.items) {
      if (YAML.isPair(item)) {
        const found = searchForeignAlias(item.value, owned, doc);
        if (found) return found;
      } else {
        const found = searchForeignAlias(item, owned, doc);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/** Every non-loopback host the config's models reach, each one resolved the way
 *  `effectiveGroupField` in `modelSchema.ts` resolves it — the last group that
 *  defines `endpoint` wins — so `model_hosts` covers exactly the hosts phase 3 will
 *  ask about. A host this census missed would be a load error naming a setting the
 *  owner had just been told the migration handled.
 */
export function nonLoopbackHostsOf(configJS: Record<string, unknown>): string[] {
  const models = Array.isArray(configJS.models) ? configJS.models : [];
  const groups = (configJS.groups ?? {}) as Record<string, { endpoint?: unknown } | undefined>;
  const hosts: string[] = [];
  for (const model of models) {
    const entry = model as { endpoint?: unknown; group?: unknown; groups?: unknown };
    let endpoint = entry?.endpoint;
    if (typeof endpoint !== 'string') {
      const names = Array.isArray(entry?.groups)
        ? (entry.groups as unknown[])
        : typeof entry?.group === 'string'
          ? [entry.group]
          : [];
      for (const name of names) {
        const value = typeof name === 'string' ? groups[name]?.endpoint : undefined;
        if (typeof value === 'string') endpoint = value;
      }
    }
    const host = endpointHostOf(endpoint);
    if (!host || isLoopbackHost(host) || hosts.includes(host)) continue;
    hosts.push(host);
  }
  return hosts.sort();
}

export function readFileOrThrow(filePath: string, label: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Forge: ${label} not found at ${filePath} — nothing to migrate.`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function parseDocument(text: string, label: string, filePath: string): YAML.Document {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length > 0) {
    throw new Error(
      `Forge: ${label} parse failed, refusing to migrate:\n${doc.errors
        .map((error) => `  • ${error.message}`)
        .join('\n')}\n(${filePath})`,
    );
  }
  return doc;
}

export function requireTopMap(doc: YAML.Document, label: string, filePath: string): YAML.YAMLMap {
  if (doc.contents === null || doc.contents === undefined) {
    // An empty or comment-only file: there is nothing in it to move, so this
    // map is deliberately not attached to the document — the file is written
    // back as it was, and no key can have come out of it.
    return new YAML.YAMLMap(doc.schema);
  }
  if (!YAML.isMap(doc.contents)) {
    throw new Error(
      `Forge: ${label} must be a map of top-level keys, not a list or a plain value (${filePath}).`,
    );
  }
  return doc.contents;
}
