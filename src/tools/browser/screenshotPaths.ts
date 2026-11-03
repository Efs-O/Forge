/**
 * Where Forge's screenshots live, and what happens to them when their chat goes.
 *
 * `browser_screenshot` and `desktop_capture` write one PNG per capture under
 * `<root>/<conversationId>/`, outside every workspace: a desktop capture can
 * hold secrets, and a repo's `.forge/` is gitignored in Forge but not in the
 * other repos the agent works in. Nothing else may compute that path — the
 * webview's image roots, `send_file`'s per-chat directory and the purge that
 * deletes a chat's captures all read it here, so they cannot drift apart.
 *
 * `FORGE_SCREENSHOT_DIR` overrides the root and is read **at call time**, not
 * at import. It exists because the browser integration tests wrote into the
 * owner's real folder for a month under a conversation id that is not a chat —
 * 2,604 PNGs, 28.8 MB, measured by the 2026-10-30 hunt (BL-011) — and a test
 * that writes there is invisible to `test/support/tempGuard.global.ts`, which
 * only watches `os.tmpdir()`.
 *
 * A capture is deleted with the chat that made it (BL-012): these files can
 * hold secrets, so they must not outlive the conversation that produced them,
 * and `ArchivedSessions.purge` is what carries that out. `docs/
 * BROWSER_DESKTOP_TOOLS.md` says where they live; this file is what makes that
 * location one decision instead of three.
 */
import * as os from 'os';
import * as path from 'path';

/** The screenshot root: the default, or `FORGE_SCREENSHOT_DIR` when it is set.
 *  Both halves are decided at call time, not at import: a test that mocks
 *  `os.homedir` (test/unit/SendFileTool.test.ts does) must not have the default
 *  baked in before its mock exists, and a test that sets the override after
 *  importing must still be honoured. */
export function screenshotRoot(): string {
  const override = process.env.FORGE_SCREENSHOT_DIR;
  const trimmed = override?.trim() ?? '';
  return trimmed ? path.resolve(trimmed) : path.join(os.homedir(), '.forge', 'screenshots');
}

/**
 * The folder one conversation's captures live in. `default` is the shared
 * fallback for a turn that had no conversation, which is why `send_file` will
 * not accept it as a per-chat root.
 */
export function screenshotDirectory(conversationId: string | undefined): string {
  return path.join(screenshotRoot(), conversationId ?? 'default');
}
