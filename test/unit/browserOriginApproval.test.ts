/**
 * Browser input-tool origin approval (plan §4.7): the gate checks the tab the
 * input targets (`tab_id`, else active), and marking happens against the
 * pre-action origin so a click that navigates cannot auto-approve the page it
 * lands on.
 */
import { describe, it, expect } from 'vitest';
import { buildBrowserToolContext } from '../../src/tools/browser/browserTools';
import type { BrowserSessionManager } from '../../src/tools/browser/BrowserSessionManager';
import type { ForgeConfig } from '../../src/config/types';

function fakeMgr(tabs: Record<string, string>, active: string) {
  const approved = new Set<string>();
  const mgr = {
    isLaunched: () => true,
    tabUrl: (id?: string) => tabs[id ?? active],
    isOriginApproved: (o: string) => approved.has(o),
    markOriginApproved: (o: string) => void approved.add(o),
  };
  return { mgr: mgr as unknown as BrowserSessionManager, approved };
}

const cfg = () => ({}) as ForgeConfig;

describe('browser input origin approval', () => {
  it('checks the tab named by tab_id, not the active tab', () => {
    const { mgr, approved } = fakeMgr({ t1: 'https://a.test/x', t2: 'https://b.test/y' }, 't1');
    approved.add('https://a.test');
    const approval = buildBrowserToolContext(cfg, mgr).inputApproval('browser_click');
    expect(approval({})).toBeUndefined();
    expect(approval({ tab_id: 't2' })?.detail).toMatch(/b\.test/);
  });

  it('marks the pre-action origin only, never where the action navigated', () => {
    const tabs: Record<string, string> = { t1: 'https://a.test/' };
    const { mgr, approved } = fakeMgr(tabs, 't1');
    const ctx = buildBrowserToolContext(cfg, mgr);
    ctx.markTargetOrigin({}); // the handlers call this BEFORE acting
    tabs.t1 = 'https://evil.test/'; // the click navigated
    expect([...approved]).toEqual(['https://a.test']);
    expect(ctx.inputApproval('browser_click')({})?.detail).toMatch(/evil\.test/);
  });
});
