import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { busPaths, removeLegacyAliasFiles } from '../../src/agentBus/agentBus';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy alias ownership cleanup', () => {
  it('removes legacy records and claims and can run again safely', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-legacy-links-'));
    roots.push(home);
    const paths = busPaths(home);
    const ownership = path.join(paths.root, 'ownership');
    fs.mkdirSync(ownership, { recursive: true });
    const json = path.join(ownership, 'claude.json');
    const claim = path.join(ownership, 'codex.claim');
    const rootClaim = path.join(paths.root, 'legacy.claim');
    fs.writeFileSync(json, '{}');
    fs.writeFileSync(claim, '');
    fs.writeFileSync(rootClaim, '');
    const warning = vi.fn();

    expect(removeLegacyAliasFiles(paths, warning)).toEqual([json, claim, rootClaim]);
    expect(fs.existsSync(json)).toBe(false);
    expect(fs.existsSync(claim)).toBe(false);
    expect(fs.existsSync(rootClaim)).toBe(false);
    expect(removeLegacyAliasFiles(paths, warning)).toEqual([]);
    expect(warning).not.toHaveBeenCalled();
  });

  it('keeps the cleanup lifecycle row in the plan contract', () => {
    const plan = fs.readFileSync(
      path.resolve(__dirname, '../../docs/plans/AGENT_CHAT_LINKS_PLAN.md'),
      'utf8',
    );
    const row = plan.split('\n').find((line) => line.includes('Legacy `ownership/*.json`'));
    expect(row).toContain('deleted on extension activation');
    expect(row).toContain('failures are logged and shown as a warning');
  });
});
