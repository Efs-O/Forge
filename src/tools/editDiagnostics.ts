/**
 * The "new problems after this edit" note a write result appends.
 *
 * `edit_file`, `write_file` and `apply_line_edits` each call this once, after
 * their write, exactly as they call `fileLengthWarning.ts` once — the same
 * reason that module exists: the text, the diff and the wait are one decision,
 * and three tools making it separately would drift the first time one of them
 * reworded its own result.
 *
 * What it is for: a model that edits a file and gets `Replaced in src/a.ts`
 * has no idea whether the change type-checks, so it either runs `tsc` in the
 * shell (271 of those rounds in the audit window) or finds the error several
 * rounds later. This answers the question in the round the edit already cost.
 *
 * What it is NOT: a second diagnostics reader. `__code_intel_get_diagnostics`
 * (`lspTools.ts`) already reads and formats them, and the per-line format is
 * that file's exported `formatDiagnosticLine`, called from both — two
 * spellings of the same problem is how a model learns to distrust one of them.
 * This module owns only the before/after snapshot, the wait for the language
 * service to catch up, and the diff. The VS Code-backed source is
 * `editDiagnosticsSource.ts`: this file owns what the note may claim, that one
 * owns the host's API shape, and `editDiagnosticsNotes.ts` owns the sentences
 * this file falls back on when the check did not happen.
 *
 * Deliberately absent, each one checked: no second checkpoint and no change to
 * Keep/Undo (the note is text in a result, not a state change); no reporting of
 * problems the file already had, because that would make every edit look like
 * it broke something; and no wait at all when the host has no language services
 * (the forge-bench tool host), where the whole feature is a no-op.
 */
import * as fs from 'fs';
import { vscodeDiagnosticsSource } from './editDiagnosticsSource';
import { describeProblems } from './editDiagnosticsNotes';
export { diffProblems } from './editDiagnosticsNotes';

/** `tools.edit_diagnostics` as config.yaml states it. */
export interface EditDiagnosticsSettings {
  enabled?: boolean;
  settle_ms?: number;
  max_items?: number;
}

/** Read live, so editing config.yaml changes the behaviour without re-registering the tools. */
export type EditDiagnosticsGetter = () => EditDiagnosticsSettings | undefined;

/** How long the language service has to stay quiet before the result is read. */
const QUIET_MS = 300;
/** The whole wait, default: two seconds, against a `tsc`/`eslint` shell round. */
const DEFAULT_SETTLE_MS = 2_000;
const DEFAULT_MAX_ITEMS = 10;
/**
 * The deadline for a file nothing has reported on yet — a cold open, or a
 * language with no provider. Judgement, not measurement: a second is long
 * enough for a warm server to analyse one freshly opened document, and when
 * nothing answers, the note is the same sentence whatever the wait. A file that
 * WAS reported on keeps the full `settle_ms`, because there the wait buys a diff.
 */
const COLD_REPORT_WAIT_MS = 1_000;

/** A problem as a language service reported it, in the shape this module needs. */
export interface ReportedProblem {
  /** One-based line, because that is what a result and an editor both show. */
  line: number;
  /** A `vscode.DiagnosticSeverity` value: 0 error, 1 warning, 2 info, 3 hint. */
  severity: number;
  message: string;
  source?: string;
  code?: string | number;
}

/**
 * The language-service surface this module needs, as two methods.
 *
 * Injectable because nothing else here can be tested at all without it: the
 * settle wait, the diff and the three answers a result can give are all
 * invisible to a stub `vscode` module that has no diagnostics. It is also the
 * seam that makes the feature a no-op where no VS Code API exists — a host
 * whose `languages` namespace is absent gets `undefined` here and appends
 * nothing, rather than a sentence about a service that was never there.
 */
export interface DiagnosticsSource {
  /**
   * Every (absolute path, problems) pair the language services have reported.
   *
   * `undefined` means this host has no language services at all. A file that is
   * absent from the pairs is not "clean": nothing has reported on it, which is
   * why the note says so instead of claiming the edit introduced nothing.
   */
  reported(): [string, ReportedProblem[]][] | undefined;
  /**
   * Make a language service look at this file: load it without showing it. The
   * services only report on documents they hold, and most agent edits land on a
   * file no editor has open, so without this the note could only ever say
   * "nothing reported on it" — after spending the whole wait on a file that was
   * never going to answer. A host that cannot open one resolves anyway: a
   * preparatory step must not fail the write. It resolves with the reason it
   * did not open the file, when it knows one, so the note can name it.
   */
  ensureChecked(path: string): Promise<string | undefined>;
  /**
   * Listen for "the problems of some file changed"; the listener gets the paths
   * that changed, and returns the unsubscribe. Every path that ends the wait
   * disposes the listener, including a Stop.
   */
  onChange(listener: (paths: string[]) => void): () => void;
  /**
   * The language id of an open document at this path, or undefined when no
   * editor holds one. It answers the one question a wait cannot: whether this
   * host has a language service for this kind of file at all. A file whose
   * language no service has ever reported on is not an edit that went unchecked
   * — it is an edit nothing can check, and saying so on every write is noise.
   */
  languageOf?(path: string): string | undefined;
}

