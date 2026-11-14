# BUG-27 forensics: how long after CreateProcess does MSYS bash create its first grandchild?
# This decides whether a warm keeper can assign a job object before the first fork.
$ErrorActionPreference = 'Stop'
$bash = 'C:\Program Files\Git\bin\bash.exe'

function Get-SleepPids {
  (Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" | ForEach-Object { $_.ProcessId })
}

$baseline = @(Get-SleepPids)
Write-Output ("baseline sleep pids: " + ($baseline -join ','))

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $bash
$psi.Arguments = '--noprofile --norc -c "sleep 90 && echo late"'
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true
$psi.WorkingDirectory = (Get-Location).Path

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = [System.Diagnostics.Process]::Start($psi)
$rootPid = $p.Id
Write-Output ("root pid=$rootPid")

$found = -1
$sleepPid = 0
for ($i = 0; $i -lt 5000; $i++) {
  $now = @(Get-SleepPids)
  $new = @($now | Where-Object { $baseline -notcontains $_ })
  if ($new.Count -gt 0) {
    $sw.Stop()
    $found = $sw.ElapsedMilliseconds
    $sleepPid = $new[0]
    break
  }
  Start-Sleep -Milliseconds 1
}
if ($found -lt 0) { Write-Output "no grandchild seen within 5000ms" } else {
  Write-Output ("grandchild sleep pid=$sleepPid appeared " + $found + "ms after Process.Start")
  $info = Get-CimInstance Win32_Process -Filter "ProcessId=$sleepPid"
  Write-Output ("  its ppid=" + $info.ParentProcessId + " cmd=" + $info.CommandLine)
  $live = @(Get-SleepPids)
  Write-Output ("  live sleeps now: " + ($live -join ','))
}

# How long does bash take to reach a trivial exit? A proxy for "when could it fork at all".
$psiTrue = New-Object System.Diagnostics.ProcessStartInfo
$psiTrue.FileName = $bash
$psiTrue.Arguments = '--noprofile --norc -c "true"'
$psiTrue.UseShellExecute = $false
$psiTrue.CreateNoWindow = $true
$psiTrue.WorkingDirectory = (Get-Location).Path
$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
$p2 = [System.Diagnostics.Process]::Start($psiTrue)
$p2.WaitForExit()
$sw2.Stop()
Write-Output ("bash -c true ran " + $sw2.ElapsedMilliseconds + "ms")

Write-Output "--- cold powershell Add-Type cost (the keeper's startup path) ---"
$sw3 = [System.Diagnostics.Stopwatch]::StartNew()
$null = & powershell.exe -NoProfile -NonInteractive -Command "Add-Type -TypeDefinition 'using System; public static class Probe { public static int Zero() { return 0; } }'; [Probe]::Zero()"
$sw3.Stop()
Write-Output ("cold Add-Type powershell exit=" + $LASTEXITCODE + " took " + $sw3.ElapsedMilliseconds + "ms")

Write-Output "--- warm powershell startup (no Add-Type) ---"
$sw4 = [System.Diagnostics.Stopwatch]::StartNew()
$null = & powershell.exe -NoProfile -NonInteractive -Command "exit 0"
$sw4.Stop()
Write-Output ("warm powershell took " + $sw4.ElapsedMilliseconds + "ms")

# Clean up whatever this probe started.
taskkill /PID $rootPid /T /F 2>&1 | Out-Null
$left = @(Get-SleepPids | Where-Object { $baseline -notcontains $_ })
Write-Output ("sleeps left after taskkill /T on the root: " + ($left -join ','))
foreach ($lp in $left) { taskkill /PID $lp /F 2>&1 | Out-Null }
