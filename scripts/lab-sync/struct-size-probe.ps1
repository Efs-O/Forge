Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobTry {
  const int JobObjectBasicLimitInformation = 2;
  const int JobObjectExtendedLimitInformation = 9;
  const int KillOnJobClose = 0x00002000;

  [StructLayout(LayoutKind.Sequential)]
  public struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public int LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public int ActiveProcessLimit;
    public UIntPtr Affinity;
    public int PriorityClass;
    public int SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IoCounters {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct ExtendedLimits {
    public BasicLimits BasicInformation;
    public IoCounters IoInformation;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateJobObjectW")]
  static extern IntPtr CreateJobObjectSafe(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimits info, int len);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObjectBasic(IntPtr job, int cls, ref BasicLimits info, int len);
  [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "SetInformationJobObject")]
  static extern bool SetInformationBasic(IntPtr job, int cls, ref BasicLimits info, int len);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int cls, ref ExtendedLimits info, int len, out int returned);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);

  public static string Report() {
    var log = new System.Text.StringBuilder();
    IntPtr job = CreateJobObjectSafe(IntPtr.Zero, null);
    int createErr = Marshal.GetLastWin32Error();
    log.Append("job=" + job + " createErr=" + createErr + " sizeofBasic=" + Marshal.SizeOf(typeof(BasicLimits)) +
      " sizeofExt=" + Marshal.SizeOf(typeof(ExtendedLimits)) + "; ");
    if (job == IntPtr.Zero) return log.ToString();

    var ext = new ExtendedLimits();
    ext.BasicInformation.LimitFlags = KillOnJobClose;
    foreach (int length in new int[] { 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136 }) {
      bool tried = SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref ext, length);
      log.Append("len=" + length + " ok=" + tried + " err=" + Marshal.GetLastWin32Error() + "; ");
    }
    var sb = new System.Text.StringBuilder();
    var basicProbe = new BasicLimits();
    basicProbe.LimitFlags = KillOnJobClose;
    for (int cls = 1; cls <= 16; cls++) {
      bool extOk = SetInformationJobObject(job, cls, ref ext, Marshal.SizeOf(typeof(ExtendedLimits)));
      int extErr = Marshal.GetLastWin32Error();
      bool basicOk = SetInformationBasic(job, cls, ref basicProbe, Marshal.SizeOf(typeof(BasicLimits)));
      int basicErr = Marshal.GetLastWin32Error();
      sb.Append("cls=" + cls + " ext112=" + extOk + "/" + extErr + " basic64=" + basicOk + "/" + basicErr + "; ");
    }
    log.Append(sb.ToString());
    var zero = new ExtendedLimits();
    bool okZero = SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref zero,
      Marshal.SizeOf(typeof(ExtendedLimits)));
    log.Append("setExtZero=" + okZero + " err=" + Marshal.GetLastWin32Error() + "; ");
    bool ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref ext,
      Marshal.SizeOf(typeof(ExtendedLimits)));
    log.Append("setExtKill=" + ok + " err=" + Marshal.GetLastWin32Error() + "; ");
    var basicZero = new BasicLimits();
    bool okBasicZero = SetInformationBasic(job, JobObjectBasicLimitInformation, ref basicZero,
      Marshal.SizeOf(typeof(BasicLimits)));
    log.Append("setBasicZero=" + okBasicZero + " err=" + Marshal.GetLastWin32Error() + "; ");

    var readBack = new ExtendedLimits();
    int returned = 0;
    bool queried = QueryInformationJobObject(job, JobObjectExtendedLimitInformation, ref readBack,
      Marshal.SizeOf(typeof(ExtendedLimits)), out returned);
    log.Append("query=" + queried + " err=" + Marshal.GetLastWin32Error() +
      " returned=" + returned + " flags=0x" +
      readBack.BasicInformation.LimitFlags.ToString("X") + "; ");

    var basic = new BasicLimits();
    basic.LimitFlags = KillOnJobClose;
    bool okBasic = SetInformationBasic(job, JobObjectBasicLimitInformation, ref basic,
      Marshal.SizeOf(typeof(BasicLimits)));
    log.Append("setBasicKill=" + okBasic + " err=" + Marshal.GetLastWin32Error());

    CloseHandle(job);
    return log.ToString();
  }
}
'@
[JobTry]::Report()
