import { spawn, spawnSync } from 'child_process';

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

/** Best-effort Restart Manager lookup. It runs only after a Windows rename budget is spent. */
export function windowsFileHolders(target: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
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
      timeout: 3_000,
      windowsHide: true,
      env: { ...process.env, FORGE_RM_TARGET: target },
    },
  );
  if (result.error || result.status !== 0) return undefined;
  const holders = result.stdout.trim();
  return holders || undefined;
}

/** Asynchronous Restart Manager lookup for a save that succeeded after contention. */
export function windowsFileHoldersAsync(target: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        powershellEncodedCommand(RESTART_MANAGER_SCRIPT),
      ],
      { windowsHide: true, env: { ...process.env, FORGE_RM_TARGET: target } },
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
    }, 3_000);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 ? stdout.trim() || undefined : undefined));
  });
}
