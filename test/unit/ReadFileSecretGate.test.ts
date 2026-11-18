import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The mock makes the temp folder the workspace root, which is what
// `resolveWorkspacePath` needs. It creates the folder itself because `vi.mock`
// is hoisted above this file's statements: a `const dir` declared below would
// still be in its temporal dead zone when the factory runs.
vi.mock('vscode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-secret-read-'));
  return { workspace: { workspaceFolders: [{ uri: { fsPath: root } }] } };
});

import * as vscode from 'vscode';
import { makeReadFileTool } from '../../src/tools/readFileTool';
import {
  clearConversationSecretState,
  conversationsWithSecretRead,
  hasConversationReadSecret,
  markConversationReadSecret,
} from '../../src/tools/exfilTaint';
import { fetchApprovalFor } from '../../src/tools/fetchHostApprovals';
import type { ForgeConfig } from '../../src/config/types';

const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const HOME = 'C:/Users/someone';
const win: { home?: string; platform?: NodeJS.Platform } = { home: HOME, platform: 'win32' };
const signal = new AbortController().signal;

function tool(config?: ForgeConfig) {
  const deps = config ? { ...win, getConfig: () => config } : { ...win };
  return makeReadFileTool(deps);
}

/**
 * A tool judged by the runner's own OS, for the two allow-list tests below.
 *
 * Those two name the mocked workspace root, a real folder on the runner, and
 * `secretPathAllowListFor` folds the owner's entry with the runner's rules (it
 * takes no platform) while the candidate is folded with the injected `win32`
 * ones. Off Windows that fold lower-cases the path, so an allow entry whose
 * temp folder has an upper-case letter in its random suffix stopped matching the
 * file it names. On Windows both sides fold the same way, which is why this only
 * ever failed on the Linux and macOS runners.
 */
function toolOnThisOs(config?: ForgeConfig) {
  const deps = config
    ? { home: HOME, platform: process.platform, getConfig: () => config }
    : { home: HOME, platform: process.platform };
  return makeReadFileTool(deps);
}

