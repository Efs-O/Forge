/**
 * The shared, stateless browser primitives: the channel type, the lazy
 * Playwright require, origin classification, and PNG header reading.
 *
 * These live apart from `BrowserSessionManager` for two reasons. They carry no
 * session state, and they are consumed by code that never opens a browsing
 * session — `render_html_to_image` needs the same lazy require and the same PNG
 * reader without touching the session at all. `BrowserSessionManager` re-exports
 * every name here, so existing import sites (and the `vi.mock` seam the render
 * tests use on that module) keep working unchanged.
 */

/**
 * The configured system browser channel (plan §4.1). Used as-is — no silent
 * fallback (Claude condition 2): if the configured channel's browser is not
 * installed, `launch` throws naming the alternative. `chromium` (Playwright's
 * downloaded build) is a last resort requiring a manual user-run install.
 */
export type BrowserChannel = 'chrome' | 'msedge' | 'chromium';

/** A raw screenshot: PNG bytes plus its true dimensions (for the text). */
export interface BrowserScreenshot {
  png: Buffer;
  width: number;
  height: number;
}

/**
 * Lazily load playwright-core. It is 12.8 MB and external (shipped intact in
 * dist/node_modules, NOT inlined by esbuild — B4: inlining breaks its runtime
 * file lookups). Requiring it at module top would load it on every activation,
 * even for users who never enable the browser; it loads only when a session is
 * launched. Node caches the require, so repeat calls are cheap.
 *
 * Exported because `render_html_to_image` needs the same lazy require without
 * duplicating the 12.8 MB import rule — a second copy is a second place to get
 * B4 wrong. It does NOT imply the `permissions.browser.enabled` gate: that gate
 * is for interactive browsing, and the render tool is exempt by owner decision
 * (docs/plans/SEND_FILE_AND_RENDER_HTML_PLAN.md).
 */
export function getPlaywright(): typeof import('playwright-core') {
  // Deliberate lazy require: playwright-core is external (shipped intact in
  // dist/node_modules) and must not load at module top (12.8 MB on every
  // activation). See B4.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('playwright-core') as typeof import('playwright-core');
}

/** A real web origin (http/https) — the only kind that has an exfil surface. */
export function webOriginOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    return undefined; // about:blank, data:, chrome:, file:, …
  } catch {
    return undefined;
  }
}

/**
 * True PNG dimensions from the IHDR box (no full decode needed). Exported for
 * `render_html_to_image`, which reports the size of the PNG it just made and
 * caps a `full_page` capture by its real height; a second copy of this reader
 * is a second place to get the IHDR offset wrong.
 */
export function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
