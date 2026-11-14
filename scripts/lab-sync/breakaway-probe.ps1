# Can a child break away from the job this process is already in?
# That decides whether a job-object fix can work inside the VS Code extension host.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Breakaway {
  const int CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
  const int CREATE_NO_WINDOW = 0x08000000;

  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFO {
    public int cb;
    public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, string cmd, IntPtr sa, IntPtr st, bool inherit,
    int flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr h, int code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

  public static string Try(string commandLine, int flags) {
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    bool ok = CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
      flags | CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi);
    if (!ok) return "flags=0x" + flags.ToString("X") + " create failed err=" + Marshal.GetLastWin32Error();
    bool inJob = false;
    IsProcessInJob(pi.hProcess, IntPtr.Zero, out inJob);
    string result = "flags=0x" + flags.ToString("X") + " pid=" + pi.dwProcessId + " inJob=" + inJob;
    TerminateProcess(pi.hProcess, 0);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return result;
  }
}
'@
$ping = 'ping.exe -n 20 127.0.0.1'
Write-Output ("self in job: " + [Breakaway]::Try('cmd.exe /c ping -n 20 127.0.0.1', 0x00000200))
Write-Output ([Breakaway]::Try($ping, 0))
Write-Output ([Breakaway]::Try($ping, 0x01000000))
