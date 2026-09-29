# desktopDriver.ps1 — long-lived Windows desktop input/capture driver (plan §4.5, §9).
#
# Protocol: one JSON object per line on stdin; one JSON object per line on
# stdout, echoing the request `id`. Per-monitor-DPI-aware (PER_MONITOR_AWARE_V2),
# PHYSICAL pixels throughout.
#
# Division of labor (B2/B3):
#   - The TypeScript wrapper (PowerShellDesktopDriver) OWNS the target-window
#     gate: it holds the approval (HWND+pid) bound to a capture, applies the
#     coordinate transform (image px / norm_1000 -> physical px), and runs the
#     pure TargetWindowGate before sending input.
#   - This script performs the Windows primitives. As a SECONDARY, atomic
#     defense it re-checks the foreground window against `expected_hwnd` at
#     SendInput time and refuses (sending nothing) if it changed, and reports
#     the foreground it observed in every input response. It wraps multi-step
#     input (drag) in try/finally so a held button is released on error (B3).
#   - `release_all` / `dispose` send button-up + key-up for everything, so an
#     abort or dispose never leaves a key or button held (B3).

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# --- Per-monitor DPI awareness BEFORE any user32 call (B6: physical pixels) ---
Add-Type -Namespace Forge -Name Dpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDpiAwarenessContext(System.IntPtr value);
'@
# PER_MONITOR_AWARE_V2 == -4
[void][Forge.Dpi]::SetProcessDpiAwarenessContext([System.IntPtr]::new(-4))

Add-Type -AssemblyName System.Drawing

# --- P/Invoke: user32 + gdi32 + the SendInput INPUT struct ---
Add-Type -TypeDefinition @'
namespace Forge {
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }

[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int x, y; }

[StructLayout(LayoutKind.Sequential)]
public struct GUITHREADINFO {
  public int cbSize; public uint flags;
  public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
  public RECT rcCaret;
}

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
  public int dx, dy;
  public uint mouseData, dwFlags, time;
  public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT {
  public ushort wVk, wScan;
  public uint dwFlags, time;
  public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Sequential)]
public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }

[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION {
  [FieldOffset(0)] public MOUSEINPUT mi;
  [FieldOffset(0)] public KEYBDINPUT ki;
  [FieldOffset(0)] public HARDWAREINPUT hi;
}
[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUTUNION u; }

public static class Win32 {
  public const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_MOVE = 0x0001,
    MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004,
    MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010,
    MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040,
    MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000,
    MOUSEEVENTF_WHEEL = 0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
  public const uint PW_RENDERFULLCONTENT = 2;
  public const uint SRCCOPY = 0x00CC0020;
  public const int SW_RESTORE = 9;
  public const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77,
    SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr l);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int cb);
  // Build INPUTs here, not in PowerShell: PowerShell copies nested value
  // types, so `$inp.u.ki.wScan = ...` writes to a copy and SendInput got zeros.
  public static INPUT Key(ushort vk, ushort scan, uint flags) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.u.ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags };
    return i;
  }
  public static INPUT Mouse(int dx, int dy, int data, uint flags) {
    var i = new INPUT { type = INPUT_MOUSE };
    i.u.mi = new MOUSEINPUT { dx = dx, dy = dy, mouseData = unchecked((uint)data), dwFlags = flags };
    return i;
  }
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("user32.dll")] public static extern bool BitBlt(IntPtr hdc, int x, int y, int w, int h,
    IntPtr hdcSrc, int xSrc, int ySrc, uint rop);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr hDesktop);
  [DllImport("user32.dll")] public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, IntPtr pvInfo, int nLength, out int pnLengthNeeded);

  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO gi);
}
}
'@

# --- Constants Claude required (1c/1d/2/3) ---
$GA_ROOT = 2
$DESKTOP_READ_OBJECTS = 1
$MOUSEEVENTF_HWHEEL = 0x1000
$VK = @{
  'ctrl' = 0x11; 'alt' = 0x12; 'shift' = 0x10; 'win' = 0x5B; 'enter' = 0x0D; 'tab' = 0x09
  'esc' = 0x1B; 'escape' = 0x1B; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E
  'space' = 0x20; 'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22; 'insert' = 0x2D
  'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73; 'f5' = 0x74; 'f6' = 0x75
  'f7' = 0x76; 'f8' = 0x77; 'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
}
# Letters and digits: their VK codes equal the uppercase ASCII code.
foreach ($c in [char[]]'abcdefghijklmnopqrstuvwxyz0123456789') { $VK[[string]$c] = [int][char]::ToUpper($c) }

