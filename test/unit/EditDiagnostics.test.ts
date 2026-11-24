import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  diffProblems,
  makeProblemWatcher,
  type DiagnosticsSource,
  type LanguageMarks,
  type ProblemWatcher,
  type ReportedProblem,
} from '../../src/tools/editDiagnostics';
import { formatDiagnosticLine } from '../../src/tools/lspDiagnosticsTools';
import { makeEditFileTool } from '../../src/tools/editFileTool';
import { makeWriteFileTool } from '../../src/tools/builtinTools';
import { makeApplyLineEditsTool } from '../../src/tools/structuredEditTool';
import { hasPendingDiagnostics } from '../../src/tools/editDiagnosticsSource';

/**
 * `tools.edit_diagnostics` (tools-expansion lane F1, item 1.3).
 *
 * Every test here drives the module through an injected `DiagnosticsSource`,
 * because the stub `vscode` module has no diagnostics to diff and no event to
 * wait for: without the seam, the wait, the diff and the three answers a result
 * can give would all be untestable, and the feature would be tested only by
 * someone noticing a note appeared in an editor.
 */

const FILE = '/workspace/src/a.ts';
let platformBeforeCaseTest: PropertyDescriptor | undefined;

function problem(line: number, overrides: Partial<ReportedProblem> = {}): ReportedProblem {
  return {
    line,
    severity: 0,
    message: 'Cannot find name q.',
    source: 'TypeScript',
    code: 'TS2304',
    ...overrides,
  };
}

/** A fake language service: a map of path to problems, plus the event it fires. */
class FakeSource implements DiagnosticsSource {
  readonly listeners: Array<(paths: string[]) => void> = [];
  reportedCalls = 0;
  /** Every path the watcher asked to be opened, so a test can see the order. */
  opened: string[] = [];
  constructor(
    private pairs: [string, ReportedProblem[]][],
    /** What the source says when it declines to open the file, if anything. */
    private primingReason?: string,
    /** Which open documents this fake holds, by path: the language id it reports. */
    private langs: Record<string, string> = {},
  ) {}
  languageOf(pathToAsk: string): string | undefined {
    return this.langs[pathToAsk];
  }
  reported(): [string, ReportedProblem[]][] | undefined {
    this.reportedCalls += 1;
    return this.pairs;
  }
  /**
   * The stand for `openTextDocument`. It does NOT make the fake report on the
   * path: a real service answers later, and the tests need that gap. A source
   * that gives a reason for not checking does not open the file either.
   */
  async ensureChecked(pathToOpen: string): Promise<string | undefined> {
    if (this.primingReason === undefined) this.opened.push(pathToOpen);
    return this.primingReason;
  }
  onChange(listener: (paths: string[]) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const at = this.listeners.indexOf(listener);
      if (at !== -1) this.listeners.splice(at, 1);
    };
  }
  /** The test's stand for "the service noticed the write and re-reported". */
  setProblems(pathToSet: string, problems: ReportedProblem[]): void {
    this.pairs = [
      ...this.pairs.filter(([entryPath]) => entryPath !== pathToSet),
      [pathToSet, problems],
    ];
  }
  fire(paths: string[]): void {
    for (const listener of [...this.listeners]) listener(paths);
  }
}

function watcherFor(
  source: FakeSource,
  settings: { enabled?: boolean; settle_ms?: number; max_items?: number } = {},
) {
  return makeProblemWatcher({ settings: () => settings, source: () => source });
}

afterEach(() => {
  vi.useRealTimers();
  if (platformBeforeCaseTest !== undefined) {
    Object.defineProperty(process, 'platform', platformBeforeCaseTest);
    platformBeforeCaseTest = undefined;
  }
});

