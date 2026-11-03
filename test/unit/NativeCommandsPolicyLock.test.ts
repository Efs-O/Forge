import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `forge.lockPolicy` and `forge.unlockPolicy`, as the owner meets them: a toast
 * with one button.
 *
 * The 0.17.117 live test found both halves of this pair broken in the same
 * direction — the notice said more than it could keep, and the button it offered
 * was decorative:
 * - It pasted `icacls`'s own lines under the sentence. Four lines of
 *   access-control text in a toast that closes, and the owner cannot select any
 *   of it. The detail now goes to the Forge log; the notice stays the one
 *   sentence that says what the file is and what to do next.
 * - `void showInformationMessage(...)` threw the answer away, so `Unlock it
 *   again` printed and did nothing when pressed. Pressing it now runs the
 *   opposite command, which reports the state it read back off the file.
 *
 * `policyLockSentence` is left real and only the two mutators are faked, so the
 * sentence asserted here is the one the product actually shows. The mutators are
 * faked because the real ones need `icacls` and a file whose mode the test can
 * trust, which is `test/integration/PolicyLockFile.test.ts`.
 */
const commands = new Map<string, () => Promise<void>>();
const executed: string[] = [];
const notices: Array<{ message: string; items: string[] }> = [];
const errors: string[] = [];
const logLines: string[] = [];
/** What the owner clicks. Undefined is the same as closing the toast. */
let answer: string | undefined;
/** Set to make the follow-up command fail, so the notice can be asked to say which step failed. */
let executeFailure: Error | undefined;

/** `icacls`'s own shape: several lines, a SID, and a trailer nobody reads. */
const ICACLS_DETAIL =
  'N:\\.forge\\policy.yaml NT AUTHORITY\\SYSTEM:(I)(F)\n' +
  'BUILTIN\\Administrators:(I)(F)\n' +
  'S-1-5-21-1-2-3-1001:(I)(R)\n\n1 file(s) processed.';

vi.mock('vscode', () => ({
  commands: {
    registerCommand: (id: string, cb: () => Promise<void>) => {
      commands.set(id, cb);
      return { dispose: () => {} };
    },
    executeCommand: async (id: string) => {
      executed.push(id);
      if (executeFailure) throw executeFailure;
    },
  },
  window: {
    showInformationMessage: async (message: string, ...items: string[]) => {
      notices.push({ message, items });
      return answer;
    },
    showErrorMessage: async (message: string) => {
      errors.push(message);
    },
    createOutputChannel: () => ({
      appendLine: (line: string) => logLines.push(line),
      clear: () => {},
      show: () => {},
      dispose: () => {},
    }),
    activeTextEditor: undefined,
  },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => undefined }) },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

vi.mock('../../src/config/policyLock', async () => {
  const actual =
    await vi.importActual<typeof import('../../src/config/policyLock')>('../../src/config/policyLock');
  return {
    ...actual,
    lockPolicyFile: () => ({
      policyPath: 'policy.yaml',
      state: 'locked' as const,
      writableByForge: false,
      detail: ICACLS_DETAIL,
    }),
    unlockPolicyFile: () => ({
      policyPath: 'policy.yaml',
      state: 'unlocked' as const,
      writableByForge: true,
      detail: 'mode 0644',
    }),
  };
});

const { registerNativeCommands } = await import('../../src/vscode/nativeCommands');

function register(): void {
  const deps = {
    backend: { acquire: async () => ({} as never), stopAll: async () => {} },
    sidebar: { switchModel: async () => {} },
    statusBar: { setStarting: () => {}, setReady: () => {}, setStopped: () => {}, setError: () => {} },
    getConfig: () => ({ models: [], active_model: null, llama_server: { port: 8080 } }),
    getConfigPath: () => 'config.yaml',
    setConfig: () => {},
  };
  registerNativeCommands({ subscriptions: [] } as never, deps as never);
}

describe('the policy lock notices', () => {
  beforeEach(() => {
    commands.clear();
    executed.length = 0;
    notices.length = 0;
    errors.length = 0;
    logLines.length = 0;
    answer = undefined;
    executeFailure = undefined;
    register();
  });

  it('says one sentence, and puts the access-control lines in the log', async () => {
    await commands.get('forge.lockPolicy')!();

    const notice = notices[0]!;
    expect(notice.message).toContain('policy.yaml is LOCKED');
    // No icacls line survives in the toast, and the notice has no second
    // paragraph to squint at before it closes.
    expect(notice.message).not.toContain('S-1-5-21');
    expect(notice.message).not.toContain('file(s) processed');
    expect(notice.message).not.toContain('\n');
    // The detail is not gone, only moved: the owner can open the Forge log.
    expect(logLines.join('\n')).toContain('S-1-5-21-1-2-3-1001:(I)(R)');
  });

  it('offers the way back, and takes it when it is clicked', async () => {
    answer = 'Unlock it again';
    await commands.get('forge.lockPolicy')!();

    expect(notices[0]!.items).toEqual(['Unlock it again']);
    expect(executed).toEqual(['forge.unlockPolicy']);
    // The unlock command reports its own state in its own notice, so the lock
    // handler says nothing further on top of it.
    expect(notices).toHaveLength(1);
  });

  it('the unlock notice offers to lock it again, and locking runs that command', async () => {
    answer = 'Lock it again';
    await commands.get('forge.unlockPolicy')!();

    expect(notices[0]!.message).toContain('policy.yaml is unlocked');
    expect(notices[0]!.items).toEqual(['Lock it again']);
    expect(executed).toEqual(['forge.lockPolicy']);
    expect(logLines.join('\n')).toContain('mode 0644');
  });

  it('a toast closed without a choice runs nothing', async () => {
    await commands.get('forge.lockPolicy')!();
    expect(executed).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('a follow-up command that fails says which step failed', async () => {
    // Only the second half is broken here: the lock itself worked and reported
    // itself honestly, so the failure message must not blame it.
    answer = 'Unlock it again';
    executeFailure = new Error('the window is closing');

    await commands.get('forge.lockPolicy')!();

    expect(errors[0]).toContain('Unlock it again failed');
    expect(errors[0]).toContain('the window is closing');
    expect(errors[0]).not.toContain('could not lock');
  });
});
