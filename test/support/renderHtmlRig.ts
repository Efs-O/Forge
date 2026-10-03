import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';
import * as vscode from 'vscode';
import type { ForgeConfig } from '../../src/config/types';
import {
  FILE_DELIVERY_TURN_LIMIT,
  type UserNotificationService,
} from '../../src/sidebar/UserNotificationService';
import type { ToolHandlerContext } from '../../src/tools/ToolRegistry';

/**
 * Shared setup for the two `render_html_to_image` suites. The Playwright fake
 * itself lives in `renderHtmlHarness.ts`; it has to be installed by a
 * `vi.mock` call in each test file, because a hoisted mock cannot reference an
 * imported binding.
 */
export function setWorkspace(folder: string): void {
  (
    vscode.workspace as unknown as {
      workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
    }
  ).workspaceFolders = [{ uri: { fsPath: folder } }];
}

export interface RigOptions {
  config?: Partial<ForgeConfig>;
  deliver?: () => Promise<unknown>;
  renderTimeoutMs?: number;
  /**
   * The service's "how many sends are left" probe. Defaults to a full budget;
   * supplying 0 exercises the tool's early refusal before it spends a browser.
   * Always present: `remainingFileDeliveries` is a real method on
   * `UserNotificationService`, so the tool calls it unconditionally and a rig
   * that omitted it would only be simulating a shape production never has.
   */
  remaining?: number;
  /**
   * Omit the config getter entirely — the shape registerAllTools passes when
   * its own `getConfig` argument is undefined. The tool is registered
   * unconditionally, so it must still render with documented fallbacks.
   */
  noConfigGetter?: true;
}
/** Deps with every clock and config value pinned, so output is deterministic. */
export function rigDeps(options: RigOptions) {
  const deliverImpl = options.deliver ?? (async () => ({ kind: 'queued' as const, chats: 1 }));
  // Spied so the suites can assert the exact delivery payload; the tool only
  // ever sees it through the UserNotificationService shape.
  const deliverFile = vi.fn(deliverImpl);
  // Spied too, so a suite can assert the probe was asked about the SAME
  // conversation id the delivery will charge — an id mix-up would otherwise
  // read someone else's budget and go unnoticed.
  const remainingFileDeliveries = vi.fn(() => options.remaining ?? FILE_DELIVERY_TURN_LIMIT);
  const notifications = {
    deliverFile,
    remainingFileDeliveries,
  } as unknown as UserNotificationService;
  return {
    deliverFile,
    remainingFileDeliveries,
    deps: {
      ...(options.noConfigGetter
        ? {}
        : {
            getConfig: () =>
              ({
                active_model: 'primary',
                llama_server: {},
                models: [{ name: 'primary', gguf_path: '/primary.gguf' }],
                ...options.config,
              }) as ForgeConfig,
          }),
      notifications,
      now: () => new Date('2026-10-03T12:34:56.789Z'),
      ...(options.renderTimeoutMs === undefined ? {} : { renderTimeoutMs: options.renderTimeoutMs }),
    },
  };
}

export function context(overrides: Partial<ToolHandlerContext> = {}): ToolHandlerContext {
  return { beforeMutate: () => undefined, ...overrides };
}

/** A fresh temp workspace, real enough for resolveRealWorkspacePath. */
export async function makeWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'forge-render-'));
}

export async function removeWorkspace(root: string): Promise<void> {
  await fs.rm(root, { recursive: true, force: true });
}
