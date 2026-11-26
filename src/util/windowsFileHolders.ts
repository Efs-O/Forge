import { spawn, spawnSync } from 'child_process';
import { powershellScratch } from './powershellScratchDir';

/** `Add-Type` compiles C# on every call, so a loaded machine needs more than 3 s: the v0.17.218 publish run failed at 3 s. */
export const HOLDER_PROBE_TIMEOUT_MS = 10_000;

const RESTART_MANAGER_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ForgeRestartManager {
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessUnique { public int pid; public System.Runtime.InteropServices.ComTypes.FILETIME started; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct ProcessInfo {
    public ProcessUnique process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string app;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string service;
    public int type; public int status; public int session;
    [MarshalAs(UnmanagedType.Bool)] public bool restartable;
  }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmStartSession(out uint handle, int flags, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  static extern int RmRegisterResources(uint handle, uint fileCount, string[] files, uint appCount, ProcessUnique[] apps, uint serviceCount, string[] services);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] info, ref uint rebootReasons);
  public static string Who(string path) {
    uint handle;
    int result = RmStartSession(out handle, 0, Guid.NewGuid().ToString());
    if (result != 0) return "";
    try {
      result = RmRegisterResources(handle, 1, new[] { path }, 0, null, 0, null);
      if (result != 0) return "";
      uint needed = 0, count = 0, reasons = 0;
      result = RmGetList(handle, out needed, ref count, null, ref reasons);
      if (result != 0 && result != 234) return "";
      if (needed == 0) return "";
      var entries = new ProcessInfo[needed];
      count = needed;
      result = RmGetList(handle, out needed, ref count, entries, ref reasons);
      if (result != 0) return "";
      var holders = new List<string>();
      for (int i = 0; i < count; i++) holders.Add(entries[i].process.pid + " " + entries[i].app);
      return String.Join(", ", holders);
    } finally { RmEndSession(handle); }
  }
}
'@
[ForgeRestartManager]::Who($env:FORGE_RM_TARGET)
`;

function powershellEncodedCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Best-effort Restart Manager lookup. It runs only after a Windows rename budget
 * is spent.
 *
 * Both forms compile with `Add-Type`, so both get a scratch folder of their own:
 * CodeDom writes five files into the child's temp, a probe that times out kills
 * the child before CodeDom can clean them up, and the survivors used to land in
 * whoever's temp folder the save happened to be running in - the test suite's
 * per-file folder, which its temp guard then fails for the whole file. The
 * folder is removed as soon as the child is gone; the helper's own prune is only
 * the backstop for a process that died mid-probe.
 */
export function windowsFileHolders(target: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const scratch = powershellScratch('rm-probe');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      powershellEncodedCommand(RESTART_MANAGER_SCRIPT),
    ],
    {
      encoding: 'utf8',
      timeout: HOLDER_PROBE_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, ...scratch.env, FORGE_RM_TARGET: target },
    },
  );
  // spawnSync returned, timeout kill included, so the child is gone and nothing
  // holds CodeDom's files any more.
  scratch.dispose();
  if (result.error || result.status !== 0) return undefined;
  const holders = result.stdout.trim();
  return holders || undefined;
}

/** Asynchronous Restart Manager lookup for a save that succeeded after contention. */
export function windowsFileHoldersAsync(target: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const scratch = powershellScratch('rm-probe');
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        powershellEncodedCommand(RESTART_MANAGER_SCRIPT),
      ],
      {
        windowsHide: true,
        env: { ...process.env, ...scratch.env, FORGE_RM_TARGET: target },
      },
    );
    let stdout = '';
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, HOLDER_PROBE_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => {
      scratch.dispose();
      finish(undefined);
    });
    // `close` also lands after the timeout kill, which is what makes this safe:
    // by then the child is out, so its compiled assembly is unlocked.
    child.on('close', (code) => {
      scratch.dispose();
      finish(code === 0 ? stdout.trim() || undefined : undefined);
    });
  });
}
