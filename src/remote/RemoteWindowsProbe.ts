/**
 * How many VS Code windows this machine has open, on Windows.
 *
 * The window files in `remote-windows/` only list windows that have Forge in
 * them, so a cap built from them alone can be undercut by every plain VS Code
 * window the owner has open — and those windows cannot be closed from the phone
 * at all, so the refuse message has to say how many Forge counted and how many
 * it merely saw. On Windows that second number comes from the OS: `EnumWindows`
 * with `GetWindowThreadProcessId`, filtered to the Electron window class
 * `Chrome_WidgetWin_1`, visible, with no owner window, and belonging to
 * `Code.exe` **or** `Code - Insiders.exe` — counting only one image name would
 * report the wrong number on an Insiders install.
 *
 * There is no join by pid: every top-level window of one VS Code instance
 * belongs to the same main process, so the OS count cannot be matched to a
 * window file window by window. The files supply the names and the Close
 * buttons; the OS supplies the total.
 *
 * The enumeration runs in a spawned `pwsh` (with `powershell` as the fallback
 * for a machine that has Windows PowerShell but not PowerShell 7), because
 * `Add-Type` is the only way to reach the Win32 calls. A spawn that hangs is
 * killed by `spawnAndWait`'s timeout, and `dispose()` aborts one that is still
 * running, so nothing outlives the window that started it. A hung or failed
 * probe is not an error the phone sees: the caller degrades to the window files
 * and says that is what it counted.
 */
import { ExecCommandError, spawnAndWait, type SpawnResult } from '../util/processSpawn';

/** One OS window, in the shape the real probe returns. */
export interface OsWindowRecord {
  pid: number;
  image: string;
  className: string;
  title: string;
}

/** `ok` means the OS answered; `unavailable` means the count must come from the files. */
export type ProbeOutcome =
  | { source: 'os'; windows: OsWindowRecord[] }
  | { source: 'unavailable'; reason: string };

/** The two process names a VS Code window can belong to. */
export const VSCODE_IMAGE_NAMES = ['Code', 'Code - Insiders'] as const;

/** A window class is not a VS Code window unless it is this one, Electron's. */
export const VSCODE_WINDOW_CLASS = 'Chrome_WidgetWin_1';

/** PowerShell cold-starts and compiles `Add-Type` in well under this; a probe that needs longer has hung. */
export const WINDOWS_PROBE_TIMEOUT_MS = 8_000;

/**
 * The script. It prints one JSON object per matching window, so a fake can
 * return the same shape the real one does, and the C# does the enumeration
 * itself: `EnumWindows` needs a native callback, and doing that from
 * PowerShell script text is what the `Add-Type` block exists for.
 */
export const WINDOWS_PROBE_SCRIPT = `Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class ForgeVsCodeWindows {
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetClassName(IntPtr hWnd, StringBuilder buf, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] static extern int GetWindowText(IntPtr hWnd, StringBuilder buf, int max);

  static readonly HashSet<string> Images = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Code", "Code - Insiders" };

  public static IEnumerable<string> Enumerate() {
    List<string> lines = new List<string>();
    Dictionary<uint,string> byPid = new Dictionary<uint,string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      // GW_OWNER = 4: an owned window is a dialog or a devtools pane, not a VS Code window.
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      StringBuilder cls = new StringBuilder(256);
      if (GetClassName(h, cls, cls.Capacity) <= 0) return true;
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      uint pid = 0;
      GetWindowThreadProcessId(h, out pid);
      if (pid == 0) return true;
      string image;
      if (!byPid.TryGetValue(pid, out image)) {
        image = null;
        try { image = Process.GetProcessById((int)pid).ProcessName; } catch {}
        byPid[pid] = image;
      }
      if (image == null || !Images.Contains(image)) return true;
      StringBuilder title = new StringBuilder(512);
      GetWindowText(h, title, title.Capacity);
      lines.Add("{\\"pid\\":" + pid + ",\\"image\\":" + Quote(image) + ",\\"className\\":" + Quote(cls.ToString()) + ",\\"title\\":" + Quote(title.ToString()) + "}");
      return true;
    }, IntPtr.Zero);
    return lines;
  }

  static string Quote(string s) {
    StringBuilder sb = new StringBuilder("\\"");
    foreach (char c in s) {
      if (c == '"') sb.Append("\\\\\\"");
      else if (c == '\\\\') sb.Append("\\\\\\\\");
      else if (c == '\\n') sb.Append("\\\\n");
      else if (c == '\\r') sb.Append("\\\\r");
      else if (c == '\\t') sb.Append("\\\\t");
      else if (c < ' ') sb.Append("\\\\u").Append(((int)c).ToString("x4"));
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }
}
'@
[ForgeVsCodeWindows]::Enumerate()
`;