beforeAll(() => {
  fs.writeFileSync(path.join(root, '.env'), 'API_KEY=secret-value\n');
  fs.writeFileSync(path.join(root, '.env.example'), 'API_KEY=\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const x = 1;\n');
  for (const [fixture, filename] of [
    ['sample.xlsx', 'sample.xlsx'],
    ['sample.docx', 'sample.docx'],
    ['sample.pdf', 'sample.pdf'],
    ['sample.pptx', 'sample.pptx'],
    ['sample.xlsx', 'sample.xlsx'],
    ['legacy.doc', 'legacy.doc'],
  ]) {
    fs.copyFileSync(
      new URL(`../fixtures/documents/${fixture}`, import.meta.url),
      path.join(root, filename),
    );
  }
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('read_file document dispatch', () => {
  it('extracts documents and selects the requested sheets', async () => {
    const result = await tool().handler({ path: 'sample.xlsx', pages: '2-3' });
    expect(result).toContain('--- sheet Costs ---');
    expect(result).toContain('--- sheet Forecast ---');
    expect(result).not.toContain('--- sheet Sales ---');
  });

  it('applies line ranges to extracted text and refuses legacy Office files', async () => {
    const text = await tool().handler({ path: 'sample.docx', start_line: 1, end_line: 1 });
    expect(text).toContain('# Quarterly Report');
    await expect(tool().handler({ path: 'legacy.doc' })).rejects.toThrow(/save it as \.docx/i);
  });

  it('refuses pages for DOCX and identifies supported page-like document types', async () => {
    await expect(tool().handler({ path: 'sample.docx', pages: '1' })).rejects.toThrow(
      'pages applies to PDF pages, PPTX slides, and XLSX sheets only',
    );
    await expect(tool().handler({ path: 'sample.pdf', pages: '1' })).resolves.toContain(
      '--- page 1 ---',
    );
  });
});

/**
 * `read_file` reads any path on disk, because refusing outside the workspace
 * bought nothing (`list_directory` and `shell` already read anywhere). That is
 * exactly why a secret path needs a card: the file's content is what an
 * injected instruction would want to send out, and reading it is the first half
 * of that.
 */
describe('read_file asks for a secret path', () => {
  const cases: Array<[path: string, pattern: string]> = [
    ['.env', '**/.env'],
    ['src/.env.local', '**/.env.*'],
    ['C:/Users/someone/.ssh/id_ed25519', '~/.ssh/**'],
    ['C:/Users/someone/.aws/credentials', '~/.aws/**'],
    ['certs/server.pem', '*.pem'],
    ['C:/Users/someone/.forge/agent-bus/endpoint.json', '~/.forge/agent-bus/endpoint.json'],
  ];

  it.each(cases)('asks for %s naming %s', (filePath, pattern) => {
    const card = tool().approval?.({ path: filePath });
    expect(card?.dangerous).toBe(true);
    expect(card?.detail).toContain(filePath);
    expect(card?.cardReason).toBe(`reads a secret path (${pattern})`);
    expect(card?.declineHint).toContain(pattern);
    expect(card?.declineHint).toContain('.env.example');
  });

  // An autonomous run that refused at once would leave the agent with nothing
  // but "no"; `ownerGate` is the classification that says a human owns this
  // call, so the refusal can name the alternative instead of only the no
  // (docs/plans/V1_FINISH_PLAN.md, autonomous-run table).
  it('marks it as a gate only the owner may answer', () => {
    for (const filePath of ['.env', 'C:/Users/someone/.ssh/id_ed25519']) {
      expect(tool().approval?.({ path: filePath })?.gateKind).toBe('ownerGate');
    }
  });

  // The templates carry variable names, not values, and the agent reads them
  // every session: a card here is the card that gets the gate switched off.
  it('does not ask for the committed templates', () => {
    for (const filePath of ['.env.example', '.env.sample', '.env.template', 'src/.env.example']) {
      expect(tool().approval?.({ path: filePath })).toBeUndefined();
    }
  });

  it('does not ask for ordinary files', () => {
    for (const filePath of ['src/app.ts', 'README.md', 'notes.env.md']) {
      expect(tool().approval?.({ path: filePath })).toBeUndefined();
    }
  });

  // The template exception is an exact name, not a prefix: `.env.example.bak` is
  // a copy somebody made of a value they had, and `**/.env.*` reaches it. Naming
  // this here because it looks like it should be free and is not.
  it('gates a copy of a template, because the exception is an exact name', () => {
    expect(tool().approval?.({ path: 'src/.env.example.bak' })?.cardReason).toContain('**/.env.*');
    expect(tool().approval?.({ path: 'src/.env.example' })).toBeUndefined();
  });

  // `~/.ssh/id_ed25519` typed as a workspace-relative string is not a path
  // anyone can read, but the agent types it, and the resolved form is still a
  // path the pattern knows about.
  it('checks the resolved form too, so a tilde cannot smuggle itself past', () => {
    const card = tool().approval?.({ path: '~/.ssh/id_rsa' });
    expect(card?.cardReason).toContain('~/.ssh/**');
  });

  it('honours permissions.secret_paths_allow', () => {
    const allowed = {
      permissions: { secret_paths_allow: ['.env'] },
    } as unknown as ForgeConfig;
    expect(tool(allowed).approval?.({ path: '.env' })).toBeUndefined();
    expect(tool(allowed).approval?.({ path: '.env.local' })?.cardReason).toContain('**/.env.*');
  });

  // The owner allows a file by naming the path they mean — the absolute one. The
  // agent types `.env` because that is what it types when the workspace is that
  // folder, and the card asked anyway: the live security test of 2026-10-28,
  // re-run finding 3. This is that call, through the resolver `read_file` really
  // uses (`resolveWorkspacePath`), not a hand-written fake of it.
  it('honours an allow entry naming the workspace file in absolute form', () => {
    const allowed = {
      permissions: { secret_paths_allow: [`${root}/.env`] },
    } as unknown as ForgeConfig;
    for (const spelling of ['.env', './.env', 'x/../.env', `${root}/.env`]) {
      expect(
        toolOnThisOs(allowed).approval?.({ path: spelling }),
        `${spelling} should run`,
      ).toBeUndefined();
    }
    expect(toolOnThisOs(allowed).approval?.({ path: 'src/.env' })?.cardReason).toContain('**/.env');
    expect(toolOnThisOs(allowed).approval?.({ path: '.env.local' })?.cardReason).toContain(
      '**/.env.*',
    );
  });

  it('gates what this PC added to the list', () => {
    const config = {
      permissions: { secret_paths: ['**/*.token'] },
    } as unknown as ForgeConfig;
    const card = tool(config).approval?.({ path: 'secrets/api.token' });
    expect(card?.cardReason).toContain('**/*.token');
  });

  // A tool registered with no config getter must not lose the gate: the defaults
  // live in code, so the hook is installed whether or not a config exists.
  it('gates the defaults with no config getter at all', () => {
    expect(tool().approval?.({ path: '.env' })?.cardReason).toContain('**/.env');
  });

  // A batch is the easy way to smuggle a secret past the card: the hook used to
  // look at `path` alone, so a `reads` array could carry `.env` as its second
  // item and never be asked. Every path the call will print is checked.
  it('gates a secret inside reads, not only the first item', () => {
    const card = tool().approval?.({ reads: [{ path: 'src/app.ts' }, { path: '.env' }] });
    expect(card?.dangerous).toBe(true);
    expect(card?.cardReason).toBe('reads a secret path (**/.env)');
    expect(card?.detail).toContain('.env');
    expect(card?.detail).toContain('src/app.ts');
    expect(card?.gateKind).toBe('ownerGate');
    // An ordinary batch is not asked for at all.
    expect(
      tool().approval?.({ reads: [{ path: 'src/app.ts' }, { path: 'README.md' }] }),
    ).toBeUndefined();
  });
});

describe('the chat that read a secret is marked for its next fetch', () => {
  // Stealing takes two steps: read it, then send it out. Each gate stops one
  // step on its own; this flag is what connects them, so a chat that read
  // `.env` pays for it on its next fetch and nowhere else.
  it('marks the chat after a successful secret read', async () => {
    const result = await tool().handler?.({ path: '.env' }, {
      conversationId: 'chat-a',
      signal,
    } as never);
    expect(String(result)).toContain('API_KEY=secret-value');
    expect(hasConversationReadSecret('chat-a')).toBe(true);
    expect(conversationsWithSecretRead()).toContain('chat-a');
  });

  // The escape hatch is for the card, not for the rule: `config/schema.ts` says
  // the taint "still applies to whatever it lets through", and the live security
  // test of 2026-10-28 (docs/reports/V1_SECURITY_LIVE_TEST.md case 5) found an
  // unattended chat that read an allow-listed `.env`, was never marked, and then
  // fetched a new host with no card at all.
  it('marks the chat for an allow-listed read, which is the whole point of the hatch', async () => {
    const allowed = {
      permissions: { secret_paths_allow: ['.env'] },
    } as unknown as ForgeConfig;
    expect(tool(allowed).approval?.({ path: '.env' })).toBeUndefined();
    const result = await tool(allowed).handler?.({ path: '.env' }, {
      conversationId: 'chat-allow',
      signal,
    } as never);
    expect(String(result)).toContain('API_KEY=secret-value');
    expect(hasConversationReadSecret('chat-allow')).toBe(true);
    // …and the fetch that follows is judged on that flag, not on the host: the
    // `taintGate` classification is what stops a model from approving the sending
    // half of an exfiltration it cannot see.
    const card = fetchApprovalFor('https://collector.invalid/', allowed, 'chat-allow');
    expect(card?.dangerous).toBe(true);
    expect(card?.gateKind).toBe('taintGate');
    // A chat that read nothing pays nothing, so the flag is not a blanket gate.
    expect(fetchApprovalFor('https://collector.invalid/', allowed, 'chat-clean')?.dangerous).toBe(
      false,
    );
    clearConversationSecretState('chat-allow');
  });

  // The same file, allowed by its absolute path and typed relatively: the card is
  // gone, the mark is still there. The hatch exempts one prompt, not the rule that
  // makes the next fetch ask.
  it('marks the chat for an allow-listed read the agent typed relatively', async () => {
    const allowed = {
      permissions: { secret_paths_allow: [`${root}/.env`] },
    } as unknown as ForgeConfig;
    expect(toolOnThisOs(allowed).approval?.({ path: '.env' })).toBeUndefined();
    const result = await toolOnThisOs(allowed).handler?.({ path: '.env' }, {
      conversationId: 'chat-abs-allow',
      signal,
    } as never);
    expect(String(result)).toContain('API_KEY=secret-value');
    expect(hasConversationReadSecret('chat-abs-allow')).toBe(true);
    clearConversationSecretState('chat-abs-allow');
  });

  // A read that failed taints the chat for nothing, and a non-secret read must
  // not cost the chat anything at all.
  it('does not mark a failed read, or an ordinary one', async () => {
    await expect(
      tool().handler?.({ path: 'src/.env' }, { conversationId: 'chat-b', signal } as never),
    ).rejects.toThrow();
    expect(hasConversationReadSecret('chat-b')).toBe(false);
    await tool().handler?.({ path: 'src/app.ts' }, { conversationId: 'chat-c', signal } as never);
    expect(hasConversationReadSecret('chat-c')).toBe(false);
  });

  it('does not mark a read the user declined', async () => {
    // The gate's own rule: the flag is set by the handler, which only runs on a
    // call that was approved, so a declined read never reaches it.
    const card = tool().approval?.({ path: '.env' });
    expect(card).toBeDefined();
    expect(hasConversationReadSecret('chat-declined')).toBe(false);
  });

  it('clears with the chat, and only that chat', () => {
    markConversationReadSecret('chat-d');
    markConversationReadSecret('chat-e');
    clearConversationSecretState('chat-d');
    expect(hasConversationReadSecret('chat-d')).toBe(false);
    expect(hasConversationReadSecret('chat-e')).toBe(true);
    clearConversationSecretState();
    expect(conversationsWithSecretRead()).toEqual([]);
  });

  // No conversation id means nothing to clear later: a flag nobody can clear is
  // a flag that outlives the chat it belongs to.
  it('ignores a read with no conversation', () => {
    markConversationReadSecret(undefined);
    expect(hasConversationReadSecret(undefined)).toBe(false);
    expect(conversationsWithSecretRead()).toEqual([]);
  });

  // The batch is where the exfil rule was weakest: one call can read an ordinary
  // file and `.env` together, and the mark has to follow the secret item.
  it('marks the chat when one reads item is a secret', async () => {
    const result = await tool()?.handler?.({ reads: [{ path: 'src/app.ts' }, { path: '.env' }] }, {
      conversationId: 'chat-reads',
      signal,
    } as never);
    const text = String(result);
    expect(text).toContain('export const x = 1;');
    expect(text).toContain('API_KEY=secret-value');
    expect(hasConversationReadSecret('chat-reads')).toBe(true);
    clearConversationSecretState('chat-reads');
  });

  // Marking happens after the read succeeds, so a batch that only failed on its
  // secret item does not make the chat pay for a fetch it never earned.
  it('does not mark the chat when the secret item failed to read', async () => {
    await tool()?.handler?.({ reads: [{ path: 'missing.env' }] }, {
      conversationId: 'chat-reads-fail',
      signal,
    } as never);
    expect(hasConversationReadSecret('chat-reads-fail')).toBe(false);
  });
});