export type DiagnosticsSourceFactory = () => DiagnosticsSource | undefined;

export interface ProblemWatch {
  /** Wait for the language service to catch up, then say what this edit introduced. */
  settle(signal?: AbortSignal): Promise<string>;
}

/**
 * Built once per tool, called with the path a tool is about to write, BEFORE the
 * write: the document has to be open first or the service never sees the change,
 * and the snapshot has to be taken after the open so the before picture is the
 * one the service actually held.
 */
export type ProblemWatcher = (writtenPath: string) => Promise<ProblemWatch | undefined>;

/** Nothing to watch: the default for a tool built without the feature wired. */
export const NO_PROBLEM_WATCHER: ProblemWatcher = async () => undefined;

/**
 * The languages this host has waited on and never heard from.
 *
 * A language with no diagnostics provider — plain text, Markdown, a data file —
 * answers nothing, so every write to it paid the cold wait for the same hedge.
 * The first write still pays it and still says so; after that the note is
 * dropped for that language. In memory only: nothing outlives the window, and a
 * server that starts late clears its language the first time it reports.
 */
export interface LanguageMarks {
  has(languageId: string): boolean;
  add(languageId: string): void;
  delete(languageId: string): void;
}

/** The one set every tool shares for the life of the window. */
const unservedLanguages: LanguageMarks = new Set<string>();

/** The one append point: `result` plus the note, or `result` untouched. */
export function withProblemNote(result: string, note: string): string {
  return note ? `${result}\n${note}` : result;
}

/**
 * The watcher, reading `tools.edit_diagnostics` per call.
 *
 * `enabled` defaults to ON, which is the one block under `tools:` that does,
 * against this file's "absent means off" convention: the plan priced the cost
 * (up to two seconds per edit) against the shell rounds it replaces and called
 * it worth having by default. `enabled: false` restores today's results exactly.
 */
export function makeProblemWatcher(deps: {
  settings: EditDiagnosticsGetter;
  source?: DiagnosticsSourceFactory;
  /** The unserved-language set to use; the shared one when not given (tests pass their own). */
  languageMarks?: LanguageMarks;
}): ProblemWatcher {
  const sourceOf = deps.source ?? vscodeDiagnosticsSource;
  const marks = deps.languageMarks ?? unservedLanguages;
  // The listener that clears a mark has to outlive the write that set it: a
  // Python server may report on its own file a minute later, and from then on
  // writes to Python wait and note as they always did. Installed once per tool,
  // for as long as the tool lives.
  let clearingInstalled = false;
  return async (writtenPath: string) => {
    const configured = deps.settings();
    if (configured?.enabled === false) return undefined;
    const settleMs = bounded(configured?.settle_ms, DEFAULT_SETTLE_MS, 0, 15_000);
    const maxItems = bounded(configured?.max_items, DEFAULT_MAX_ITEMS, 1, 50);
    const source = sourceOf();
    if (!source) return undefined;
    const key = matchingKey(writtenPath);
    // A file that does not exist yet cannot be opened, so a create is left to
    // the settle path below, which opens it once the write has landed.
    const existedBefore = fs.existsSync(writtenPath);
    let notPrimed: string | undefined;
    if (existedBefore) {
      try {
        notPrimed = await source.ensureChecked(writtenPath);
      } catch {
        // Priming is a bonus: the note reads whatever the service did report.
      }
    }
    let snapshot: Map<string, ReportedProblem[]> | undefined;
    try {
      snapshot = problemsByPath(source.reported());
    } catch {
      // A language service that cannot be read before the write cannot be
      // diffed against it either; say nothing rather than guess.
      return undefined;
    }
    if (snapshot === undefined) return undefined;
    const beforeSeen = snapshot.has(key);
    const beforeProblems = snapshot.get(key) ?? [];
    return {
      async settle(signal?: AbortSignal): Promise<string> {
        // Nothing reported on this file means it is new or unserved. Opening it
        // now — after the write, so the service sees the new bytes — is the only
        // thing that can make the wait worth running: without it the answer for a
        // created file is always "nothing reported on it". A file the factory
        // already opened is opened once, not twice.
        if (!beforeSeen && !existedBefore && fs.existsSync(writtenPath)) {
          try {
            notPrimed ??= await source.ensureChecked(writtenPath);
          } catch {
            // Same as before the write: a failed priming step fails nothing.
          }
        }
        const language = source.languageOf?.(writtenPath);
        if (language !== undefined && marks.has(language)) {
          // Nothing on this host reports on this kind of file, and this already
          // said so once: no wait, and no second hedge to read.
          return '';
        }
        if (language !== undefined && source.languageOf && !clearingInstalled) {
          clearingInstalled = true;
          source.onChange((paths) => {
            // A service spoke up about this language: it is served after all.
            for (const reportedPath of paths) {
              const served = source.languageOf?.(reportedPath);
              if (served !== undefined) marks.delete(served);
            }
          });
        }
        const deadlineMs = beforeSeen ? settleMs : Math.min(settleMs, COLD_REPORT_WAIT_MS);
        // A file this host will not open for checking is a file no service is
        // going to report on, so the wait cannot answer anything about it: every
        // edit to such a file paid the whole deadline for a note that was
        // already written. Skipping it is why the note names a reason and no
        // time — there was no time to spend.
        const skippedWait = notPrimed !== undefined && !beforeSeen;
        const { eventArrived, aborted } = skippedWait
          ? { eventArrived: false, aborted: false }
          : await waitForSettle(source, key, deadlineMs, signal);
        let pairs: [string, ReportedProblem[]][] | undefined;
        try {
          pairs = source.reported();
        } catch {
          return '';
        }
        const after = pairs === undefined ? undefined : problemsByPath(pairs);
        if (after === undefined) return '';
        if (
          language !== undefined &&
          !beforeSeen &&
          !eventArrived &&
          (after.get(key) ?? []).length === 0
        ) {
          // Waited, nothing arrived: this language has no service here, and the
          // next write to it will not pay for the same answer again.
          marks.add(language);
        }
        return describeProblems({
          beforeSeen,
          beforeProblems,
          afterProblems: after.get(key) ?? [],
          eventArrived,
          aborted,
          deadlineMs: skippedWait ? undefined : deadlineMs,
          writtenPath,
          maxItems,
          notPrimed,
        });
      },
    };
  };
}