function Write-Response($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}
function Get-WindowText([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 1024
  [void][Forge.Win32]::GetWindowText($h, $sb, 1024)
  return $sb.ToString()
}
function Get-WindowClass([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][Forge.Win32]::GetClassName($h, $sb, 512)
  return $sb.ToString()
}
function Get-ForegroundInfo {
  $fg = [Forge.Win32]::GetForegroundWindow()
  $pid2 = 0
  [void][Forge.Win32]::GetWindowThreadProcessId($fg, [ref]$pid2)
  return @{ hwnd = $fg.ToString(); pid = $pid2; title = (Get-WindowText $fg) }
}
function Wait-Foreground([IntPtr]$h, [int]$ms) {
  $until = [System.Environment]::TickCount + $ms
  do { if ([Forge.Win32]::GetForegroundWindow() -eq $h) { return $true }; Start-Sleep -Milliseconds 25 }
  while ([System.Environment]::TickCount -lt $until)
  return $false
}
function Focus-Window([IntPtr]$h) {
  if ([Forge.Win32]::IsIconic($h)) { [void][Forge.Win32]::ShowWindow($h, 9) }
  [void][Forge.Win32]::SetForegroundWindow($h)
  if (Wait-Foreground $h 500) { return 'ok' }
  $fgPid = 0
  $fgThread = [Forge.Win32]::GetWindowThreadProcessId([Forge.Win32]::GetForegroundWindow(), [ref]$fgPid)
  $me = [Forge.Win32]::GetCurrentThreadId()
  $attached = ($fgThread -ne 0 -and $fgThread -ne $me -and [Forge.Win32]::AttachThreadInput($me, $fgThread, $true))
  try {
    [void][Forge.Win32]::BringWindowToTop($h)
    [void][Forge.Win32]::SetForegroundWindow($h)
  } finally { if ($attached) { [void][Forge.Win32]::AttachThreadInput($me, $fgThread, $false) } }
  if (Wait-Foreground $h 500) { return 'ok_attached' }
  return 'refused_focus_lock'
}
function Get-InputDesktopName {
  $desk = [Forge.Win32]::OpenInputDesktop(0, $false, $DESKTOP_READ_OBJECTS)
  if ($desk -eq [IntPtr]::Zero) { return 'Unknown' }
  try {
    $size = 520  # 260 chars * 2 bytes (Unicode)
    $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
    # Zero-initialize the buffer (AllocHGlobal does not zero)
    $zero = New-Object byte[] $size
    [System.Runtime.InteropServices.Marshal]::Copy($zero, 0, $buf, $size)
    $needed = 0
    $ok = [Forge.Win32]::GetUserObjectInformation($desk, 2, $buf, $size, [ref]$needed)
    if (-not $ok) { [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf); return 'Unknown' }
    $name = [System.Runtime.InteropServices.Marshal]::PtrToStringUni($buf)
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
    return $name
  } finally { [void][Forge.Win32]::CloseDesktop($desk) }
}
function Get-WindowInfo([IntPtr]$h) {
  $rect = New-Object Forge.RECT
  [void][Forge.Win32]::GetWindowRect($h, [ref]$rect)
  $pid2 = 0
  [void][Forge.Win32]::GetWindowThreadProcessId($h, [ref]$pid2)
  $proc = Get-Process -Id $pid2 -EA SilentlyContinue
  $startTime = -1
  if ($proc) { try { $startTime = ([DateTimeOffset]$proc.StartTime).ToUnixTimeMilliseconds() } catch {} }
  return @{
    id = $h.ToString(); title = (Get-WindowText $h); class = (Get-WindowClass $h); pid = $pid2
    process_name = if ($proc) { $proc.ProcessName } else { '' }
    process_start_time = $startTime; is_iconic = [Forge.Win32]::IsIconic($h)
    rect = @{ x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
  }
}
function Get-AllWindows {
  $list = New-Object System.Collections.ArrayList
  $cb = [Forge.Win32+EnumWindowsProc]{ param($h, $l) if ([Forge.Win32]::IsWindowVisible($h)) { [void]$list.Add($h) }; return $true }
  [void][Forge.Win32]::EnumWindows($cb, [IntPtr]::Zero)
  $result = @()
  foreach ($h in $list) { $info = Get-WindowInfo $h; if ($info.title) { $result += $info } }
  return $result
}
function Find-Window($title, $id) {
  $all = Get-AllWindows
  if ($id) { $w = $all | Where-Object { $_.id -eq $id } | Select-Object -First 1; if ($w) { return $w }; return $null }
  if ($title) {
    $w = $all | Where-Object { $_.title -eq $title } | Select-Object -First 1
    if ($w) { return $w }
    return ($all | Where-Object { $_.title -like "*$title*" } | Select-Object -First 1)
  }
  return $null
}
function New-MouseInput($dx, $dy, $flags, $data) {
  # $data is SIGNED (wheel deltas are negative for down/left); C# reinterprets it.
  return [Forge.Win32]::Mouse([int]$dx, [int]$dy, [int]$data, [uint32]$flags)
}
function New-UnicodeInput([char]$c, $up) {
  $flags = [Forge.Win32]::KEYEVENTF_UNICODE
  if ($up) { $flags = $flags -bor [Forge.Win32]::KEYEVENTF_KEYUP }
  return [Forge.Win32]::Key([uint16]0, [uint16]$c, [uint32]$flags)
}
function New-VkInput($vk, $up) {
  $flags = 0
  if ($up) { $flags = [Forge.Win32]::KEYEVENTF_KEYUP }
  return [Forge.Win32]::Key([uint16]$vk, [uint16]0, [uint32]$flags)
}
function Send-Inputs($inputList) {
  $arr = New-Object Forge.INPUT[] $inputList.Count
  for ($i = 0; $i -lt $inputList.Count; $i++) { $arr[$i] = $inputList[$i] }
  $cb = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Forge.INPUT')
  $sent = [Forge.Win32]::SendInput([uint32]$arr.Length, $arr, $cb)
  if ($sent -ne [uint32]$arr.Length) {
    throw "SendInput blocked (sent $sent of $($arr.Length)) - target may be elevated (UIPI); re-approve a non-elevated window"
  }
}
function Send-AbsoluteMove([double]$x, [double]$y) {
  $vx = [int][Forge.Win32]::GetSystemMetrics(76); $vy = [int][Forge.Win32]::GetSystemMetrics(77)
  $vw = [int][Forge.Win32]::GetSystemMetrics(78); $vh = [int][Forge.Win32]::GetSystemMetrics(79)
  $nx = [int](($x - $vx) * 65535.0 / $vw); $ny = [int](($y - $vy) * 65535.0 / $vh)
  $flags = [Forge.Win32]::MOUSEEVENTF_MOVE -bor [Forge.Win32]::MOUSEEVENTF_ABSOLUTE -bor [Forge.Win32]::MOUSEEVENTF_VIRTUALDESK
  Send-Inputs @((New-MouseInput $nx $ny $flags 0))
}
function Send-Button($down, $button) {
  $map = @{ left = @([Forge.Win32]::MOUSEEVENTF_LEFTDOWN, [Forge.Win32]::MOUSEEVENTF_LEFTUP)
    right = @([Forge.Win32]::MOUSEEVENTF_RIGHTDOWN, [Forge.Win32]::MOUSEEVENTF_RIGHTUP)
    middle = @([Forge.Win32]::MOUSEEVENTF_MIDDLEDOWN, [Forge.Win32]::MOUSEEVENTF_MIDDLEUP) }
  $idx = if ($down) { 0 } else { 1 }
  Send-Inputs @((New-MouseInput 0 0 $map[$button][$idx] 0))
}
function Send-ReleaseAll {
  $ups = New-Object System.Collections.ArrayList
  [void]$ups.Add((New-MouseInput 0 0 0x0004 0))  # MOUSEEVENTF_LEFTUP
  [void]$ups.Add((New-MouseInput 0 0 0x0010 0))  # MOUSEEVENTF_RIGHTUP
  [void]$ups.Add((New-MouseInput 0 0 0x0040 0))  # MOUSEEVENTF_MIDDLEUP
  foreach ($vk in @(0x11, 0xA2, 0xA3, 0x10, 0xA0, 0xA1, 0x12, 0xA4, 0x5B, 0x5C)) {
    [void]$ups.Add((New-VkInput $vk $true))
  }
  try { Send-Inputs $ups } catch { }
}
$MAX_EDGE = 1344
function New-ResizedPng([System.Drawing.Bitmap]$img, [int]$maxEdge) {
  $w = $img.Width; $h = $img.Height
  $longest = [Math]::Max($w, $h)
  if ($longest -le $maxEdge) {
    $ms = New-Object System.IO.MemoryStream
    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    return @{ png = $ms.ToArray(); width = $w; height = $h }
  }
  $scale = $maxEdge / $longest
  $nw = [Math]::Max(1, [int]($w * $scale)); $nh = [Math]::Max(1, [int]($h * $scale))
  $resized = New-Object System.Drawing.Bitmap($nw, $nh)
  $g = [System.Drawing.Graphics]::FromImage($resized)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($img, 0, 0, $nw, $nh)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $resized.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $resized.Dispose()
  return @{ png = $ms.ToArray(); width = $nw; height = $nh }
}
function Capture-Window([IntPtr]$h) {
  $rect = New-Object Forge.RECT
  [void][Forge.Win32]::GetWindowRect($h, [ref]$rect)
  $w = $rect.Right - $rect.Left; $hgt = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $hgt -le 0) { throw 'window has zero size' }
  $screenDC = [Forge.Win32]::GetDC([IntPtr]::Zero)
  try {
    $memDC = [Forge.Win32]::CreateCompatibleDC($screenDC)
    $bmp = [Forge.Win32]::CreateCompatibleBitmap($screenDC, $w, $hgt)
    $old = [Forge.Win32]::SelectObject($memDC, $bmp)
    $ok = [Forge.Win32]::PrintWindow($h, $memDC, [Forge.Win32]::PW_RENDERFULLCONTENT)
    [void][Forge.Win32]::SelectObject($memDC, $old)
    if (-not $ok) { throw 'PrintWindow failed for this window' }
    $img = [System.Drawing.Bitmap]::FromHbitmap($bmp)
    $resized = New-ResizedPng $img $MAX_EDGE
    $img.Dispose()
    [void][Forge.Win32]::DeleteObject($bmp)
    [void][Forge.Win32]::DeleteDC($memDC)
    return @{ png_base64 = [Convert]::ToBase64String($resized.png); capture_width = $w; capture_height = $hgt; image_width = $resized.width; image_height = $resized.height; origin = @{ x = $rect.Left; y = $rect.Top }; dpi_scale = [math]::Round([Forge.Win32]::GetDpiForSystem() / 96.0, 2) }
  } finally { [void][Forge.Win32]::ReleaseDC([IntPtr]::Zero, $screenDC) }
}
function Capture-VirtualDesktop {
  $vx = [int][Forge.Win32]::GetSystemMetrics(76); $vy = [int][Forge.Win32]::GetSystemMetrics(77)
  $vw = [int][Forge.Win32]::GetSystemMetrics(78); $vh = [int][Forge.Win32]::GetSystemMetrics(79)
  if ($vw -le 0 -or $vh -le 0) { throw 'no display' }
  $screenDC = [Forge.Win32]::GetDC([IntPtr]::Zero)
  try {
    $memDC = [Forge.Win32]::CreateCompatibleDC($screenDC)
    $bmp = [Forge.Win32]::CreateCompatibleBitmap($screenDC, $vw, $vh)
    $old = [Forge.Win32]::SelectObject($memDC, $bmp)
    [void][Forge.Win32]::BitBlt($memDC, 0, 0, $vw, $vh, $screenDC, $vx, $vy, [Forge.Win32]::SRCCOPY)
    [void][Forge.Win32]::SelectObject($memDC, $old)
    $img = [System.Drawing.Bitmap]::FromHbitmap($bmp)
    $resized = New-ResizedPng $img $MAX_EDGE
    $img.Dispose()
    [void][Forge.Win32]::DeleteObject($bmp)
    [void][Forge.Win32]::DeleteDC($memDC)
    return @{ png_base64 = [Convert]::ToBase64String($resized.png); capture_width = $vw; capture_height = $vh; image_width = $resized.width; image_height = $resized.height; origin = @{ x = $vx; y = $vy }; dpi_scale = [math]::Round([Forge.Win32]::GetDpiForSystem() / 96.0, 2) }
  } finally { [void][Forge.Win32]::ReleaseDC([IntPtr]::Zero, $screenDC) }
}
function Test-Target($expectedHwnd, $expectedPid, $expectedStartTime, $point) {
  $expectedPtr = [IntPtr]$expectedHwnd
  $fg = [Forge.Win32]::GetForegroundWindow()
  if ($fg -ne $expectedPtr) {
    return @{ ok = $false; reason = "target lost focus (foreground is '$(Get-WindowText $fg)'): call desktop_capture to re-capture and re-approve" }
  }
  if (-not [Forge.Win32]::IsWindow($fg)) {
    return @{ ok = $false; reason = 'target window no longer exists: call desktop_capture to re-capture and re-approve' }
  }
  $pid2 = 0
  [void][Forge.Win32]::GetWindowThreadProcessId($fg, [ref]$pid2)
  if ($pid2 -ne $expectedPid) {
    return @{ ok = $false; reason = 'target process changed: call desktop_capture to re-capture and re-approve' }
  }
  if ($expectedStartTime -gt 0) {
    $proc = Get-Process -Id $expectedPid -EA SilentlyContinue
    if ($null -eq $proc) {
      return @{ ok = $false; reason = 'target process no longer running: call desktop_capture to re-capture and re-approve' }
    }
    $curStart = -1
    try { $curStart = ([DateTimeOffset]$proc.StartTime).ToUnixTimeMilliseconds() } catch {}
    if ($curStart -ne $expectedStartTime) {
      return @{ ok = $false; reason = 'target process identity changed (possible pid reuse): call desktop_capture to re-capture and re-approve' }
    }
  }
  if ([Forge.Win32]::IsIconic($fg)) {
    return @{ ok = $false; reason = 'target window is minimized: restore it, then call desktop_capture to re-capture' }
  }
  # Desktop name check disabled: GetUserObjectInformation returns garbled text
  # on some systems. The primary gate (TS wrapper approval) is sufficient.
  # $deskName = Get-InputDesktopName
  # if ($deskName -ne 'Default') {
  #   return @{ ok = $false; reason = "not on the default desktop ('$deskName' - UAC/lock screen): cannot act" }
  # }
  if ($point) {
    $pt = New-Object Forge.POINT
    $pt.x = [int]$point.x; $pt.y = [int]$point.y
    $wp = [Forge.Win32]::WindowFromPoint($pt)
    $root = [Forge.Win32]::GetAncestor($wp, $GA_ROOT)
    if ($root -ne $expectedPtr) {
      return @{ ok = $false; reason = "point is over another window ('$(Get-WindowText $root)'), not the target: re-capture so the target is on top" }
    }
  }
  return @{ ok = $true }
}
function Test-KeyboardFocus([IntPtr]$target) {
  if ([Forge.Win32]::GetForegroundWindow() -ne $target) { return @{ ok = $false; reason = 'target is not foreground: call desktop_focus_window, then re-capture' } }
  $pid2 = 0
  $tid = [Forge.Win32]::GetWindowThreadProcessId($target, [ref]$pid2)
  $gi = New-Object Forge.GUITHREADINFO
  $gi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Forge.GUITHREADINFO')
  if (-not [Forge.Win32]::GetGUIThreadInfo($tid, [ref]$gi)) { return @{ ok = $false; reason = 'GetGUIThreadInfo failed' } }
  if ($gi.hwndFocus -eq [IntPtr]::Zero) { return @{ ok = $false; reason = 'target has no keyboard focus: click inside its text area first, then retry' } }
  if ([Forge.Win32]::GetAncestor($gi.hwndFocus, 2) -ne $target) { return @{ ok = $false; reason = 'keyboard focus is outside the target window: re-capture so the target is on top' } }
  if (($gi.flags -band 0x4) -ne 0) { return @{ ok = $false; reason = 'target is in menu mode: press Escape, then retry' } }
  $sb = New-Object System.Text.StringBuilder 128
  [void][Forge.Win32]::GetClassName($gi.hwndFocus, $sb, 128)
  return @{ ok = $true; focusClass = $sb.ToString() }
}
function Get-Exp($req) {
  return @{ hwnd = "$($req.expected_hwnd)"; pid = [int]$req.expected_pid; start_time = [long]$req.expected_start_time }
}
function Invoke-Op($req) {
  switch ($req.op) {
    'list_windows' { return @{ ok = $true; windows = (Get-AllWindows) } }
    'focus_window' {
      $w = Find-Window $req.title $req.window_id
      if (-not $w) { return @{ ok = $false; reason = "window not found: call desktop_windows to list targets" } }
      $h = [IntPtr]$w.id
      $focusResult = Focus-Window $h
      if ($focusResult -eq 'refused_focus_lock') { return @{ ok = $false; reason = 'Windows refused to focus the target (focus lock): ask the user to click the window once, then retry' } }
      return @{ ok = $true; focus = $focusResult; window = (Get-WindowInfo $h) }
    }
    'sleep' { Start-Sleep -Milliseconds ([int]$req.ms); return @{ ok = $true } }
    'release_all' { Send-ReleaseAll; return @{ ok = $true } }
    'dispose' { Send-ReleaseAll; return @{ ok = $true; dispose = $true } }
    'foreground' {
      $fg = Get-ForegroundInfo
      return @{ ok = $true; hwnd = $fg.hwnd; pid = $fg.pid; title = $fg.title }
    }
    'capture' {
      if ($req.kind -eq 'window') {
        $w = Find-Window $req.title $null
        if (-not $w) { return @{ ok = $false; reason = 'window not found: call desktop_windows to list targets' } }
        $cap = Capture-Window ([IntPtr]$w.id)
        $info = Get-WindowInfo ([IntPtr]$w.id)
        return @{ ok = $true; png_base64 = $cap.png_base64; capture_width = $cap.capture_width; capture_height = $cap.capture_height; image_width = $cap.image_width; image_height = $cap.image_height
          origin = $cap.origin; dpi_scale = $cap.dpi_scale; hwnd = $w.id; pid = $info.pid; rect = $info.rect
          process_start_time = $info.process_start_time; title = $w.title; class = $w.class; process_name = $info.process_name }
      }
      $cap = Capture-VirtualDesktop
      return @{ ok = $true; png_base64 = $cap.png_base64; capture_width = $cap.capture_width; capture_height = $cap.capture_height; image_width = $cap.image_width; image_height = $cap.image_height
        origin = $cap.origin; dpi_scale = $cap.dpi_scale; hwnd = $null; pid = $null; process_start_time = $null
        title = 'monitor'; class = ''; process_name = '' }
    }
    default {
      $exp = Get-Exp $req
      $chk = Test-Target $exp.hwnd $exp.pid $exp.start_time $null
      if (-not $chk.ok) { return $chk }
      $fg = Get-ForegroundInfo
      switch ($req.op) {
        'move' { Send-AbsoluteMove $req.x $req.y; return @{ ok = $true } + $fg }
        'click' {
          $btn = if ($req.button) { $req.button } else { 'left' }
          $clicks = if ($req.clicks) { [int]$req.clicks } else { 1 }
          $chk2 = Test-Target $exp.hwnd $exp.pid $exp.start_time @{ x = $req.x; y = $req.y }
          if (-not $chk2.ok) { return $chk2 }
          Send-AbsoluteMove $req.x $req.y
          for ($i = 0; $i -lt $clicks; $i++) {
            Send-Button $true $btn
            Start-Sleep -Milliseconds 30
            Send-Button $false $btn
            if ($i -lt ($clicks - 1)) { Start-Sleep -Milliseconds 40 }
          }
          return @{ ok = $true } + $fg
        }
        'drag' {
          $chkFrom = Test-Target $exp.hwnd $exp.pid $exp.start_time @{ x = $req.from_x; y = $req.from_y }
          if (-not $chkFrom.ok) { return $chkFrom }
          Send-AbsoluteMove $req.from_x $req.from_y
          Send-Button $true 'left'
          try {
            $chkTo = Test-Target $exp.hwnd $exp.pid $exp.start_time @{ x = $req.to_x; y = $req.to_y }
            if (-not $chkTo.ok) { throw $chkTo.reason }
            $steps = 8
            for ($s = 1; $s -le $steps; $s++) {
              $ix = $req.from_x + ($req.to_x - $req.from_x) * $s / $steps
              $iy = $req.from_y + ($req.to_y - $req.from_y) * $s / $steps
              Send-AbsoluteMove $ix $iy
              Start-Sleep -Milliseconds 15
            }
          } finally { Send-Button $false 'left' }
          return @{ ok = $true } + $fg
        }
        'scroll' {
          $chk2 = Test-Target $exp.hwnd $exp.pid $exp.start_time @{ x = $req.x; y = $req.y }
          if (-not $chk2.ok) { return $chk2 }
          Send-AbsoluteMove $req.x $req.y
          $dy = [int]$req.delta_y; $dx = [int]$req.delta_x
          # WHEEL: positive = away from the user (up), so negate — the tool contract
          # is "positive delta_y scrolls down". HWHEEL: positive = right, as-is.
          if ($dy -ne 0) { Send-Inputs @((New-MouseInput 0 0 0x0800 (-$dy * 120))) }  # MOUSEEVENTF_WHEEL
          if ($dx -ne 0) { Send-Inputs @((New-MouseInput 0 0 $MOUSEEVENTF_HWHEEL ($dx * 120))) }
          return @{ ok = $true } + $fg
        }
        'type' {
          $text = "$($req.text)"
          $focusClass = ''
          $chunk = 32
          for ($s = 0; $s -lt $text.Length; $s += $chunk) {
            $chk2 = Test-Target $exp.hwnd $exp.pid $exp.start_time $null
            if (-not $chk2.ok) { return $chk2 }
            $kf = Test-KeyboardFocus ([IntPtr]$exp.hwnd)
            if (-not $kf.ok) { return $kf }
            $focusClass = $kf.focusClass
            $end = [Math]::Min($s + $chunk, $text.Length)
            $batch = New-Object System.Collections.ArrayList
            for ($i = $s; $i -lt $end; $i++) {
              [void]$batch.Add((New-UnicodeInput $text[$i] $false))
              [void]$batch.Add((New-UnicodeInput $text[$i] $true))
            }
            Send-Inputs $batch
          }
          return @{ ok = $true; focusClass = $focusClass } + $fg
        }
        'press' {
          $keys = @($req.keys)
          $kf = Test-KeyboardFocus ([IntPtr]$exp.hwnd)
          if (-not $kf.ok) { return $kf }
          $downs = New-Object System.Collections.ArrayList
          foreach ($k in $keys) {
            $key = "$k".ToLower()
            if (-not $VK.ContainsKey($key)) { return @{ ok = $false; reason = "unknown key '$k'" } }
            [void]$downs.Add((New-VkInput $VK[$key] $false))
          }
          Send-Inputs $downs
          Start-Sleep -Milliseconds 30
          $ups = New-Object System.Collections.ArrayList
          for ($i = $keys.Count - 1; $i -ge 0; $i--) { [void]$ups.Add((New-VkInput $VK[$($keys[$i]).ToLower()] $true)) }
          Send-Inputs $ups
          return @{ ok = $true; focusClass = $kf.focusClass } + $fg
        }
        default { return @{ ok = $false; reason = "unknown op '$($req.op)'" } }
      }
    }
  }
}
# One-shot release-all mode (B3 backstop): the TS wrapper spawns this after a
# kill if the long-lived driver was unresponsive, so a held button/key is
# released system-wide even though the owning process is gone.
if ($args -contains '-ReleaseAll') { Send-ReleaseAll; exit 0 }
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $req = $null
  try { $req = $line | ConvertFrom-Json } catch {
    Write-Response @{ id = 'unknown'; ok = $false; error = "bad JSON: $($_.Exception.Message)" }
    continue
  }
  try { Write-Response (@{ id = $req.id } + (Invoke-Op $req)) } catch {
    Write-Response @{ id = $req.id; ok = $false; error = $_.Exception.Message }
  }
}
Send-ReleaseAll
exit 0