describe('written path casing on Windows', () => {
  it('opens existing and newly created files with their original path casing', async () => {
    platformBeforeCaseTest = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformBeforeCaseTest?.configurable) {
      throw new Error('process.platform cannot be stubbed');
    }
    Object.defineProperty(process, 'platform', { ...platformBeforeCaseTest, value: 'win32' });

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Forge-Mixed-Case-'));
    const existingPath = path.join(root, 'Notes-A1.ts');
    const createdPath = path.join(root, 'Created-B2.ts');
    try {
      fs.writeFileSync(existingPath, 'const q = 1;\n');
      const foldedPath = existingPath.toLowerCase();
      const source = new FakeSource([[foldedPath, [problem(12)]]]);

      const existingWatch = await watcherFor(source, { settle_ms: 0 })(existingPath)!;
      expect(source.opened[0]).toBe(existingPath);
      expect(source.opened).not.toContain(existingPath.toLowerCase());
      source.setProblems(foldedPath, []);
      expect(await existingWatch.settle()).toContain('1 problem this file had before is gone');

      const createdWatch = await watcherFor(source, { settle_ms: 0 })(createdPath)!;
      expect(source.opened).toHaveLength(1);
      fs.writeFileSync(createdPath, 'const r = 2;\n');
      await createdWatch.settle();
      expect(source.opened[1]).toBe(createdPath);
      expect(source.opened).not.toContain(createdPath.toLowerCase());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the note a write result appends', () => {
  it('names the problem an edit introduced, in the same format the diagnostics tool uses', async () => {
    const source = new FakeSource([[FILE, []]]);
    const watch = await watcherFor(source, { settle_ms: 0 })(FILE)!;
    source.setProblems(FILE, [problem(41)]);
    const note = await watch.settle();
    expect(note).toContain('New problems after this edit (TypeScript):');
    expect(note).toContain(
      formatDiagnosticLine(FILE, {
        line: 41,
        severity: 0,
        message: 'Cannot find name q.',
        code: 'TS2304',
      }),
    );
  });

  // The acceptance case that a second diagnostics reader would have gotten wrong:
  // the file had one problem before and the edit took it away, so there is
  // nothing to call new — and saying "1 problem is gone" is what tells the model
  // its edit did something rather than nothing.
  it('does not list a problem the edit fixed, and says it is gone', async () => {
    const source = new FakeSource([[FILE, [problem(41)]]]);
    const watch = await watcherFor(source, { settle_ms: 0 })(FILE)!;
    source.setProblems(FILE, []);
    const note = await watch.settle();
    expect(note).toBe('No new problems after this edit; 1 problem this file had before is gone.');
  });

  // The false "No new problems" Claude's review of 7f05a5d5 found: an agent's
  // edit goes to disk, and the editor's file watcher has to carry that change
  // to the language service. When no event for this file arrives before the
  // deadline, the after-read is the same picture as the before-read, and
  // calling that a clean check reports a verification that never happened.
  it('names an unverified edit when nothing moved and no event arrived', async () => {
    const source = new FakeSource([[FILE, [problem(41)]]]);
    const watch = await watcherFor(source, { settle_ms: 0 })(FILE)!;
    source.setProblems(FILE, [problem(41)]);
    const note = await watch.settle();
    expect(note).toContain('was not checked');
    expect(note).toContain('__code_intel_get_diagnostics');
    expect(note).not.toContain('No new problems');
  });

  // A file that is not open, not served, or not yet analysed has nothing to
  // diff. "No new problems" would be a claim this module cannot make, so the
  // plan says to name the absence instead — and the same sentence covers a file
  // whose language has no provider at all.
  it('says so when no language service reported on the file, before or after', async () => {
    const source = new FakeSource([['/workspace/src/other.ts', [problem(3)]]]);
    const watch = await watcherFor(source, { settle_ms: 0 })(FILE)!;
    const note = await watch.settle();
    expect(note).toContain('No language service reported on this file');
    expect(note).toContain('not proof it is clean');
    expect(note).not.toContain('No new problems');
  });

  // A file nobody reported on that DOES get problems after the write still has
  // nothing to diff against, so the honest word is "what the file shows now":
  // Claude's review of 7f05a5d5, item 2. The old code diffed against an empty
  // before list and called every problem "New problems after this edit", which
  // sent the model hunting for a break its edit never introduced — while
  // hiding them behind the no-service sentence would have hidden the one fact
  // the model asked for.
  it('names problems on a file nothing had reported on as what it shows now, not as new', async () => {
    const source = new FakeSource([]);
    const watch = await watcherFor(source, { settle_ms: 0 })(FILE)!;
    source.setProblems(FILE, [problem(2)]);
    const note = await watch.settle();
    expect(note).toContain('it had not been checked before, so some may predate it');
    expect(note).toContain(
      formatDiagnosticLine(FILE, {
        line: 2,
        severity: 0,
        message: 'Cannot find name q.',
        code: 'TS2304',
      }),
    );
    expect(note).not.toContain('New problems after this edit');
  });

  it('caps the list at max_items and says how many it left out', async () => {
    const source = new FakeSource([[FILE, []]]);
    const watch = await watcherFor(source, { settle_ms: 0, max_items: 2 })(FILE)!;
    source.setProblems(
      FILE,
      [1, 2, 3, 4, 5].map((line) => problem(line, { message: `Error ${line}.` })),
    );
    const note = await watch.settle();
    // Header, the two items the cap allows, and the line naming what the cap
    // left out: a number that only appears in a dropped line is how a model
    // finds out there is more to look at.
    expect(note.split('\n')).toHaveLength(4);
    expect(note).toContain('(+3 more not shown');
  });

  // Info and hint are what a language service says about style, not about the
  // edit being wrong: two of them on every edit would bury the error.
  it('reports errors and warnings, not info or hint', async () => {
    const quiet = new FakeSource([[FILE, []]]);
    const first = await watcherFor(quiet, { settle_ms: 0 })(FILE)!;
    quiet.setProblems(FILE, [
      problem(1, { severity: 2, message: 'Prefer const.' }),
      problem(2, { severity: 3, message: 'Unused.' }),
    ]);
    expect(await first.settle()).toBe('No new problems after this edit.');

    const loud = new FakeSource([[FILE, []]]);
    const second = await watcherFor(loud, { settle_ms: 0 })(FILE)!;
    loud.setProblems(FILE, [problem(1, { severity: 1, message: 'Unused variable.' })]);
    expect(await second.settle()).toContain('New problems after this edit');
  });

  it('does nothing when the config block says enabled: false', async () => {
    const source = new FakeSource([[FILE, []]]);
    expect(await watcherFor(source, { enabled: false })(FILE)).toBeUndefined();
    expect(source.listeners).toHaveLength(0);
  });

  // The forge-bench tool host and any host without the diagnostics API: nothing
  // to diff, so nothing to say — not a sentence about a service that was never
  // there, and no two-second wait either.
  it('is a no-op on a host with no language-service API', async () => {
    const watch = await makeProblemWatcher({
      settings: () => ({}),
      source: () => undefined,
    })(FILE);
    expect(watch).toBeUndefined();
  });

  it('is a no-op when the service cannot be read before the write', async () => {
    const source = new FakeSource([[FILE, []]]);
    source.reported = () => {
      throw new Error('service unavailable');
    };
    expect(
      await makeProblemWatcher({ settings: () => ({}), source: () => source })(FILE),
    ).toBeUndefined();
  });
});

describe('the wait for the language service to catch up', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  // No event is the common case for a file that is not open in an editor: the
  // wait must not go past the deadline, and must read exactly once.
  it('reads once at the deadline when no event arrives', async () => {
    const source = new FakeSource([[FILE, []]]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    source.setProblems(FILE, [problem(9)]);
    let resolved = false;
    const pending = watch.settle().then((note) => {
      resolved = true;
      return note;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const note = await pending;
    expect(note).toContain('New problems after this edit');
    // Once before the write, once after: a second read would let a half-updated
    // picture become the result.
    expect(source.reportedCalls).toBe(2);
    expect(source.listeners).toHaveLength(0);
  });

  // The quiet period is what makes the default two seconds a ceiling and not a
  // cost: a service that answers at 500 ms answers the model at 800 ms.
  it('reads 300 ms after a matching event instead of waiting the full deadline', async () => {
    const source = new FakeSource([[FILE, []]]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    source.setProblems(FILE, [problem(9)]);
    let resolved = false;
    const pending = watch.settle().then((note) => {
      resolved = true;
      return note;
    });
    // The listener is in place by the time settle() returns, so the event can
    // be fired here: that is the ordering a real write produces.
    source.fire([FILE]);
    await vi.advanceTimersByTimeAsync(299);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toContain('New problems after this edit');
    expect(source.reportedCalls).toBe(2);
  });

  // A save of an unrelated open editor fires an event too. Counting it would
  // both make this edit wait for nothing and read a picture that has not
  // settled for THIS file.
  it('ignores events for other files', async () => {
    const source = new FakeSource([[FILE, []]]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    let resolved = false;
    const pending = watch.settle().then((note) => {
      resolved = true;
      return note;
    });
    source.fire(['/workspace/src/unrelated.ts']);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(resolved).toBe(false);
    source.fire([FILE]);
    await vi.advanceTimersByTimeAsync(300);
    await pending;
    expect(resolved).toBe(true);
  });

  // Stop has to end the wait at once, or a cancelled turn keeps holding the tool
  // round for the rest of the deadline — and a listener left behind would fire
  // for calls that no longer exist.
  it('returns at once on Stop and leaves no listener behind', async () => {
    const source = new FakeSource([[FILE, []]]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    source.setProblems(FILE, [problem(9)]);
    const controller = new AbortController();
    let resolved = false;
    const pending = watch.settle(controller.signal).then((note) => {
      resolved = true;
      return note;
    });
    expect(source.listeners).toHaveLength(1);
    controller.abort();
    const note = await pending;
    expect(resolved).toBe(true);
    expect(source.listeners).toHaveLength(0);
    expect(note).toContain('New problems');
    expect(vi.getTimerCount()).toBe(0);
  });

  // The same case with the wait actually running, so the note has to name the
  // time the service had rather than the number the test happened to use.
  it('says the edit was not checked when the deadline passed with no event and nothing moved', async () => {
    const source = new FakeSource([[FILE, [problem(41)]]]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    let resolved = false;
    const pending = watch.settle().then((note) => {
      resolved = true;
      return note;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const note = await pending;
    expect(note).toContain('within 2 s');
    expect(note).toContain('so this edit was not checked');
    expect(note).not.toContain('No new problems');
    expect(source.reportedCalls).toBe(2);
  });

  // Stop is the other way the same lie arrives: the turn was cancelled while the
  // service was still catching up, so the picture is the old one for a reason
  // the model has to be told about.
  it('says the same thing when the turn was stopped before the service answered', async () => {
    const source = new FakeSource([[FILE, [problem(41)]]]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    const controller = new AbortController();
    const pending = watch.settle(controller.signal);
    controller.abort();
    const note = await pending;
    expect(note).toContain('before the turn was stopped');
    expect(note).toContain('was not checked');
    expect(note).not.toContain('No new problems');
    expect(source.listeners).toHaveLength(0);
  });

  // What Claude's review asked to keep working: once the service has reported on
  // this file, an unchanged picture IS a clean answer, and saying "not checked"
  // there would be the opposite error.
  it('says nothing is gone when nothing was, once the service has reported on the file', async () => {
    const source = new FakeSource([[FILE, [problem(41)]]]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    const pending = watch.settle();
    source.fire([FILE]);
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toBe('No new problems after this edit.');
  });

  // A picture that moved without an event is still evidence of a re-check, so it
  // keeps the answer it earned instead of being swallowed by the new sentence.
  it('still reports a picture that moved with no event at all', async () => {
    const source = new FakeSource([[FILE, [problem(41)]]]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    source.setProblems(FILE, []);
    const pending = watch.settle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await pending).toBe(
      'No new problems after this edit; 1 problem this file had before is gone.',
    );
  });

  // Claude's item 2, last bullet: an unserved file used to pay the whole
  // settle_ms for an event that could never arrive. One second is the bound for
  // a file nothing has reported on; a file the service HAS reported on keeps the
  // full deadline, because there the wait buys a real diff.
  it('gives up on an unserved file after one second, not after the whole settle_ms', async () => {
    const source = new FakeSource([['/workspace/src/other.ts', [problem(3)]]]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    let resolved = false;
    const pending = watch.settle().then((note) => {
      resolved = true;
      return note;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const note = await pending;
    expect(note).toContain('No language service reported on this file');
    expect(note).toContain('within 1 s');
    expect(note).not.toContain('No new problems');
  });

  // The other half of the same case: once the service has answered on a file it
  // had not seen before, "I looked and found nothing" is a real answer, and it
  // is said differently from the "no new problems" claim only a diff supports.
  it('says the file is clean when the service answered on a file it had not seen', async () => {
    const source = new FakeSource([]);
    const watch = await watcherFor(source, { settle_ms: 2_000 })(FILE)!;
    const pending = watch.settle();
    source.fire([FILE]);
    await vi.advanceTimersByTimeAsync(300);
    expect(await pending).toBe(`No problems reported in ${FILE} after this edit.`);
  });

  it('settles immediately when settle_ms is 0', async () => {
    const source = new FakeSource([[FILE, []]]);
    const watch = await watcherFor(source, { settle_ms: 0 })(FILE)!;
    source.setProblems(FILE, [problem(9)]);
    expect(await watch.settle()).toContain('New problems after this edit');
    expect(source.reportedCalls).toBe(2);
  });
});

describe('a file nothing has reported on yet — the common agent case', () => {
  // Claude's review of 7f05a5d5, item 2: the TypeScript and ESLint services only
  // report on documents that are OPEN, and most agent edits land on a file no
  // editor holds. Before this commit every such edit waited the full settle_ms
  // for an event that could not come and got "No language service reported on
  // this file". `lspTools.ts` already had the answer for the same problem:
  // `openTextDocument` loads the document without showing it, and the services
  // then check it — so that is what the source's `ensureChecked` does.
  const onDisk = path.join(process.cwd(), 'test', `edit-watch-closed-${process.pid}.ts`);
  const created = path.join(process.cwd(), 'test', `edit-watch-created-${process.pid}.ts`);
  beforeEach(() => {
    fs.writeFileSync(onDisk, 'const q = 1;\n');
    fs.rmSync(created, { force: true });
  });
  afterEach(() => {
    fs.rmSync(onDisk, { force: true });
    fs.rmSync(created, { force: true });
  });

  it('opens a closed file before the write so the service can report on it', async () => {
    const source = new FakeSource([]);
    const watch = await watcherFor(source, { settle_ms: 0 })(onDisk)!;
    expect(source.opened).toHaveLength(1);
    expect(source.opened[0]).toContain(path.basename(onDisk));
    source.setProblems(onDisk, [problem(2)]);
    expect(await watch.settle()).toContain('it had not been checked before');
  });

  // The bound lives in the host-backed source, but the note is this module's
  // claim, and "nothing reported on it" is not the answer when the reason is
  // known: a 6 MB file was never going to be parsed inside the wait, and the
  // model can only act on a note that says so.
  it('says the edit was not checked because the file was too large to open', async () => {
    const reason = 'the file is 6.0 MB and this host opens only files up to 5 MB for checking';
    const source = new FakeSource([], reason);
    const watch = await watcherFor(source, { settle_ms: 0 })(onDisk)!;
    expect(source.opened).toHaveLength(0);
    const note = await watch.settle();
    expect(note).toContain(`because ${reason}`);
    expect(note).toContain('so this edit could not be checked');
    expect(note).toContain('that is not proof it is clean');
    // No time clause: the file was skipped before any wait, so no time was spent.
    expect(note).not.toMatch(/within \d/);
  });

  // The wait is for a report, and a file this host will not open is a file no
  // service is going to report on: every edit to such a file used to pay the
  // whole deadline for a note that was already written. Fake timers make this
  // decisive — nothing is advanced, so a `settle()` that awaited a timer would
  // never come back, and a listener count of zero says the event was never
  // subscribed at all.
  it('does not wait out the deadline for a file it will not open', async () => {
    const reason = 'the file is 6.0 MB and this host opens only files up to 5 MB for checking';
    const source = new FakeSource([], reason);
    vi.useFakeTimers();
    const watch = await watcherFor(source, { settle_ms: 2_000 })(onDisk)!;
    const note = await watch.settle();
    expect(source.listeners).toHaveLength(0);
    expect(note).toBe(
      `No language service checked this file, because ${reason}, so this edit could not be ` +
        'checked — that is not proof it is clean.',
    );
  });

  // `write_file` creating a file: there is nothing to open before the write, so
  // the factory must not try, and opening it afterwards is what gives a service
  // any chance to answer. This is the case the plan's "skip the open" line meant.
  it('does not open a file before the write when the write creates it', async () => {
    const source = new FakeSource([]);
    const watch = await watcherFor(source, { settle_ms: 0 })(created)!;
    expect(source.opened).toHaveLength(0);
    fs.writeFileSync(created, 'const q = 1;\n');
    source.setProblems(created, [problem(1)]);
    const note = await watch.settle();
    expect(source.opened).toHaveLength(1);
    expect(note).toContain('it had not been checked before');
  });

  // A file the factory already opened is opened once. A second `openTextDocument`
  // for the same document costs a load and buys nothing: the service is already
  // looking at it.
  it('opens a file once, not once per phase of the wait', async () => {
    const source = new FakeSource([]);
    const watch = await watcherFor(source, { settle_ms: 0 })(onDisk)!;
    await watch.settle();
    expect(source.opened).toHaveLength(1);
  });

  // Claude's review asked for the plain-text case to stay honest: no service
  // exists for it, so the note may only say that nothing reported on it.
  it('says so for a file with no language service, and does not claim it is clean', async () => {
    const source = new FakeSource([['/workspace/src/other.ts', [problem(3)]]]);
    const watch = await watcherFor(source, { settle_ms: 0 })(FILE)!;
    const note = await watch.settle();
    expect(note).toContain('No language service reported on this file');
    expect(note).toContain('not proof it is clean');
    expect(note).not.toContain('No problems reported');
  });
});

describe('diffProblems', () => {
  // The plan's "line after shifting": an error that only moved because the edit
  // added lines above it is the same error, not a new one. Keyed by identity
  // first and by line second is the only way the two differ.
  it('does not call a moved problem new', () => {
    expect(diffProblems([problem(10)], [problem(12)])).toEqual([]);
  });

  it('calls an extra copy of the same problem new', () => {
    expect(diffProblems([problem(10)], [problem(12), problem(30)])).toEqual([problem(30)]);
  });

  it('calls a problem with a different message new', () => {
    const other = problem(10, { message: 'Expected 2 arguments, but got 3.' });
    expect(diffProblems([problem(10)], [problem(10), other])).toEqual([other]);
  });

  it('keeps problems from different sources apart', () => {
    const eslint = problem(10, { source: 'eslint', code: 'no-unused-vars' });
    expect(diffProblems([problem(10)], [problem(10), eslint])).toEqual([eslint]);
  });

  it('returns nothing when the after set is a subset of the before set', () => {
    expect(diffProblems([problem(10), problem(20)], [problem(12)])).toEqual([]);
  });
});

describe('the VS Code-backed source', () => {
  // The wiring the extension actually uses, proved against the shape of the
  // real API rather than against this module's own idea of it.
  it('diffs against vscode.languages when the host has both APIs', async () => {
    const languages = vscode.languages as unknown as Record<string, unknown>;
    const hadGet = languages['getDiagnostics'];
    const hadOn = languages['onDidChangeDiagnostics'];
    const listeners: Array<(event: { uris: { fsPath: string }[] }) => void> = [];
    let problems: [vscode.Uri, vscode.Diagnostic[]][] = [[vscode.Uri.file(FILE), []]];
    languages['getDiagnostics'] = () => problems;
    languages['onDidChangeDiagnostics'] = (
      listener: (event: { uris: { fsPath: string }[] }) => void,
    ) => {
      listeners.push(listener);
      return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) };
    };
    try {
      const watch = await makeProblemWatcher({ settings: () => ({ settle_ms: 0 }) })(FILE)!;
      expect(hasPendingDiagnostics(vscode.Uri.file(FILE))).toBe(true);
      problems = [
        [
          vscode.Uri.file(FILE),
          [
            {
              range: new vscode.Range(new vscode.Position(40, 0), new vscode.Position(40, 5)),
              severity: vscode.DiagnosticSeverity.Error,
              message: 'Cannot find name q.',
              source: 'TypeScript',
              code: 'TS2304',
            },
          ],
        ],
      ];
      const note = await watch.settle();
      expect(note).toContain('New problems after this edit (TypeScript):');
      expect(note).toContain('error TS2304: Cannot find name q.');
      expect(listeners).toHaveLength(1);
      listeners[0]!({ uris: [vscode.Uri.file(FILE)] });
      expect(listeners).toHaveLength(0);
    } finally {
      languages['getDiagnostics'] = hadGet;
      languages['onDidChangeDiagnostics'] = hadOn;
    }
  });

  // The same guard that makes the forge-bench tool host a no-op: this test's
  // stub `vscode` has getDiagnostics but no event, and a wait that could only
  // ever sleep the full deadline is not a feature.
  it('is a no-op on the stub host, which has no onDidChangeDiagnostics', async () => {
    const languages = vscode.languages as unknown as Record<string, unknown>;
    expect(languages['onDidChangeDiagnostics']).toBeUndefined();
    expect(await makeProblemWatcher({ settings: () => ({}) })(FILE)).toBeUndefined();
  });

  // Claude's review of 7f05a5d5, item 2: the priming open belongs to the
  // workspace the tool already allows. A target reached through
  // `extra_file_roots` is outside it, no language service will ever look at it,
  // and opening it there would cost a document load for a file nothing can
  // report on — so the source must skip it rather than fail on it.
  it('opens a file inside the workspace and skips one outside it', async () => {
    const workspace = vscode.workspace as unknown as Record<string, unknown>;
    const languages = vscode.languages as unknown as Record<string, unknown>;
    const hadFolders = workspace['workspaceFolders'];
    const hadOpen = workspace['openTextDocument'];
    const hadGet = languages['getDiagnostics'];
    const hadOn = languages['onDidChangeDiagnostics'];
    const opened: string[] = [];
    const inside = path.join(process.cwd(), 'test', `edit-watch-vscode-${process.pid}.ts`);
    const outside = path.join(os.tmpdir(), `forge-edit-watch-outside-${process.pid}.ts`);
    fs.writeFileSync(inside, 'const q = 1;\n');
    fs.writeFileSync(outside, 'const q = 1;\n');
    languages['getDiagnostics'] = () => [];
    languages['onDidChangeDiagnostics'] = () => ({ dispose: () => undefined });
    workspace['workspaceFolders'] = [{ uri: vscode.Uri.file(process.cwd()) }];
    workspace['openTextDocument'] = async (uri: { fsPath: string }) => {
      opened.push(uri.fsPath);
      return { uri };
    };
    try {
      const watcher = makeProblemWatcher({ settings: () => ({ settle_ms: 0 }) });
      await (await watcher(inside))!.settle();
      await (await watcher(outside))!.settle();
      expect(
        opened.filter((pathToOpen) => pathToOpen.includes(path.basename(inside))),
      ).toHaveLength(1);
      expect(opened.some((pathToOpen) => pathToOpen.includes(path.basename(outside)))).toBe(false);
    } finally {
      workspace['workspaceFolders'] = hadFolders;
      workspace['openTextDocument'] = hadOpen;
      languages['getDiagnostics'] = hadGet;
      languages['onDidChangeDiagnostics'] = hadOn;
      fs.rmSync(inside, { force: true });
      fs.rmSync(outside, { force: true });
    }
  });
});

describe('the three write tools call it from the same point', () => {
  const root = path.join(process.cwd(), 'test');
  const target = path.join(root, `edit-watch-${process.pid}.ts`);
  const seenSignals: (AbortSignal | undefined)[] = [];
  const seenCaptures: string[] = [];

  // The write tools resolve their path against the open workspace, and this
  // file needs that to exist: without a folder the refusal is "No workspace
  // folder open", which would have made every call-site test here fail for a
  // reason that has nothing to do with the note.
  beforeEach(() => {
    vscode.workspace.workspaceFolders.splice(0, Infinity, {
      uri: vscode.Uri.file(process.cwd()),
    } as unknown as vscode.WorkspaceFolder);
  });
  afterEach(() => {
    vscode.workspace.workspaceFolders.splice(0, Infinity);
  });

  /** A watcher that says one fixed line, so the test is about the call site. */
  function watching(note: string): ProblemWatcher {
    return async (writtenPath) => ({
      async settle(signal) {
        seenSignals.push(signal);
        expect(writtenPath).toContain(path.basename(target));
        return note;
      },
    });
  }

  /** A watcher that records what the file held at the moment it was awaited. */
  function watchingAndCapturing(note: string): ProblemWatcher {
    return async (writtenPath) => {
      seenCaptures.push(fs.existsSync(writtenPath) ? fs.readFileSync(writtenPath, 'utf8') : '');
      return {
        async settle(): Promise<string> {
          return note;
        },
      };
    };
  }

  const NO_NOTE = 'No new problems after this edit.';

  afterEach(() => {
    seenSignals.length = 0;
    seenCaptures.length = 0;
    fs.rmSync(target, { force: true });
  });

  it('edit_file appends the note after its own result text', async () => {
    fs.writeFileSync(target, 'const q = 1;\n');
    const result = String(
      await makeEditFileTool(() => [], undefined, watching('NEW')).handler({
        path: target,
        old_str: 'const q = 1;',
        new_str: 'const qq = 1;',
      }),
    );
    expect(result).toBe(`Replaced in ${target}\nNEW`);
  });

  it('write_file appends it for a full write and for an append', async () => {
    const result = String(
      await makeWriteFileTool(() => [], undefined, watching(NO_NOTE)).handler({
        path: target,
        content: 'const q = 1;\n',
      }),
    );
    expect(result).toBe(`Written ${target}\n${NO_NOTE}`);
    const appended = String(
      await makeWriteFileTool(() => [], undefined, watching(NO_NOTE)).handler({
        path: target,
        content: 'const w = 2;\n',
        mode: 'append',
      }),
    );
    expect(appended).toContain(`\n${NO_NOTE}`);
    expect(fs.readFileSync(target, 'utf8')).toBe('const q = 1;\nconst w = 2;\n');
  });

  it('apply_line_edits appends it after its JSON result', async () => {
    fs.writeFileSync(target, 'const q = 1;\n');
    const result = String(
      await makeApplyLineEditsTool(() => [], undefined, watching(NO_NOTE)).handler({
        path: target,
        operations: [
          {
            start_line: 1,
            end_line: 1,
            expected_lines: ['const q = 1;'],
            replacement_lines: ['const qq = 1;'],
          },
        ],
      }),
    );
    expect(result).toContain(`\n${NO_NOTE}`);
    expect(result.indexOf(NO_NOTE)).toBeGreaterThan(result.indexOf('operationsApplied'));
  });

  // The wait is the thing a Stop has to cancel: three tools, one signal, and a
  // test that the signal actually reaches it rather than assuming it does.
  it('hands the call abortSignal to every settle', async () => {
    const controller = new AbortController();
    fs.writeFileSync(target, 'const q = 1;\n');
    await makeEditFileTool(() => [], undefined, watching('')).handler(
      { path: target, old_str: 'const q = 1;', new_str: 'const qq = 1;' },
      { abortSignal: controller.signal },
    );
    await makeWriteFileTool(() => [], undefined, watching('')).handler(
      { path: target, content: 'x' },
      { abortSignal: controller.signal },
    );
    await makeApplyLineEditsTool(() => [], undefined, watching('')).handler(
      {
        path: target,
        operations: [
          {
            start_line: 1,
            end_line: 1,
            expected_lines: ['x'],
            replacement_lines: ['y'],
          },
        ],
      },
      { abortSignal: controller.signal },
    );
    expect(seenSignals).toHaveLength(3);
    expect(seenSignals.every((signal) => signal === controller.signal)).toBe(true);
  });

  // Claude's review of 7f05a5d5, item 2: the watcher has to be awaited BEFORE
  // the write, because opening the document is what lets the language service see
  // the change at all. A tool that awaited it after its write would still pass
  // every other test in this file and check nothing.
  it('awaits the watcher before the bytes change, in all three tools', async () => {
    fs.writeFileSync(target, 'const q = 1;\n');
    await makeEditFileTool(() => [], undefined, watchingAndCapturing('')).handler({
      path: target,
      old_str: 'const q = 1;',
      new_str: 'const qq = 1;',
    });
    expect(seenCaptures[0]).toBe('const q = 1;\n');
    await makeWriteFileTool(() => [], undefined, watchingAndCapturing('')).handler({
      path: target,
      content: 'const w = 2;\n',
    });
    expect(seenCaptures[1]).toBe('const qq = 1;\n');
    await makeApplyLineEditsTool(() => [], undefined, watchingAndCapturing('')).handler({
      path: target,
      operations: [
        {
          start_line: 1,
          end_line: 1,
          expected_lines: ['const w = 2;'],
          replacement_lines: ['const q = 1;'],
        },
      ],
    });
    expect(seenCaptures[2]).toBe('const w = 2;\n');
    expect(seenCaptures).toHaveLength(3);
  });

  // What every existing write-tool test already asserts, restated as the
  // invariant this feature must not break: a tool built without the watcher —
  // which is what every caller that has not wired it gets — says exactly what it
  // used to say.
  it('adds nothing when no watcher was wired', async () => {
    fs.writeFileSync(target, 'const q = 1;\n');
    const edited = String(
      await makeEditFileTool().handler({
        path: target,
        old_str: 'const q = 1;',
        new_str: 'const qq = 1;',
      }),
    );
    expect(edited).toBe(`Replaced in ${target}`);
    const written = String(
      await makeWriteFileTool().handler({ path: target, content: 'const q = 1;\n' }),
    );
    expect(written).toBe(`Written ${target}`);
    const structured = String(
      await makeApplyLineEditsTool().handler({
        path: target,
        operations: [
          {
            start_line: 1,
            end_line: 1,
            expected_lines: ['const q = 1;'],
            replacement_lines: ['const qq = 1;'],
          },
        ],
      }),
    );
    expect(structured).toContain('"operationsApplied":1');
    expect(structured.split('\n')).toHaveLength(1);
  });
});

/**
 * A language nothing on this host reports on.
 *
 * Plain text, Markdown and data files have no diagnostics provider, so every
 * write to one paid the cold wait for the same hedge sentence (owner report
 * 2026-11-09: the note came back on every write in a Python-free repo and the
 * model kept reporting it as if it meant something). The first write still says
 * it; after that the language is remembered as unserved, in memory only, and a
 * service that starts late clears its language the moment it reports.
 */
describe('a language no service on this host reports on', () => {
  const TXT = '/workspace/notes/readme.txt';
  const OTHER = '/workspace/notes/other.txt';
  const LANGS = { [TXT]: 'plaintext', [OTHER]: 'plaintext' };

  function marksWatcher(source: FakeSource, marks: LanguageMarks, settleMs = 20): ProblemWatcher {
    return makeProblemWatcher({
      settings: () => ({ settle_ms: settleMs }),
      source: () => source,
      languageMarks: marks,
    });
  }

  it('waits and says once that nothing reported on it', async () => {
    const source = new FakeSource([], undefined, LANGS);
    const marks = new Set<string>();
    const watch = await marksWatcher(source, marks)(TXT)!;
    const note = await watch.settle();
    expect(note).toContain('No language service reported on this file');
    expect(note).toContain('that is not proof it is clean');
    expect(marks.has('plaintext')).toBe(true);
  });

  it('says nothing on the next write to that language, and does not wait', async () => {
    const source = new FakeSource([], undefined, LANGS);
    const marks = new Set<string>();
    const watcher = marksWatcher(source, marks, 400);
    await (await watcher(TXT)!).settle();
    const started = Date.now();
    const second = await (await watcher(TXT)!).settle();
    expect(second).toBe('');
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('waits and says again once that language has reported on anything', async () => {
    const source = new FakeSource([], undefined, LANGS);
    const marks = new Set<string>();
    const watcher = marksWatcher(source, marks);
    await (await watcher(TXT)!).settle();
    expect(marks.has('plaintext')).toBe(true);
    source.fire([OTHER]);
    expect(marks.has('plaintext')).toBe(false);
    const note = await (await watcher(TXT)!).settle();
    expect(note).toContain('No language service reported on this file');
    expect(marks.has('plaintext')).toBe(true);
  });

  it('keeps checking a language that does report', async () => {
    const source = new FakeSource([[FILE, []]], undefined, { [FILE]: 'typescript' });
    const marks = new Set<string>();
    const watch = await marksWatcher(source, marks)(FILE)!;
    const note = await watch.settle();
    expect(note).toContain('not checked');
    expect(marks.size).toBe(0);
  });
});
