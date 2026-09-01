import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverSiblingWorkspaces,
  resolveWorkspaceAliases,
} from '../../src/remote/RemoteWorkspaceDiscovery';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const directory of tempDirs.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

/** Builds a projects folder and returns the path of the "open" project inside
 *  it, which is what a window would report as its workspace root. */
async function projectsFolder(names: string[], open = names[0]!): Promise<string> {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-discovery-'));
  tempDirs.push(parent);
  for (const name of names) await fs.mkdir(path.join(parent, name), { recursive: true });
  return path.join(parent, open);
}

describe('discoverSiblingWorkspaces', () => {
  it('finds the siblings of the open project and slugs their names', async () => {
    const root = await projectsFolder(['Forge', 'Qwen testing', 'Ssuno']);

    const found = discoverSiblingWorkspaces(root);

    expect(Object.keys(found).sort()).toEqual(['forge', 'qwen-testing', 'ssuno']);
    expect(found['qwen-testing']?.display_name).toBe('Qwen testing');
  });

  it('does not filter on .git — the folder that motivated this is not a repo', async () => {
    const root = await projectsFolder(['Forge', 'Qwen testing']);
    await fs.mkdir(path.join(root, '.git'), { recursive: true });

    // Forge has .git here and Qwen testing does not; both must still appear.
    expect(Object.keys(discoverSiblingWorkspaces(root)).sort()).toEqual(['forge', 'qwen-testing']);
  });

  it('skips dotfolders and dependency directories', async () => {
    const root = await projectsFolder(['Forge', '.vscode', 'node_modules', '.git']);

    expect(Object.keys(discoverSiblingWorkspaces(root))).toEqual(['forge']);
  });

  it('returns nothing for a filesystem root or a missing workspace', async () => {
    expect(discoverSiblingWorkspaces(undefined)).toEqual({});
    expect(discoverSiblingWorkspaces(path.parse(process.cwd()).root)).toEqual({});
  });

  it('produces aliases that satisfy the configured-alias key regex', async () => {
    const root = await projectsFolder(['Forge', '2024 archive', 'BDESIGN MOBILE', '__weird__']);

    for (const alias of Object.keys(discoverSiblingWorkspaces(root))) {
      expect(alias).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    }
  });
});

describe('resolveWorkspaceAliases', () => {
  it('lets an explicit alias override a discovered folder at the same path', async () => {
    const root = await projectsFolder(['Forge', 'Qwen testing']);
    const qwenPath = path.join(path.dirname(root), 'Qwen testing');

    const merged = resolveWorkspaceAliases(
      { qwen: { path: qwenPath, display_name: 'Qwen (tuned)' } },
      root,
    );

    // One entry for that folder, under the configured name — not two.
    expect(merged['qwen']?.display_name).toBe('Qwen (tuned)');
    expect(merged['qwen-testing']).toBeUndefined();
    expect(Object.keys(merged).sort()).toEqual(['forge', 'qwen']);
  });

  it('keeps an explicit alias pointing outside the discovered folder', async () => {
    const root = await projectsFolder(['Forge']);

    const merged = resolveWorkspaceAliases(
      { elsewhere: { path: path.join(os.tmpdir(), 'somewhere-else'), display_name: 'Elsewhere' } },
      root,
    );

    expect(Object.keys(merged).sort()).toEqual(['elsewhere', 'forge']);
  });

  it('works with no configuration at all, which is the point', async () => {
    const root = await projectsFolder(['Forge', 'Ssuno']);

    expect(Object.keys(resolveWorkspaceAliases({}, root)).sort()).toEqual(['forge', 'ssuno']);
  });
});