/** The spawn-and-collect shape this probe needs, injectable so no test runs PowerShell. */
export type ProbeSpawn = (
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) => Promise<SpawnResult>;

export interface WindowsProbeDeps {
  spawn?: ProbeSpawn;
  platform?: NodeJS.Platform;
  /** Where the child resolves its working directory from; never changes the answer. */
  cwd?: string;
  /** A test's stand-in for the real 8 s, so it measures the timeout path instead
   *  of waiting for it; production never passes it. */
  timeoutMs?: number;
}

/**
 * One probe per window, owned by whoever built the window surface. `count()` is
 * single-flight: a `/workspace windows` list and the cap check it triggers ask
 * at the same moment, and two PowerShell starts for one question is two.
 */
export class RemoteWindowsProbe {
  private readonly spawn: ProbeSpawn;
  private readonly platform: NodeJS.Platform;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private disposed = false;
  private inFlight: { abort: AbortController; promise: Promise<ProbeOutcome> } | undefined;

  constructor(deps: WindowsProbeDeps = {}) {
    this.spawn = deps.spawn ?? spawnAndWait;
    this.platform = deps.platform ?? process.platform;
    this.cwd = deps.cwd ?? process.cwd();
    this.timeoutMs = deps.timeoutMs ?? WINDOWS_PROBE_TIMEOUT_MS;
  }

  /** Never throws: a probe that cannot answer is a fact about the machine, not a failure. */
  async count(): Promise<ProbeOutcome> {
    if (this.disposed) return { source: 'unavailable', reason: 'this window is closing' };
    if (this.platform !== 'win32') {
      return {
        source: 'unavailable',
        reason: `Forge cannot enumerate VS Code windows on ${this.platform}`,
      };
    }
    const running = this.inFlight;
    if (running) return running.promise;
    const abort = new AbortController();
    const promise = this.run(abort.signal).finally(() => {
      if (this.inFlight?.abort === abort) this.inFlight = undefined;
    });
    this.inFlight = { abort, promise };
    return promise;
  }

  /** Aborts a probe still running and refuses to start another one. */
  dispose(): void {
    this.disposed = true;
    this.inFlight?.abort.abort();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  /** `pwsh` first (the plan names it), Windows PowerShell for a machine without it. */
  private async run(signal: AbortSignal): Promise<ProbeOutcome> {
    for (const program of ['pwsh', 'powershell']) {
      try {
        const result = await this.spawn(
          program,
          ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROBE_SCRIPT],
          this.cwd,
          this.timeoutMs,
          {},
          signal,
        );
        if (result.exitCode !== 0) {
          return {
            source: 'unavailable',
            reason: `${program} exited ${result.exitCode}: ${clip(result.stderr)}`,
          };
        }
        return { source: 'os', windows: parseWindowLines(result.stdout) };
      } catch (err) {
        if (signal.aborted) return { source: 'unavailable', reason: 'probe cancelled' };
        if (err instanceof ExecCommandError && err.kind === 'missing_executable') continue;
        return { source: 'unavailable', reason: (err as Error).message };
      }
    }
    return { source: 'unavailable', reason: 'no PowerShell on this machine' };
  }
}

/** One JSON object per line, as the script prints them; anything unparseable is skipped. */
export function parseWindowLines(stdout: string): OsWindowRecord[] {
  const records: OsWindowRecord[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const record = parsed as Partial<OsWindowRecord>;
    if (typeof record.pid !== 'number' || typeof record.image !== 'string') continue;
    // Re-check the filter the script already applied: a probe that reported
    // some other program's window would otherwise be counted as a VS Code one.
    if (!isWithinRange(VSCODE_IMAGE_NAMES, record.image)) continue;
    records.push({
      pid: record.pid,
      image: record.image,
      className: typeof record.className === 'string' ? record.className : '',
      title: typeof record.title === 'string' ? record.title : '',
    });
  }
  return records;
}

function isWithinRange(names: readonly string[], image: string): boolean {
  return (names as readonly string[]).some((name) => name.toLowerCase() === image.toLowerCase());
}

function clip(value: string): string {
  const characters = [...value.trim()];
  return characters.length <= 160 ? characters.join('') : `${characters.slice(0, 159).join('')}…`;
}