/** What the wait actually saw, which decides whether the note may claim anything. */
interface SettleOutcome {
  /** An event naming this file arrived, so the service had a chance to re-check it. */
  eventArrived: boolean;
  /** The wait ended because the call was stopped rather than because time ran out. */
  aborted: boolean;
}

/**
 * Wait for the language service to finish reacting to the write.
 *
 * The deadline bounds the whole wait; a matching event restarts a quiet period,
 * so a service that answers quickly answers early and the two seconds are the
 * ceiling, not the cost. Events for other files are ignored: a save of an
 * unrelated open editor must not make this edit wait, and must not make this
 * edit's result read a half-updated picture.
 *
 * Every exit disposes the listener — including Stop, which has to return at
 * once with what is known rather than hold a turn for the rest of the deadline.
 *
 * It also reports what the wait saw, because the note cannot tell "the file is
 * clean" from "the service never got this file" without it.
 */
async function waitForSettle(
  source: DiagnosticsSource,
  key: string,
  settleMs: number,
  signal?: AbortSignal,
): Promise<SettleOutcome> {
  if (signal?.aborted || settleMs <= 0) {
    return { eventArrived: false, aborted: signal?.aborted === true };
  }
  let dispose = (): void => undefined;
  const outcome: SettleOutcome = { eventArrived: false, aborted: false };
  try {
    await new Promise<void>((resolve) => {
      let quietTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        clearTimeout(deadline);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => {
        outcome.aborted = true;
        finish();
      };
      const deadline = setTimeout(finish, settleMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      const onEvent = (paths: string[]): void => {
        if (!paths.some((path) => matchingKey(path) === key)) return;
        outcome.eventArrived = true;
        if (quietTimer !== undefined) clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, Math.min(QUIET_MS, settleMs));
      };
      dispose = source.onChange(onEvent);
    });
  } finally {
    dispose();
  }
  return outcome;
}

function problemsByPath(
  pairs: [string, ReportedProblem[]][] | undefined,
): Map<string, ReportedProblem[]> | undefined {
  if (pairs === undefined) return undefined;
  const byPath = new Map<string, ReportedProblem[]>();
  for (const [path, problems] of pairs) {
    byPath.set(matchingKey(path), problems);
  }
  return byPath;
}

/**
 * The spelling two different callers of the same API will produce.
 *
 * The tool hands this module the resolved real path; VS Code hands it a file
 * URI's `fsPath`. On Windows those differ in case and in the drive-letter
 * separator, and a mismatch here is a note that never appears — the invisible
 * kind of failure. Forward slashes and, on Windows only, case are normalised;
 * a case-sensitive platform keeps its case.
 */
function matchingKey(path: string): string {
  const normalized = path.replace(/\\/gu, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function bounded(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
